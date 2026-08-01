from datetime import datetime, timezone
from typing import Any

from fastapi import HTTPException

from .knowledge_review_models import (
    KnowledgeReviewCandidate,
    KnowledgeReviewCandidatePage,
    KnowledgeReviewCandidateRequest,
    KnowledgeReviewDecision,
    KnowledgeReviewFinish,
    KnowledgeReviewProgress,
    KnowledgeReviewRun,
    KnowledgeReviewStart,
)
from .personal_project_access import authorize_personal_project
from .provider_values import native_datetime, stable_uuid

# These are Provider ranking conventions, not product requirements. Keeping them
# here gives every Agent the same deterministic policy and makes tuning explicit.
LOW_UTILITY_SCORE = 0.25
LOW_CONFIDENCE_SCORE = 0.55
REPEATED_SESSION_COUNT = 3


async def start_knowledge_review(
    store,
    actor: dict,
    request: KnowledgeReviewStart,
    *,
    started_at: datetime | None = None,
) -> KnowledgeReviewRun:
    store._require_personal()
    space = await _personal_space(store, actor, request.personal_space_id, 'maintainer')
    if request.personal_project_id:
        await authorize_personal_project(
            store, actor, space, request.personal_project_id
        )
    scope_key = _scope_key(request.scope, request.personal_project_id)
    changed_at = started_at or datetime.now(timezone.utc)
    active_records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (:FuliSpace {id: $space_id, kind: 'personal'})-
              [:HAS_KNOWLEDGE_REVIEW]->(run:FuliKnowledgeReviewRun {
                scope_key: $scope_key
              })
        WHERE run.status IN ['active', 'paused']
        RETURN run ORDER BY run.updated_at DESC LIMIT 1
        ''',
        space_id=space['id'],
        scope_key=scope_key,
        routing_='r',
    )
    if active_records:
        run_value = dict(active_records[0]['run'])
        resumed = run_value['status'] == 'paused'
        if run_value['status'] == 'paused':
            resumed_records, _, _ = await store.runtime.driver.execute_query(
                '''
                MATCH (run:FuliKnowledgeReviewRun {id: $review_id})
                SET run.status = 'active', run.updated_at = $updated_at
                RETURN run
                ''',
                review_id=run_value['id'],
                updated_at=changed_at,
            )
            run_value = dict(resumed_records[0]['run'])
        return _review_run(run_value, resumed=resumed)

    completed_records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (:FuliSpace {id: $space_id, kind: 'personal'})-
              [:HAS_KNOWLEDGE_REVIEW]->(run:FuliKnowledgeReviewRun {
                scope_key: $scope_key, status: 'completed'
              })
        RETURN max(coalesce(run.review_cutoff_at, run.started_at))
               AS previous_completed_at
        ''',
        space_id=space['id'],
        scope_key=scope_key,
        routing_='r',
    )
    previous_completed_at = (
        completed_records[0].get('previous_completed_at')
        if completed_records else None
    )
    review_id = stable_uuid(
        space['id'], 'knowledge-review', scope_key, changed_at.isoformat()
    )
    created_records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (space:FuliSpace {id: $space_id, kind: 'personal'})
        MERGE (run:FuliKnowledgeReviewRun {active_key: $active_key})
        ON CREATE SET run.id = $review_id,
                      run.personal_space_id = $space_id,
                      run.scope = $scope,
                      run.personal_project_id = $personal_project_id,
                      run.scope_key = $scope_key,
                      run.status = 'active',
                      run.previous_completed_at = $previous_completed_at,
                      run.review_cutoff_at = $started_at,
                      run.started_at = $started_at,
                      run.updated_at = $started_at,
                      run.completed_at = null
        ON MATCH SET run.status = 'active', run.updated_at = $started_at
        MERGE (space)-[:HAS_KNOWLEDGE_REVIEW]->(run)
        RETURN run
        ''',
        space_id=space['id'],
        review_id=review_id,
        active_key=f"{space['id']}:{scope_key}",
        scope=request.scope,
        personal_project_id=request.personal_project_id,
        scope_key=scope_key,
        previous_completed_at=previous_completed_at,
        started_at=changed_at,
    )
    return _review_run(dict(created_records[0]['run']))


async def list_knowledge_review_candidates(
    store,
    actor: dict,
    request: KnowledgeReviewCandidateRequest,
) -> KnowledgeReviewCandidatePage:
    space = await _personal_space(store, actor, request.personal_space_id, 'reader')
    run = await _read_review_run(store, space['id'], request.review_id)
    if run.status == 'completed':
        return KnowledgeReviewCandidatePage(
            review=run,
            candidates=[],
            total_candidate_count=0,
            remaining_candidate_count=0,
        )

    entity_rows, _, _ = await store.runtime.driver.execute_query(
        _ENTITY_CANDIDATE_QUERY,
        space_id=space['id'],
        group_id=space['group_id'],
        routing_='r',
    )
    relationship_rows, _, _ = await store.runtime.driver.execute_query(
        _RELATIONSHIP_CANDIDATE_QUERY,
        space_id=space['id'],
        group_id=space['group_id'],
        routing_='r',
    )
    conflict_rows, _, _ = await store.runtime.driver.execute_query(
        _CONFLICT_ITEM_QUERY,
        space_id=space['id'],
        routing_='r',
    )
    decision_rows, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (:FuliKnowledgeReviewRun {id: $review_id})-
              [:HAS_REVIEW_DECISION]->(decision:FuliKnowledgeReviewDecision)
        RETURN decision.candidate_key AS candidate_key
        ''',
        review_id=run.review_id,
        routing_='r',
    )
    candidates = build_review_candidates(
        [dict(row) for row in [*entity_rows, *relationship_rows]],
        scope=run.scope,
        personal_project_id=run.personal_project_id,
        previous_completed_at=run.previous_completed_at,
        review_cutoff_at=run.review_cutoff_at,
        conflict_item_keys={
            key
            for row in conflict_rows
            for key in row.get('candidate_keys', [])
            if key
        },
        decided_candidate_keys={
            row['candidate_key'] for row in decision_rows
        },
    )
    selected = candidates[:request.limit]
    return KnowledgeReviewCandidatePage(
        review=run,
        candidates=selected,
        total_candidate_count=len(candidates),
        remaining_candidate_count=max(len(candidates) - len(selected), 0),
    )


