import asyncio
import json
from datetime import datetime, timezone

from fastapi import HTTPException

from .knowledge_usage_models import (
    KnowledgeUsageCreate,
    KnowledgeUsageItemResult,
    KnowledgeUsageResult,
)
from .models import (
    KnowledgeAgentReviewCreate,
    KnowledgeAgentViewCreate,
    KnowledgeAgentViewResult,
    KnowledgeAuditRecord,
    KnowledgeHumanChangeItem,
    KnowledgeHumanChangeSearchRequest,
    KnowledgeHumanChangeSearchResult,
)
from .provider_values import json_object, native_datetime, stable_uuid


AGENT_CONFIRMATION_POLICY_VERSION = 'agent-usage-v1'
AGENT_CONFIRMATION_MIN_USES = 5
AGENT_CONFIRMATION_MIN_TASKS = 3
AGENT_CONFIRMATION_CONFIDENCE_CAP = 0.85
USAGE_WEIGHTS = {
    'cited': (0.12, 0.04),
    'applied': (0.18, 0.06),
}


async def record_human_change(
    store,
    actor: dict,
    space: dict,
    item_id: str,
    item_kind: str,
    *,
    reason: str,
    operation: str,
) -> None:
    changed_at = datetime.now(timezone.utc)
    audit_id = stable_uuid(
        space['id'],
        'knowledge-audit',
        item_kind,
        item_id,
        operation,
        changed_at.isoformat(),
        actor['id'],
    )
    records, _, _ = await store.runtime.driver.execute_query(
        _human_change_query(item_kind),
        space_id=space['id'],
        group_id=space['group_id'],
        item_id=item_id,
        item_kind=item_kind,
        audit_id=audit_id,
        reason=reason,
        operation=operation,
        created_by=actor['id'],
        changed_at=changed_at,
    )
    if not records:
        raise HTTPException(status_code=404, detail='knowledge item not found')


async def record_agent_views(
    store,
    actor: dict,
    request: KnowledgeAgentViewCreate,
) -> KnowledgeAgentViewResult:
    store._require_personal()
    space = await store.authorize(actor, request.personal_space_id, 'reader')
    if space['kind'] != 'personal':
        raise HTTPException(status_code=422, detail='Agent view audit is personal-only')

    recorded = []
    viewed_at = datetime.now(timezone.utc)
    seen = set()
    for item in request.items:
        key = (item.item_kind, item.item_id)
        if key in seen:
            continue
        seen.add(key)
        audit_id = stable_uuid(
            space['id'],
            'knowledge-audit',
            item.item_kind,
            item.item_id,
            'agent-view',
            request.tool_name,
            viewed_at.isoformat(),
            actor['id'],
        )
        records, _, _ = await store.runtime.driver.execute_query(
            _agent_view_query(item.item_kind),
            space_id=space['id'],
            group_id=space['group_id'],
            item_id=item.item_id,
            item_kind=item.item_kind,
            audit_id=audit_id,
            tool_name=request.tool_name,
            reason=f'Agent 通过 {request.tool_name} 查看了这条人工变更。',
            created_by=actor['id'],
            viewed_at=viewed_at,
        )
        if records:
            recorded.append(f'{item.item_kind}:{item.item_id}')
    return KnowledgeAgentViewResult(
        recorded_count=len(recorded),
        item_keys=recorded,
    )


async def record_knowledge_usage(
    store,
    actor: dict,
    request: KnowledgeUsageCreate,
) -> KnowledgeUsageResult:
    """Record material Agent use; retrieval and automatic preference injection do not call this."""
    store._require_personal()
    space = await store.authorize(actor, request.personal_space_id, 'maintainer')
    if space['kind'] != 'personal':
        raise HTTPException(status_code=422, detail='knowledge usage is personal-only')

    lock = store._group_locks.setdefault(space['group_id'], asyncio.Lock())
    results = []
    async with lock:
        for item in request.items:
            results.append(
                await _record_one_knowledge_use(
                    store,
                    actor,
                    space,
                    request,
                    item,
                )
            )
    return KnowledgeUsageResult(
        recorded_count=sum(result.recorded for result in results),
        duplicate_count=sum(not result.recorded for result in results),
        promoted_count=sum(result.promoted for result in results),
        items=results,
    )


