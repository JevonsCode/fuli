from datetime import datetime, timezone

from fastapi import HTTPException

from .models import (
    KnowledgeAgentReviewCreate,
    KnowledgeAgentViewCreate,
    KnowledgeAgentViewResult,
    KnowledgeAuditRecord,
    KnowledgeHumanChangeItem,
    KnowledgeHumanChangeSearchRequest,
    KnowledgeHumanChangeSearchResult,
)
from .provider_values import native_datetime, stable_uuid


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
        human_change_version=int(value['human_change_version']),
        reason=value['reason'],
        tool_name=value.get('tool_name'),
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