async def record_knowledge_review_progress(
    store,
    actor: dict,
    request: KnowledgeReviewProgress,
    *,
    changed_at: datetime | None = None,
) -> KnowledgeReviewDecision:
    store._require_personal()
    await _personal_space(store, actor, request.personal_space_id, 'maintainer')
    updated_at = changed_at or datetime.now(timezone.utc)
    decision_id = stable_uuid(
        request.personal_space_id,
        'knowledge-review-decision',
        request.review_id,
        request.candidate_key,
    )
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (space:FuliSpace {id: $space_id, kind: 'personal'})-
              [:HAS_KNOWLEDGE_REVIEW]->(run:FuliKnowledgeReviewRun {id: $review_id})
        WHERE run.status IN ['active', 'paused']
        MERGE (decision:FuliKnowledgeReviewDecision {id: $decision_id})
        ON CREATE SET decision.created_at = $updated_at
        SET decision.review_id = $review_id,
            decision.candidate_key = $candidate_key,
            decision.outcome = $outcome,
            decision.note = $note,
            decision.updated_at = $updated_at,
            run.updated_at = $updated_at
        MERGE (run)-[:HAS_REVIEW_DECISION]->(decision)
        RETURN decision
        ''',
        space_id=request.personal_space_id,
        review_id=request.review_id,
        decision_id=decision_id,
        candidate_key=request.candidate_key,
        outcome=request.outcome,
        note=request.note,
        updated_at=updated_at,
    )
    if not records:
        raise HTTPException(status_code=404, detail='active knowledge review not found')
    return _review_decision(dict(records[0]['decision']))


async def finish_knowledge_review(
    store,
    actor: dict,
    request: KnowledgeReviewFinish,
    *,
    changed_at: datetime | None = None,
) -> KnowledgeReviewRun:
    store._require_personal()
    await _personal_space(store, actor, request.personal_space_id, 'maintainer')
    updated_at = changed_at or datetime.now(timezone.utc)
    completed_at = updated_at if request.disposition == 'completed' else None
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (:FuliSpace {id: $space_id, kind: 'personal'})-
              [:HAS_KNOWLEDGE_REVIEW]->(run:FuliKnowledgeReviewRun {id: $review_id})
        WHERE run.status IN ['active', 'paused']
        SET run.status = $status,
            run.updated_at = $updated_at,
            run.completed_at = $completed_at,
            run.active_key = CASE WHEN $status = 'completed'
                                  THEN null ELSE run.active_key END
        RETURN run
        ''',
        space_id=request.personal_space_id,
        review_id=request.review_id,
        status=request.disposition,
        updated_at=updated_at,
        completed_at=completed_at,
    )
    if not records:
        raise HTTPException(status_code=404, detail='active knowledge review not found')
    return _review_run(dict(records[0]['run']))