async def _record_one_knowledge_use(store, actor, space, request, item):
    state = await _read_usage_state(
        store,
        space,
        item.item_id,
        item.item_kind,
    )
    if state is None:
        raise HTTPException(status_code=404, detail='knowledge item not found')
    if state.get('invalid_at') is not None:
        raise HTTPException(
            status_code=409,
            detail='historical knowledge cannot receive usage evidence',
        )

    generation = int(state.get('usage_generation') or 1)
    used_at = datetime.now(timezone.utc)
    audit_id = stable_uuid(
        space['id'],
        'knowledge-usage',
        item.item_kind,
        item.item_id,
        str(generation),
        request.task_id,
        item.use_kind,
    )
    records, _, _ = await store.runtime.driver.execute_query(
        _knowledge_use_query(item.item_kind),
        space_id=space['id'],
        group_id=space['group_id'],
        item_id=item.item_id,
        item_kind=item.item_kind,
        audit_id=audit_id,
        task_id=request.task_id,
        session_id=request.session_id,
        use_kind=item.use_kind,
        usage_generation=generation,
        reason=(
            f'Agent materially {item.use_kind} this knowledge in task '
            f'{request.task_id}.'
        ),
        tool_name=request.tool_name,
        created_by=actor['id'],
        used_at=used_at,
    )
    recorded = bool(records and records[0].get('recorded'))

    aggregates, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (:FuliSpace {id: $space_id, kind: 'personal'})-
              [:HAS_KNOWLEDGE_AUDIT]->(audit:FuliKnowledgeAudit {
                item_id: $item_id,
                item_kind: $item_kind,
                action: 'knowledge_used',
                usage_generation: $usage_generation
              })
        RETURN count(audit) AS qualified_use_count,
               count(DISTINCT audit.task_id) AS distinct_task_count,
               sum(CASE audit.use_kind WHEN 'applied' THEN 1 ELSE 0 END)
                 AS applied_count,
               sum(CASE audit.use_kind WHEN 'cited' THEN 1 ELSE 0 END)
                 AS cited_count,
               max(audit.created_at) AS last_used_at
        ''',
        space_id=space['id'],
        item_id=item.item_id,
        item_kind=item.item_kind,
        usage_generation=generation,
        routing_='r',
    )
    aggregate = dict(aggregates[0]) if aggregates else {}
    qualified_use_count = int(aggregate.get('qualified_use_count') or 0)
    distinct_task_count = int(aggregate.get('distinct_task_count') or 0)
    cited_count = int(aggregate.get('cited_count') or 0)
    applied_count = int(aggregate.get('applied_count') or 0)
    utility_score = min(
        1.0,
        cited_count * USAGE_WEIGHTS['cited'][0]
        + applied_count * USAGE_WEIGHTS['applied'][0],
    )
    previous_status = state.get('confirmation_status') or 'pending'
    if previous_status == 'confirmed':
        confidence_score = 1.0
    else:
        confidence_score = min(
            AGENT_CONFIRMATION_CONFIDENCE_CAP,
            0.5
            + cited_count * USAGE_WEIGHTS['cited'][1]
            + applied_count * USAGE_WEIGHTS['applied'][1],
        )
    promoted = (
        previous_status == 'pending'
        and not state.get('has_open_conflict')
        and qualified_use_count >= AGENT_CONFIRMATION_MIN_USES
        and distinct_task_count >= AGENT_CONFIRMATION_MIN_TASKS
    )
    confirmation_status = (
        'agent_confirmed' if promoted else previous_status
    )
    basis = json_object(state.get('confirmation_basis_json'))
    if promoted:
        basis = _agent_confirmation_basis(basis, used_at)

    updated, _, _ = await store.runtime.driver.execute_query(
        _usage_score_update_query(item.item_kind),
        group_id=space['group_id'],
        item_id=item.item_id,
        usage_generation=generation,
        utility_score=round(utility_score, 4),
        confidence_score=round(confidence_score, 4),
        qualified_use_count=qualified_use_count,
        distinct_task_count=distinct_task_count,
        last_used_at=native_datetime(aggregate.get('last_used_at')) or used_at,
        confirmation_status=confirmation_status,
        confirmation_basis_json=(
            json.dumps(basis, ensure_ascii=False, sort_keys=True)
            if basis else None
        ),
        promoted=promoted,
        audit_id=audit_id,
    )
    if not updated:
        raise HTTPException(
            status_code=409,
            detail='knowledge changed while usage evidence was recorded; retry',
        )
    return KnowledgeUsageItemResult(
        item_id=item.item_id,
        item_kind=item.item_kind,
        recorded=recorded,
        promoted=promoted,
        confirmation_status=confirmation_status,
        utility_score=round(utility_score, 4),
        confidence_score=round(confidence_score, 4),
        qualified_use_count=qualified_use_count,
        distinct_task_count=distinct_task_count,
        usage_generation=generation,
    )


async def review_human_change(
    store,
    actor: dict,
    item_id: str,
    request: KnowledgeAgentReviewCreate,
) -> KnowledgeAuditRecord:
    store._require_personal()
    space = await store.authorize(actor, request.personal_space_id, 'maintainer')
    if space['kind'] != 'personal':
        raise HTTPException(status_code=422, detail='Agent review is personal-only')

    state = await _read_human_change_state(
        store,
        space,
        item_id,
        request.item_kind,
    )
    if state is None or not state.get('human_edited'):
        raise HTTPException(status_code=404, detail='human-edited knowledge item not found')
    version = int(state.get('human_change_version') or 0)
    if version != request.human_change_version:
        raise HTTPException(
            status_code=409,
            detail='human change version is stale; read the item again before reviewing',
        )
    if state.get('human_change_status') == 'unseen':
        raise HTTPException(
            status_code=409,
            detail='Agent must read the current human change before reviewing it',
        )

    reviewed = (
        request.conflict_check == 'no_conflict'
        and request.classification_check == 'reasonable'
    )
    outcome = 'reviewed' if reviewed else 'requires_attention'
    next_status = 'reviewed' if reviewed else 'viewed'
    reviewed_at = datetime.now(timezone.utc)
    audit_id = stable_uuid(
        space['id'],
        'knowledge-audit',
        request.item_kind,
        item_id,
        'agent-review',
        str(version),
        reviewed_at.isoformat(),
        actor['id'],
    )
    records, _, _ = await store.runtime.driver.execute_query(
        _agent_review_query(request.item_kind),
        space_id=space['id'],
        group_id=space['group_id'],
        item_id=item_id,
        item_kind=request.item_kind,
        audit_id=audit_id,
        human_change_version=version,
        conflict_check=request.conflict_check,
        classification_check=request.classification_check,
        outcome=outcome,
        next_status=next_status,
        reason=request.note,
        created_by=actor['id'],
        reviewed_at=reviewed_at,
    )
    if not records:
        raise HTTPException(
            status_code=409,
            detail='human change moved while it was being reviewed; read it again',
        )
    return _audit_record(dict(records[0]['audit']))


async def search_human_changes(
    store,
    actor: dict,
    request: KnowledgeHumanChangeSearchRequest,
) -> KnowledgeHumanChangeSearchResult:
    store._require_personal()
    space = await store.authorize(actor, request.personal_space_id, 'reader')
    if space['kind'] != 'personal':
        raise HTTPException(status_code=422, detail='human change search is personal-only')

    needle = request.query.casefold().strip()
    common = {
        'space_id': space['id'],
        'group_id': space['group_id'],
        'status': request.status,
        'search_query': needle,
        'limit': request.limit,
        'routing_': 'r',
    }
    entity_records, _, _ = await store.runtime.driver.execute_query(
        _HUMAN_ENTITY_SEARCH,
        **common,
    )
    relationship_records, _, _ = await store.runtime.driver.execute_query(
        _HUMAN_RELATIONSHIP_SEARCH,
        **common,
    )
    values = [
        {**dict(record), 'item_kind': 'entity'}
        for record in entity_records
    ] + [
        {**dict(record), 'item_kind': 'relationship'}
        for record in relationship_records
    ]
    values.sort(
        key=lambda value: native_datetime(value['last_human_changed_at']),
        reverse=True,
    )
    values = values[: request.limit]
    audits = await read_knowledge_audits(
        store,
        space['id'],
        [value['item_id'] for value in values],
    )
    return KnowledgeHumanChangeSearchResult(items=[
        KnowledgeHumanChangeItem(
            **{
                **value,
                'last_human_changed_at': native_datetime(
                    value['last_human_changed_at']
                ),
                'last_agent_viewed_at': native_datetime(
                    value.get('last_agent_viewed_at')
                ),
                'last_agent_reviewed_at': native_datetime(
                    value.get('last_agent_reviewed_at')
                ),
                'audit_events': audits.get(value['item_id'], []),
            }
        )
        for value in values
    ])


async def read_knowledge_audits(
    store,
    space_id: str,
    item_ids: list[str],
) -> dict[str, list[KnowledgeAuditRecord]]:
    if not item_ids:
        return {}
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (:FuliSpace {id: $space_id, kind: 'personal'})-
              [:HAS_KNOWLEDGE_AUDIT]->(audit:FuliKnowledgeAudit)
        WHERE audit.item_id IN $item_ids
        RETURN audit ORDER BY audit.created_at DESC
        ''',
        space_id=space_id,
        item_ids=item_ids,
        routing_='r',
    )
    result = {}
    for record in records:
        value = _audit_record(dict(record['audit']))
        result.setdefault(value.item_id, []).append(value)
    return result