def build_review_candidates(
    rows: list[dict[str, Any]],
    *,
    scope: str,
    personal_project_id: str | None,
    previous_completed_at: datetime | None,
    review_cutoff_at: datetime | None = None,
    conflict_item_keys: set[str],
    decided_candidate_keys: set[str],
) -> list[KnowledgeReviewCandidate]:
    prepared = []
    for row in rows:
        candidate_key = f"{row['item_kind']}:{row['item_id']}"
        normalized = _normalize_item_row(row)
        if not _item_in_scope(normalized, scope, personal_project_id):
            continue
        if (
            review_cutoff_at is not None
            and normalized['changed_at'] is not None
            and normalized['changed_at'] > review_cutoff_at
        ):
            continue
        normalized['_candidate_key'] = candidate_key
        prepared.append(normalized)

    # One stable entity usually accumulates several sessions, while repeated
    # relationships may have distinct IDs. Aggregate both shapes, but attach the
    # cross-session reason to only one representative so the user is not asked
    # the same globalization question several times.
    pattern_groups: dict[tuple, list[dict]] = {}
    for item in prepared:
        pattern_groups.setdefault(_pattern_signature(item), []).append(item)
    repeated_representatives = {}
    for signature, items in pattern_groups.items():
        session_ids = {
            session_id
            for item in items
            for session_id in item['_session_ids']
        }
        eligible = [
            item for item in items
            if item['_candidate_key'] not in decided_candidate_keys
        ]
        if len(session_ids) < REPEATED_SESSION_COUNT or not eligible:
            continue
        representative = max(
            eligible,
            key=lambda item: (
                item['changed_at'] or datetime.min.replace(tzinfo=timezone.utc),
                item['_candidate_key'],
            ),
        )
        repeated_representatives[representative['_candidate_key']] = len(session_ids)

    candidates = []
    for normalized in prepared:
        candidate_key = normalized['_candidate_key']
        if candidate_key in decided_candidate_keys:
            continue
        if candidate_key in repeated_representatives:
            normalized['distinct_session_count'] = repeated_representatives[candidate_key]
        reasons = _candidate_reasons(
            normalized,
            previous_completed_at,
            candidate_key in conflict_item_keys,
        )
        if not reasons:
            continue
        candidates.append(KnowledgeReviewCandidate(
            candidate_key=candidate_key,
            priority=_reason_priority(reasons[0]),
            reasons=reasons,
            **{
                key: normalized[key]
                for key in KnowledgeReviewCandidate.model_fields
                if key not in {'candidate_key', 'priority', 'reasons'}
            },
        ))
    return sorted(candidates, key=_candidate_sort_key)


async def _personal_space(store, actor, space_id: str, role: str) -> dict:
    space = await store.authorize(actor, space_id, role)
    if space['kind'] != 'personal':
        raise HTTPException(status_code=422, detail='knowledge review is personal-only')
    return space


async def _read_review_run(store, space_id: str, review_id: str) -> KnowledgeReviewRun:
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (:FuliSpace {id: $space_id, kind: 'personal'})-
              [:HAS_KNOWLEDGE_REVIEW]->(run:FuliKnowledgeReviewRun {id: $review_id})
        RETURN run
        ''',
        space_id=space_id,
        review_id=review_id,
        routing_='r',
    )
    if not records:
        raise HTTPException(status_code=404, detail='knowledge review not found')
    return _review_run(dict(records[0]['run']))


def _review_run(value: dict, *, resumed: bool = False) -> KnowledgeReviewRun:
    return KnowledgeReviewRun(
        review_id=value['id'],
        personal_space_id=value['personal_space_id'],
        scope=value['scope'],
        personal_project_id=value.get('personal_project_id'),
        scope_key=value['scope_key'],
        status=value['status'],
        previous_completed_at=native_datetime(value.get('previous_completed_at')),
        review_cutoff_at=native_datetime(
            value.get('review_cutoff_at') or value['started_at']
        ),
        started_at=native_datetime(value['started_at']),
        updated_at=native_datetime(value['updated_at']),
        completed_at=native_datetime(value.get('completed_at')),
        resumed=resumed,
    )


def _review_decision(value: dict) -> KnowledgeReviewDecision:
    return KnowledgeReviewDecision(
        decision_id=value['id'],
        review_id=value['review_id'],
        candidate_key=value['candidate_key'],
        outcome=value['outcome'],
        note=value.get('note'),
        created_at=native_datetime(value['created_at']),
        updated_at=native_datetime(value['updated_at']),
    )


def _scope_key(scope: str, personal_project_id: str | None) -> str:
    return f'{scope}:{personal_project_id}' if personal_project_id else scope


def _normalize_item_row(row: dict[str, Any]) -> dict[str, Any]:
    project_ids = sorted({
        value
        for key in ('project_ids', 'assigned_project_ids', 'evidence_project_ids')
        for value in (row.get(key) or [])
        if value
    })
    session_ids = sorted({value for value in row.get('session_ids', []) if value})
    changed_at = _latest_datetime(
        row.get('created_at'),
        row.get('last_human_changed_at'),
        row.get('last_feedback_at'),
        row.get('last_revision_at'),
    )
    return {
        'item_id': row['item_id'],
        'item_kind': row['item_kind'],
        'title': row.get('title') or row['item_id'],
        'content': row.get('content') or '',
        'profile_aspect': row.get('profile_aspect'),
        'preference_scope': row.get('preference_scope'),
        'preference_project_id': row.get('preference_project_id'),
        'project_ids': project_ids,
        'confirmation_status': row.get('confirmation_status') or 'pending',
        'utility_score': _float_or_default(row.get('utility_score'), 0),
        'confidence_score': _float_or_default(row.get('confidence_score'), 0.5),
        'qualified_use_count': int(row.get('qualified_use_count') or 0),
        'distinct_task_count': int(row.get('distinct_task_count') or 0),
        'negative_evidence_count': int(row.get('negative_evidence_count') or 0),
        'requires_attention': row.get('requires_attention') is True,
        'last_feedback_kind': row.get('last_feedback_kind'),
        'distinct_session_count': len(session_ids),
        'changed_at': changed_at,
        '_session_ids': session_ids,
    }


def _pattern_signature(item: dict) -> tuple:
    content = ' '.join((item['content'] or item['title']).casefold().split())
    return item['item_kind'], item['profile_aspect'], content


def _item_in_scope(item: dict, scope: str, project_id: str | None) -> bool:
    is_preference = item['profile_aspect'] is not None
    preference_scope = item['preference_scope'] or 'global'
    is_global_preference = is_preference and preference_scope == 'global'
    is_project_preference = is_preference and preference_scope == 'project'
    is_project_knowledge = not is_preference and bool(item['project_ids'])
    if scope == 'all':
        return is_global_preference or is_project_preference or is_project_knowledge
    if scope == 'preferences_global':
        return is_global_preference
    if scope == 'preferences_project':
        return is_project_preference and item['preference_project_id'] == project_id
    if scope == 'projects_all':
        return is_project_preference or is_project_knowledge
    if scope == 'project':
        return (
            is_project_preference and item['preference_project_id'] == project_id
        ) or (
            is_project_knowledge and project_id in item['project_ids']
        )
    raise ValueError(f'Unknown knowledge review scope: {scope}')


def _candidate_reasons(
    item: dict,
    previous_completed_at: datetime | None,
    has_conflict: bool,
) -> list[str]:
    reasons = []
    if previous_completed_at is None or (
        item['changed_at'] is not None and item['changed_at'] > previous_completed_at
    ):
        reasons.append('changed_since_last')
    if (
        has_conflict
        or item['requires_attention']
        or item['negative_evidence_count'] > 0
    ):
        reasons.append('conflict_or_attention')
    if (
        item['utility_score'] <= LOW_UTILITY_SCORE
        or item['confidence_score'] <= LOW_CONFIDENCE_SCORE
    ):
        reasons.append('low_weight')
    if item['distinct_session_count'] >= REPEATED_SESSION_COUNT:
        reasons.append('repeated_cross_session')
    return reasons


def _reason_priority(reason: str) -> int:
    return {
        'changed_since_last': 1,
        'conflict_or_attention': 2,
        'low_weight': 3,
        'repeated_cross_session': 4,
    }[reason]


def _candidate_sort_key(candidate: KnowledgeReviewCandidate) -> tuple:
    changed_at = candidate.changed_at or datetime.min.replace(tzinfo=timezone.utc)
    return (
        candidate.priority,
        not candidate.requires_attention,
        -candidate.negative_evidence_count,
        -changed_at.timestamp(),
        candidate.utility_score,
        candidate.candidate_key,
    )


def _latest_datetime(*values) -> datetime | None:
    normalized = [native_datetime(value) for value in values if value is not None]
    return max(normalized) if normalized else None


def _float_or_default(value, default: float) -> float:
    return default if value is None else float(value)


_ENTITY_CANDIDATE_QUERY = '''
MATCH (item:Entity {group_id: $group_id})
WHERE item.fuli_invalid_at IS NULL
OPTIONAL MATCH (episode:Episodic {group_id: $group_id})-[:MENTIONS]->(item)
OPTIONAL MATCH (assignment:FuliKnowledgeAssignment {
  space_id: $space_id, item_kind: 'entity', item_id: item.uuid
})
OPTIONAL MATCH (:FuliSpace {id: $space_id})-[:HAS_KNOWLEDGE_REVISION]->
              (revision:FuliKnowledgeRevision {item_kind: 'entity', item_id: item.uuid})