async def _read_human_change_state(store, space, item_id, item_kind):
    records, _, _ = await store.runtime.driver.execute_query(
        _state_query(item_kind),
        group_id=space['group_id'],
        item_id=item_id,
        routing_='r',
    )
    return dict(records[0]) if records else None


def _audit_record(value: dict) -> KnowledgeAuditRecord:
    return KnowledgeAuditRecord(
        id=value['id'],
        item_id=value['item_id'],
        item_kind=value['item_kind'],
        action=value['action'],
        human_change_version=int(value.get('human_change_version') or 0),
        reason=value['reason'],
        tool_name=value.get('tool_name'),
        task_id=value.get('task_id'),
        session_id=value.get('session_id'),
        use_kind=value.get('use_kind'),
        usage_generation=(
            int(value['usage_generation'])
            if value.get('usage_generation') is not None else None
        ),
        conflict_check=value.get('conflict_check'),
        classification_check=value.get('classification_check'),
        outcome=value.get('outcome'),
        created_at=native_datetime(value['created_at']),
    )


def _item_match(item_kind: str) -> str:
    if item_kind == 'entity':
        return 'MATCH (item:Entity {uuid: $item_id, group_id: $group_id})'
    return 'MATCH ()-[item:RELATES_TO {uuid: $item_id, group_id: $group_id}]->()'


def _human_change_query(item_kind: str) -> str:
    return f'''
        MATCH (space:FuliSpace {{id: $space_id, kind: 'personal'}})
        {_item_match(item_kind)}
        SET item.fuli_human_edited = true,
            item.fuli_human_change_version =
              coalesce(item.fuli_human_change_version, 0) + 1,
            item.fuli_human_change_status = 'unseen',
            item.fuli_last_human_changed_at = $changed_at,
            item.fuli_last_agent_viewed_at = NULL,
            item.fuli_last_agent_reviewed_at = NULL
        CREATE (audit:FuliKnowledgeAudit {{
          id: $audit_id,
          space_id: $space_id,
          item_id: $item_id,
          item_kind: $item_kind,
          action: 'human_change',
          human_change_version: item.fuli_human_change_version,
          reason: $reason,
          operation: $operation,
          outcome: 'pending_review',
          created_by: $created_by,
          created_at: $changed_at
        }})
        MERGE (space)-[:HAS_KNOWLEDGE_AUDIT]->(audit)
        RETURN item.fuli_human_change_version AS human_change_version
    '''


def _agent_view_query(item_kind: str) -> str:
    return f'''
        MATCH (space:FuliSpace {{id: $space_id, kind: 'personal'}})
        {_item_match(item_kind)}
        WHERE item.fuli_human_edited = true
        SET item.fuli_human_change_status =
              CASE WHEN item.fuli_human_change_status = 'reviewed'
                   THEN 'reviewed' ELSE 'viewed' END,
            item.fuli_last_agent_viewed_at = $viewed_at
        CREATE (audit:FuliKnowledgeAudit {{
          id: $audit_id,
          space_id: $space_id,
          item_id: $item_id,
          item_kind: $item_kind,
          action: 'agent_view',
          human_change_version: item.fuli_human_change_version,
          reason: $reason,
          tool_name: $tool_name,
          outcome: CASE WHEN item.fuli_human_change_status = 'reviewed'
                        THEN 'reviewed' ELSE 'pending_review' END,
          created_by: $created_by,
          created_at: $viewed_at
        }})
        MERGE (space)-[:HAS_KNOWLEDGE_AUDIT]->(audit)
        RETURN audit.id AS audit_id
    '''