RETURN item.uuid AS item_id,
       'entity' AS item_kind,
       item.name AS title,
       coalesce(item.summary, '') AS content,
       item.fuli_profile_aspect AS profile_aspect,
       item.fuli_preference_scope AS preference_scope,
       item.fuli_preference_project_id AS preference_project_id,
       collect(DISTINCT assignment.project_id) AS assigned_project_ids,
       collect(DISTINCT episode.fuli_personal_project_id) AS evidence_project_ids,
       collect(DISTINCT episode.fuli_session_id) AS session_ids,
       coalesce(item.fuli_confirmation_status, 'pending') AS confirmation_status,
       coalesce(item.fuli_utility_score, 0.0) AS utility_score,
       coalesce(item.fuli_confidence_score, 0.5) AS confidence_score,
       coalesce(item.fuli_qualified_use_count, 0) AS qualified_use_count,
       coalesce(item.fuli_distinct_task_count, 0) AS distinct_task_count,
       coalesce(item.fuli_negative_evidence_count, 0) AS negative_evidence_count,
       coalesce(item.fuli_requires_attention, false) AS requires_attention,
       item.fuli_last_feedback_kind AS last_feedback_kind,
       item.created_at AS created_at,
       item.fuli_last_human_changed_at AS last_human_changed_at,
       item.fuli_last_feedback_at AS last_feedback_at,
       max(revision.created_at) AS last_revision_at