def _agent_review_query(item_kind: str) -> str:
    return f'''
        MATCH (space:FuliSpace {{id: $space_id, kind: 'personal'}})
        {_item_match(item_kind)}
        WHERE item.fuli_human_edited = true
          AND item.fuli_human_change_version = $human_change_version
          AND item.fuli_human_change_status IN ['viewed', 'reviewed']
        SET item.fuli_human_change_status = $next_status,
            item.fuli_last_agent_reviewed_at = $reviewed_at
        CREATE (audit:FuliKnowledgeAudit {{
          id: $audit_id,
          space_id: $space_id,
          item_id: $item_id,
          item_kind: $item_kind,
          action: 'agent_review',
          human_change_version: $human_change_version,
          reason: $reason,
          conflict_check: $conflict_check,
          classification_check: $classification_check,
          outcome: $outcome,
          created_by: $created_by,
          created_at: $reviewed_at
        }})
        MERGE (space)-[:HAS_KNOWLEDGE_AUDIT]->(audit)
        RETURN audit
    '''


def _state_query(item_kind: str) -> str:
    return f'''
        {_item_match(item_kind)}
        RETURN coalesce(item.fuli_human_edited, false) AS human_edited,
               coalesce(item.fuli_human_change_version, 0)
                 AS human_change_version,
               coalesce(item.fuli_human_change_status, 'none')
                 AS human_change_status
    '''


async def _read_usage_state(store, space, item_id, item_kind):
    records, _, _ = await store.runtime.driver.execute_query(
        f'''
        MATCH (space:FuliSpace {{id: $space_id, kind: 'personal'}})
        {_item_match(item_kind)}
        RETURN coalesce(item.fuli_confirmation_status, 'pending')
                 AS confirmation_status,
               item.fuli_confirmation_basis_json AS confirmation_basis_json,
               coalesce(item.fuli_usage_generation, 1) AS usage_generation,
               {
                 "item.fuli_invalid_at"
                 if item_kind == "entity" else "item.invalid_at"
               } AS invalid_at,
               (
                 EXISTS {{
                   MATCH (space)-[:HAS_KNOWLEDGE_CONFLICT]->
                         (knowledge_conflict:FuliKnowledgeConflict)
                   WHERE knowledge_conflict.status = 'pending'
                     AND (
                       knowledge_conflict.item_id = $item_id
                       OR knowledge_conflict.target_item_id = $item_id
                     )
                 }}
                 OR EXISTS {{
                   MATCH (space)-[:HAS_PREFERENCE_CONFLICT]->
                         (preference_conflict:FuliPreferenceConflict)
                   WHERE preference_conflict.status = 'ai_pending'
                     AND (
                       preference_conflict.left_item_id = $item_id
                       OR preference_conflict.right_item_id = $item_id
                     )
                 }}
               ) AS has_open_conflict
        ''',
        space_id=space['id'],
        group_id=space['group_id'],
        item_id=item_id,
        routing_='r',
    )
    return dict(records[0]) if records else None


def _knowledge_use_query(item_kind: str) -> str:
    return f'''
        MATCH (space:FuliSpace {{id: $space_id, kind: 'personal'}})
        {_item_match(item_kind)}
        WHERE coalesce(item.fuli_usage_generation, 1) = $usage_generation
        MERGE (audit:FuliKnowledgeAudit {{id: $audit_id}})
        ON CREATE SET audit.space_id = $space_id,
                      audit.item_id = $item_id,
                      audit.item_kind = $item_kind,
                      audit.action = 'knowledge_used',
                      audit.human_change_version = 0,
                      audit.task_id = $task_id,
                      audit.session_id = $session_id,
                      audit.use_kind = $use_kind,
                      audit.usage_generation = $usage_generation,
                      audit.reason = $reason,
                      audit.tool_name = $tool_name,
                      audit.created_by = $created_by,
                      audit.created_at = $used_at
        MERGE (space)-[:HAS_KNOWLEDGE_AUDIT]->(audit)
        RETURN audit.created_at = $used_at AS recorded
    '''