'''


_RELATIONSHIP_CANDIDATE_QUERY = '''
MATCH ()-[item:RELATES_TO {group_id: $group_id}]->()
WHERE item.invalid_at IS NULL
OPTIONAL MATCH (episode:Episodic {group_id: $group_id})
WHERE episode.uuid IN coalesce(item.episodes, [])
OPTIONAL MATCH (assignment:FuliKnowledgeAssignment {
  space_id: $space_id, item_kind: 'relationship', item_id: item.uuid
})
OPTIONAL MATCH (:FuliSpace {id: $space_id})-[:HAS_KNOWLEDGE_REVISION]->
              (revision:FuliKnowledgeRevision {
                item_kind: 'relationship', item_id: item.uuid
              })
RETURN item.uuid AS item_id,
       'relationship' AS item_kind,
       coalesce(item.name, 'RELATES_TO') AS title,
       coalesce(item.fact, '') AS content,
       item.fuli_profile_aspect AS profile_aspect,
       item.fuli_preference_scope AS preference_scope,
       item.fuli_preference_project_id AS preference_project_id,
       collect(DISTINCT assignment.project_id) AS assigned_project_ids,
       collect(DISTINCT episode.fuli_personal_project_id) AS evidence_project_ids,
       collect(DISTINCT episode.fuli_session_id) AS session_ids,
       coalesce(item.fuli_confirmation_status, 'pending') AS confirmation_status,
       coalesce(item.fuli_utility_score, 0.0) AS utility_score,
       coalesce(item.fuli_confidence_score, 0.5) AS confidence_score,
       coalesce(item.fuli_qualified_use_count, 0) AS qualified_use_count,
       coalesce(item.fuli_distinct_task_count, 0) AS distinct_task_count,
       coalesce(item.fuli_negative_evidence_count, 0) AS negative_evidence_count,
       coalesce(item.fuli_requires_attention, false) AS requires_attention,
       item.fuli_last_feedback_kind AS last_feedback_kind,
       item.created_at AS created_at,
       item.fuli_last_human_changed_at AS last_human_changed_at,
       item.fuli_last_feedback_at AS last_feedback_at,
       max(revision.created_at) AS last_revision_at
'''


_CONFLICT_ITEM_QUERY = '''
MATCH (space:FuliSpace {id: $space_id, kind: 'personal'})
OPTIONAL MATCH (space)-[:HAS_KNOWLEDGE_CONFLICT]->
              (knowledge:FuliKnowledgeConflict {status: 'pending'})
WITH space, collect(DISTINCT 'entity:' + knowledge.item_id) +
     collect(DISTINCT 'relationship:' + knowledge.item_id) +
     collect(DISTINCT 'entity:' + knowledge.target_item_id) +
     collect(DISTINCT 'relationship:' + knowledge.target_item_id)
     AS knowledge_keys
OPTIONAL MATCH (space)-[:HAS_PREFERENCE_CONFLICT]->
              (preference:FuliPreferenceConflict {status: 'ai_pending'})
RETURN knowledge_keys +
       collect(DISTINCT preference.left_item_kind + ':' + preference.left_item_id) +
       collect(DISTINCT preference.right_item_kind + ':' + preference.right_item_id)
       AS candidate_keys
'''