def _usage_score_update_query(item_kind: str) -> str:
    return f'''
        {_item_match(item_kind)}
        WHERE coalesce(item.fuli_usage_generation, 1) = $usage_generation
        SET item.fuli_utility_score = $utility_score,
            item.fuli_confidence_score = $confidence_score,
            item.fuli_qualified_use_count = $qualified_use_count,
            item.fuli_distinct_task_count = $distinct_task_count,
            item.fuli_last_used_at = $last_used_at,
            item.fuli_confirmation_status = $confirmation_status,
            item.fuli_confirmation_basis_json = $confirmation_basis_json,
            item.fuli_epistemic_status =
              CASE WHEN $confirmation_status = 'confirmed' THEN 'confirmed'
                   WHEN item.fuli_origin_quadrant = 'unknown_unknown'
                     THEN 'exploratory'
                   ELSE 'observed' END
        WITH item
        OPTIONAL MATCH (audit:FuliKnowledgeAudit {{id: $audit_id}})
        FOREACH (_ IN CASE WHEN $promoted AND audit IS NOT NULL THEN [1] ELSE [] END |
          SET audit.outcome = 'agent_confirmed',
              audit.promotion = true
        )
        RETURN item.fuli_confirmation_status AS confirmation_status
    '''


def _agent_confirmation_basis(value: dict, confirmed_at: datetime) -> dict:
    return {
        'existence_reason': value.get(
            'existence_reason',
            'The knowledge was retained from an earlier Agent proposal.',
        ),
        'quadrant_reason': value.get(
            'quadrant_reason',
            'The discovery quadrant remains the immutable capture-time label.',
        ),
        'proposed_by': value.get(
            'proposed_by',
            {'kind': 'agent', 'label': 'Fuli'},
        ),
        'confirmed_by': {
            'kind': 'agent',
            'label': 'Fuli usage evidence policy',
        },
        'confirmed_at': confirmed_at.isoformat(),
        'agent_policy_version': AGENT_CONFIRMATION_POLICY_VERSION,
    }


_HUMAN_ENTITY_SEARCH = '''
MATCH (item:Entity {group_id: $group_id})
WHERE item.fuli_human_edited = true
  AND (
    $status IN ['all', 'human_changed']
    OR item.fuli_human_change_status = $status
  )
  AND (
    $search_query = ''
    OR toLower(item.name) CONTAINS $search_query
    OR toLower(coalesce(item.summary, '')) CONTAINS $search_query
    OR toLower(coalesce(item.fuli_type, 'Entity')) CONTAINS $search_query
    OR EXISTS {
      MATCH (audit:FuliKnowledgeAudit {
        space_id: $space_id,
        item_id: item.uuid
      })
      WHERE toLower(coalesce(audit.reason, '')) CONTAINS $search_query
    }
  )
RETURN item.uuid AS item_id,
       item.name AS title,
       coalesce(item.summary, '') AS body,
       coalesce(item.fuli_type, 'Entity') AS type,
       item.fuli_human_change_status AS human_change_status,
       item.fuli_human_change_version AS human_change_version,
       item.fuli_last_human_changed_at AS last_human_changed_at,
       item.fuli_last_agent_viewed_at AS last_agent_viewed_at,
       item.fuli_last_agent_reviewed_at AS last_agent_reviewed_at
ORDER BY item.fuli_last_human_changed_at DESC
LIMIT $limit
'''


_HUMAN_RELATIONSHIP_SEARCH = '''
MATCH ()-[item:RELATES_TO {group_id: $group_id}]->()
WHERE item.fuli_human_edited = true
  AND (
    $status IN ['all', 'human_changed']
    OR item.fuli_human_change_status = $status
  )
  AND (
    $search_query = ''
    OR toLower(item.name) CONTAINS $search_query
    OR toLower(coalesce(item.fact, '')) CONTAINS $search_query
    OR EXISTS {
      MATCH (audit:FuliKnowledgeAudit {
        space_id: $space_id,
        item_id: item.uuid
      })
      WHERE toLower(coalesce(audit.reason, '')) CONTAINS $search_query
    }
  )
RETURN item.uuid AS item_id,
       item.name AS title,
       coalesce(item.fact, '') AS body,
       item.name AS type,
       item.fuli_human_change_status AS human_change_status,
       item.fuli_human_change_version AS human_change_version,
       item.fuli_last_human_changed_at AS last_human_changed_at,
       item.fuli_last_agent_viewed_at AS last_agent_viewed_at,
       item.fuli_last_agent_reviewed_at AS last_agent_reviewed_at
ORDER BY item.fuli_last_human_changed_at DESC
LIMIT $limit
'''
