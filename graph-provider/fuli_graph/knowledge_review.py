from datetime import datetime, timezone
from typing import Any

from fastapi import HTTPException

from .knowledge_review_models import (
    KnowledgeReviewAIAssessment,
    KnowledgeReviewCandidate,
    KnowledgeReviewCandidatePage,
    KnowledgeReviewCandidateRequest,
    KnowledgeReviewDecision,
    KnowledgeReviewFinish,
    KnowledgeReviewProgress,
    KnowledgeReviewRun,
    KnowledgeReviewStart,
)
from .ai_review import ai_review_evidence_token
from .personal_project_access import authorize_personal_project
from .provider_values import native_datetime, stable_uuid
from .store_transactions import query_store_transaction

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
    if request.reviewer == 'tonborg':
        scope_key += ':tonborg'
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
    # Tonborg has its own paginated queue and versioned decision ledger. It must
    # not advance the human review watermark or lose items beyond one batch.
    if request.reviewer == 'tonborg':
        previous_completed_at = None
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
                      run.reviewer = $reviewer,
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
        reviewer=request.reviewer,
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
        project_id=run.personal_project_id,
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
    deferred_rows, _, _ = await store.runtime.driver.execute_query(
        _DEFERRED_ITEM_QUERY,
        space_id=space['id'],
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
        deferred_candidate_keys={
            key
            for row in deferred_rows
            for key in row.get('candidate_keys', [])
            if key
        },
    )
    selected = candidates[request.offset:request.offset + request.limit]
    return KnowledgeReviewCandidatePage(
        review=run,
        candidates=selected,
        total_candidate_count=len(candidates),
        remaining_candidate_count=max(len(candidates) - request.offset - len(selected), 0),
    )


async def record_knowledge_review_progress(
    store,
    actor: dict,
    request: KnowledgeReviewProgress,
    *,
    changed_at: datetime | None = None,
) -> KnowledgeReviewDecision:
    store._require_personal()
    space = await _personal_space(store, actor, request.personal_space_id, 'maintainer')
    updated_at = changed_at or datetime.now(timezone.utc)
    decision_id = stable_uuid(
        request.personal_space_id,
        'knowledge-review-decision',
        request.review_id,
        request.candidate_key,
    )
    if request.outcome == 'ai_reviewed':
        return await _record_ai_review_progress(
            store,
            space,
            request,
            decision_id=decision_id,
            updated_at=updated_at,
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


async def _record_ai_review_progress(
    store,
    space: dict,
    request: KnowledgeReviewProgress,
    *,
    decision_id: str,
    updated_at: datetime,
) -> KnowledgeReviewDecision:
    """CAS an AI result against a locked, freshly-read item snapshot."""

    item_kind, separator, item_id = request.candidate_key.partition(':')
    if not separator or item_kind not in {'entity', 'relationship'} or not item_id:
        raise HTTPException(status_code=422, detail='invalid review candidate')

    async with query_store_transaction(store) as scoped:
        run_records, _, _ = await scoped.runtime.driver.execute_query(
            _AI_REVIEW_RUN_QUERY,
            space_id=space['id'],
            review_id=request.review_id,
        )
        if not run_records:
            raise HTTPException(status_code=404, detail='active knowledge review not found')
        run = dict(run_records[0]['run'])
        if run.get('reviewer') != 'tonborg' and not str(
            run.get('scope_key', '')
        ).endswith(':tonborg'):
            raise HTTPException(
                status_code=403,
                detail='AI review progress is only valid for a Tonborg review run',
            )
        if run.get('status') not in {'active', 'paused'}:
            raise HTTPException(status_code=404, detail='active knowledge review not found')

        current_records, _, _ = await scoped.runtime.driver.execute_query(
            _AI_REVIEW_CURRENT_ENTITY_QUERY
            if item_kind == 'entity' else _AI_REVIEW_CURRENT_RELATIONSHIP_QUERY,
            space_id=space['id'],
            group_id=space['group_id'],
            item_id=item_id,
            project_id=run.get('personal_project_id'),
        )
        if not current_records:
            raise HTTPException(status_code=404, detail='review candidate not found')
        current = dict(current_records[0])
        normalized = _normalize_item_row(current)
        if not _item_in_scope(
            normalized,
            run['scope'],
            run.get('personal_project_id'),
        ):
            raise HTTPException(
                status_code=409,
                detail='review candidate is outside the current project scope',
            )
        has_conflict = bool(current.get('has_conflict'))
        current_token = ai_review_evidence_token(
            normalized,
            scope=run['scope'],
            personal_project_id=run.get('personal_project_id'),
            has_conflict=has_conflict,
        )
        if current_token != request.ai_review_evidence_token:
            raise HTTPException(
                status_code=409,
                detail='knowledge review evidence changed; reload candidate',
            )

        assessment_json = request.ai_assessment.model_dump_json()
        write_query = (
            _AI_REVIEW_ENTITY_WRITE_QUERY
            if item_kind == 'entity' else _AI_REVIEW_RELATIONSHIP_WRITE_QUERY
        )
        records, _, _ = await scoped.runtime.driver.execute_query(
            write_query,
            space_id=space['id'],
            group_id=space['group_id'],
            item_id=item_id,
            review_id=request.review_id,
            decision_id=decision_id,
            candidate_key=request.candidate_key,
            outcome=request.outcome,
            note=request.note,
            ai_review_evidence_token=current_token,
            ai_assessment_json=assessment_json,
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
    deferred_candidate_keys: set[str] | None = None,
) -> list[KnowledgeReviewCandidate]:
    deferred_candidate_keys = deferred_candidate_keys or set()
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
        normalized['ai_review_evidence_token'] = ai_review_evidence_token(
            normalized,
            scope=scope,
            personal_project_id=personal_project_id,
            has_conflict=candidate_key in conflict_item_keys,
        )
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
            candidate_key in deferred_candidate_keys,
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
        reviewer=value.get('reviewer') or (
            'tonborg' if str(value.get('scope_key', '')).endswith(':tonborg')
            else 'human'
        ),
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
    assessment = value.get('ai_assessment')
    if assessment is None:
        assessment = value.get('ai_assessment_json')
    if isinstance(assessment, str):
        try:
            import json
            assessment = json.loads(assessment)
        except (TypeError, ValueError):
            assessment = None
    if assessment is not None:
        assessment = KnowledgeReviewAIAssessment.model_validate(assessment)
    return KnowledgeReviewDecision(
        decision_id=value['id'],
        review_id=value['review_id'],
        candidate_key=value['candidate_key'],
        outcome=value['outcome'],
        note=value.get('note'),
        created_at=native_datetime(value['created_at']),
        updated_at=native_datetime(value['updated_at']),
        ai_review_evidence_token=value.get('ai_review_evidence_token'),
        ai_assessment=assessment,
        ai_review_scope=value.get('ai_review_scope'),
        ai_review_project_id=value.get('ai_review_project_id'),
    )


def _scope_key(scope: str, personal_project_id: str | None) -> str:
    return f'{scope}:{personal_project_id}' if personal_project_id else scope


def _normalize_item_row(row: dict[str, Any]) -> dict[str, Any]:
    project_ids = sorted({
        value
        for key in (
            'project_ids',
            'assigned_project_ids',
            'reference_project_ids',
            'evidence_project_ids',
        )
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
        'preference_agent_id': row.get('preference_agent_id'),
        'inheritance_mode': row.get('inheritance_mode') or 'local_only',
        'project_ids': project_ids,
        'confirmation_status': row.get('confirmation_status') or 'pending',
        'confirmation_basis_json': row.get('confirmation_basis_json'),
        'current_quadrant': row.get('current_quadrant') or 'known_known',
        'utility_score': _float_or_default(row.get('utility_score'), 0),
        'confidence_score': _float_or_default(row.get('confidence_score'), 0.5),
        'qualified_use_count': int(row.get('qualified_use_count') or 0),
        'distinct_task_count': int(row.get('distinct_task_count') or 0),
        'negative_evidence_count': int(row.get('negative_evidence_count') or 0),
        'requires_attention': row.get('requires_attention') is True,
        'last_feedback_kind': row.get('last_feedback_kind'),
        'distinct_session_count': len(session_ids),
        'changed_at': changed_at,
        'valid_at': row.get('valid_at'),
        'invalid_at': row.get('invalid_at'),
        'human_change_version': int(row.get('human_change_version') or 0),
        'attributes_json': row.get('attributes_json'),
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
    was_deferred: bool,
) -> list[str]:
    reasons = []
    if previous_completed_at is None or (
        item['changed_at'] is not None and item['changed_at'] > previous_completed_at
    ):
        reasons.append('changed_since_last')
    if was_deferred:
        reasons.append('deferred_from_previous')
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
        'deferred_from_previous': 1,
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
OPTIONAL MATCH (:FuliSpace {id: $space_id})-[:HAS_KNOWLEDGE_REFERENCE]->
              (reference:FuliKnowledgeProjectReference {
                item_kind: 'entity', item_id: item.uuid, status: 'active'
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
       item.fuli_preference_agent_id AS preference_agent_id,
       coalesce(item.fuli_inheritance_mode, 'local_only') AS inheritance_mode,
       coalesce(
         item.fuli_current_quadrant,
         item.fuli_origin_quadrant,
         'known_known'
       ) AS current_quadrant,
       item.fuli_confirmation_basis_json AS confirmation_basis_json,
       NULL AS valid_at,
       item.fuli_invalid_at AS invalid_at,
       coalesce(item.fuli_human_change_version, 0) AS human_change_version,
       coalesce(item.fuli_attributes_json, '{}') AS attributes_json,
       collect(DISTINCT assignment.project_id) AS assigned_project_ids,
       collect(DISTINCT reference.project_id) AS reference_project_ids,
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
OPTIONAL MATCH (:FuliSpace {id: $space_id})-[:HAS_KNOWLEDGE_REFERENCE]->
              (reference:FuliKnowledgeProjectReference {
                item_kind: 'relationship', item_id: item.uuid, status: 'active'
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
       item.fuli_preference_agent_id AS preference_agent_id,
       coalesce(item.fuli_inheritance_mode, 'local_only') AS inheritance_mode,
       coalesce(
         item.fuli_current_quadrant,
         item.fuli_origin_quadrant,
         'known_known'
       ) AS current_quadrant,
       item.fuli_confirmation_basis_json AS confirmation_basis_json,
       item.valid_at AS valid_at,
       item.invalid_at AS invalid_at,
       coalesce(item.fuli_human_change_version, 0) AS human_change_version,
       coalesce(item.fuli_attributes_json, '{}') AS attributes_json,
       collect(DISTINCT assignment.project_id) AS assigned_project_ids,
       collect(DISTINCT reference.project_id) AS reference_project_ids,
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
WHERE ($project_id IS NULL
       OR knowledge.target_project_id = $project_id
       OR knowledge.source_project_id = $project_id)
WITH space, collect(DISTINCT 'entity:' + knowledge.item_id) +
     collect(DISTINCT 'relationship:' + knowledge.item_id) +
     collect(DISTINCT 'entity:' + knowledge.target_item_id) +
     collect(DISTINCT 'relationship:' + knowledge.target_item_id)
     AS knowledge_keys
OPTIONAL MATCH (space)-[:HAS_PREFERENCE_CONFLICT]->
              (preference:FuliPreferenceConflict {status: 'ai_pending'})
WHERE $project_id IS NULL OR preference.preference_project_id = $project_id
WITH knowledge_keys,
     collect(DISTINCT preference.left_item_kind + ':' + preference.left_item_id) +
     collect(DISTINCT preference.right_item_kind + ':' + preference.right_item_id)
     AS preference_keys
RETURN knowledge_keys + preference_keys AS candidate_keys
'''


_DEFERRED_ITEM_QUERY = '''
MATCH (:FuliSpace {id: $space_id, kind: 'personal'})-
      [:HAS_KNOWLEDGE_REVIEW]->(past_run:FuliKnowledgeReviewRun)
WHERE past_run.id <> $review_id
MATCH (past_run)-[:HAS_REVIEW_DECISION]->
      (decision:FuliKnowledgeReviewDecision)
WITH decision.candidate_key AS candidate_key, decision
ORDER BY decision.updated_at DESC, decision.id DESC
WITH candidate_key, collect(decision)[0] AS latest_decision
WHERE latest_decision.outcome = 'deferred'
RETURN collect(candidate_key) AS candidate_keys
'''


# These queries intentionally perform a property write before the dependent
# read. Neo4j then holds a write lock on the item until the surrounding
# query_store_transaction commits or rolls back, closing the read/decision CAS
# window even when a knowledge edit has not yet written its revision metadata.
_AI_REVIEW_CURRENT_ENTITY_QUERY = '''
MATCH (item:Entity {uuid: $item_id, group_id: $group_id})
SET item.fuli_ai_review_lock_version =
      coalesce(item.fuli_ai_review_lock_version, 0) + 1
WITH item
OPTIONAL MATCH (episode:Episodic {group_id: $group_id})-[:MENTIONS]->(item)
OPTIONAL MATCH (assignment:FuliKnowledgeAssignment {
  space_id: $space_id, item_kind: 'entity', item_id: item.uuid
})
OPTIONAL MATCH (:FuliSpace {id: $space_id})-[:HAS_KNOWLEDGE_REFERENCE]->
               (reference:FuliKnowledgeProjectReference {
                 item_kind: 'entity', item_id: item.uuid, status: 'active'
               })
WITH item,
     collect(DISTINCT assignment.project_id) +
     collect(DISTINCT reference.project_id) +
     collect(DISTINCT episode.fuli_personal_project_id) AS project_ids
OPTIONAL MATCH (space:FuliSpace {id: $space_id, kind: 'personal'})-
               [:HAS_KNOWLEDGE_CONFLICT]->
               (knowledge:FuliKnowledgeConflict {status: 'pending'})
WHERE (knowledge.item_id = item.uuid OR knowledge.target_item_id = item.uuid)
  AND ($project_id IS NULL
       OR knowledge.target_project_id = $project_id
       OR knowledge.source_project_id = $project_id)
WITH item, project_ids, collect(DISTINCT knowledge.id) AS knowledge_conflicts
OPTIONAL MATCH (space:FuliSpace {id: $space_id, kind: 'personal'})-
               [:HAS_PREFERENCE_CONFLICT]->
               (preference:FuliPreferenceConflict {status: 'ai_pending'})
WHERE (preference.left_item_id = item.uuid OR preference.right_item_id = item.uuid)
  AND ($project_id IS NULL OR preference.preference_project_id = $project_id)
WITH item, project_ids, knowledge_conflicts,
     collect(DISTINCT preference.id) AS preference_conflicts
RETURN item.uuid AS item_id,
       'entity' AS item_kind,
       item.name AS title,
       coalesce(item.summary, '') AS content,
       item.fuli_profile_aspect AS profile_aspect,
       item.fuli_preference_scope AS preference_scope,
       item.fuli_preference_project_id AS preference_project_id,
       item.fuli_preference_agent_id AS preference_agent_id,
       coalesce(item.fuli_inheritance_mode, 'local_only') AS inheritance_mode,
       coalesce(item.fuli_current_quadrant, item.fuli_origin_quadrant,
                'known_known') AS current_quadrant,
       item.fuli_confirmation_status AS confirmation_status,
       item.fuli_confirmation_basis_json AS confirmation_basis_json,
       NULL AS valid_at,
       item.fuli_invalid_at AS invalid_at,
       coalesce(item.fuli_utility_score, 0.0) AS utility_score,
       coalesce(item.fuli_confidence_score, 0.5) AS confidence_score,
       coalesce(item.fuli_qualified_use_count, 0) AS qualified_use_count,
       coalesce(item.fuli_distinct_task_count, 0) AS distinct_task_count,
       coalesce(item.fuli_negative_evidence_count, 0) AS negative_evidence_count,
       coalesce(item.fuli_requires_attention, false) AS requires_attention,
       coalesce(item.fuli_human_change_version, 0) AS human_change_version,
       coalesce(item.fuli_attributes_json, '{}') AS attributes_json,
       project_ids,
       CASE WHEN size(knowledge_conflicts) + size(preference_conflicts) > 0
            THEN true ELSE false END AS has_conflict,
       item.created_at AS created_at,
       item.fuli_last_human_changed_at AS last_human_changed_at,
       item.fuli_last_feedback_at AS last_feedback_at,
       item.fuli_last_feedback_kind AS last_feedback_kind,
       [] AS session_ids
'''


_AI_REVIEW_CURRENT_RELATIONSHIP_QUERY = '''
MATCH ()-[item:RELATES_TO {uuid: $item_id, group_id: $group_id}]->()
SET item.fuli_ai_review_lock_version =
      coalesce(item.fuli_ai_review_lock_version, 0) + 1
WITH item
OPTIONAL MATCH (episode:Episodic {group_id: $group_id})
WHERE episode.uuid IN coalesce(item.episodes, [])
OPTIONAL MATCH (assignment:FuliKnowledgeAssignment {
  space_id: $space_id, item_kind: 'relationship', item_id: item.uuid
})
OPTIONAL MATCH (:FuliSpace {id: $space_id})-[:HAS_KNOWLEDGE_REFERENCE]->
               (reference:FuliKnowledgeProjectReference {
                 item_kind: 'relationship', item_id: item.uuid, status: 'active'
               })
WITH item,
     collect(DISTINCT assignment.project_id) +
     collect(DISTINCT reference.project_id) +
     collect(DISTINCT episode.fuli_personal_project_id) AS project_ids
OPTIONAL MATCH (space:FuliSpace {id: $space_id, kind: 'personal'})-
               [:HAS_KNOWLEDGE_CONFLICT]->
               (knowledge:FuliKnowledgeConflict {status: 'pending'})
WHERE (knowledge.item_id = item.uuid OR knowledge.target_item_id = item.uuid)
  AND ($project_id IS NULL
       OR knowledge.target_project_id = $project_id
       OR knowledge.source_project_id = $project_id)
WITH item, project_ids, collect(DISTINCT knowledge.id) AS knowledge_conflicts
OPTIONAL MATCH (space:FuliSpace {id: $space_id, kind: 'personal'})-
               [:HAS_PREFERENCE_CONFLICT]->
               (preference:FuliPreferenceConflict {status: 'ai_pending'})
WHERE (preference.left_item_id = item.uuid OR preference.right_item_id = item.uuid)
  AND ($project_id IS NULL OR preference.preference_project_id = $project_id)
WITH item, project_ids, knowledge_conflicts,
     collect(DISTINCT preference.id) AS preference_conflicts
RETURN item.uuid AS item_id,
       'relationship' AS item_kind,
       coalesce(item.name, 'RELATES_TO') AS title,
       coalesce(item.fact, '') AS content,
       item.fuli_profile_aspect AS profile_aspect,
       item.fuli_preference_scope AS preference_scope,
       item.fuli_preference_project_id AS preference_project_id,
       item.fuli_preference_agent_id AS preference_agent_id,
       coalesce(item.fuli_inheritance_mode, 'local_only') AS inheritance_mode,
       coalesce(item.fuli_current_quadrant, item.fuli_origin_quadrant,
                'known_known') AS current_quadrant,
       item.fuli_confirmation_status AS confirmation_status,
       item.fuli_confirmation_basis_json AS confirmation_basis_json,
       item.valid_at AS valid_at,
       item.invalid_at AS invalid_at,
       coalesce(item.fuli_utility_score, 0.0) AS utility_score,
       coalesce(item.fuli_confidence_score, 0.5) AS confidence_score,
       coalesce(item.fuli_qualified_use_count, 0) AS qualified_use_count,
       coalesce(item.fuli_distinct_task_count, 0) AS distinct_task_count,
       coalesce(item.fuli_negative_evidence_count, 0) AS negative_evidence_count,
       coalesce(item.fuli_requires_attention, false) AS requires_attention,
       coalesce(item.fuli_human_change_version, 0) AS human_change_version,
       coalesce(item.fuli_attributes_json, '{}') AS attributes_json,
       project_ids,
       CASE WHEN size(knowledge_conflicts) + size(preference_conflicts) > 0
            THEN true ELSE false END AS has_conflict,
       item.created_at AS created_at,
       item.fuli_last_human_changed_at AS last_human_changed_at,
       item.fuli_last_feedback_at AS last_feedback_at,
       item.fuli_last_feedback_kind AS last_feedback_kind,
       [] AS session_ids
'''


_AI_REVIEW_RUN_QUERY = '''
MATCH (:FuliSpace {id: $space_id, kind: 'personal'})-
      [:HAS_KNOWLEDGE_REVIEW]->(run:FuliKnowledgeReviewRun {id: $review_id})
RETURN run
'''


_AI_REVIEW_ENTITY_WRITE_QUERY = '''
MATCH (space:FuliSpace {id: $space_id, kind: 'personal'})-
      [:HAS_KNOWLEDGE_REVIEW]->(run:FuliKnowledgeReviewRun {id: $review_id})
MATCH (item:Entity {uuid: $item_id, group_id: $group_id})
WHERE run.status IN ['active', 'paused']
MERGE (decision:FuliKnowledgeReviewDecision {id: $decision_id})
ON CREATE SET decision.created_at = $updated_at
SET item.fuli_ai_review_evidence_token = $ai_review_evidence_token,
    item.fuli_ai_assessment_json = $ai_assessment_json,
    item.fuli_ai_review_scope = run.scope,
    item.fuli_ai_review_project_id = run.personal_project_id,
    item.fuli_ai_reviewed_at = $updated_at,
    item.fuli_ai_review_id = $review_id,
    item.fuli_ai_review_decision_id = $decision_id,
    decision.review_id = $review_id,
    decision.candidate_key = $candidate_key,
    decision.outcome = $outcome,
    decision.note = $note,
    decision.ai_review_evidence_token = $ai_review_evidence_token,
    decision.ai_assessment_json = $ai_assessment_json,
    decision.ai_review_scope = run.scope,
    decision.ai_review_project_id = run.personal_project_id,
    decision.updated_at = $updated_at,
    run.updated_at = $updated_at
MERGE (run)-[:HAS_REVIEW_DECISION]->(decision)
RETURN decision
'''


_AI_REVIEW_RELATIONSHIP_WRITE_QUERY = '''
MATCH (space:FuliSpace {id: $space_id, kind: 'personal'})-
      [:HAS_KNOWLEDGE_REVIEW]->(run:FuliKnowledgeReviewRun {id: $review_id})
MATCH ()-[item:RELATES_TO {uuid: $item_id, group_id: $group_id}]->()
WHERE run.status IN ['active', 'paused']
MERGE (decision:FuliKnowledgeReviewDecision {id: $decision_id})
ON CREATE SET decision.created_at = $updated_at
SET item.fuli_ai_review_evidence_token = $ai_review_evidence_token,
    item.fuli_ai_assessment_json = $ai_assessment_json,
    item.fuli_ai_review_scope = run.scope,
    item.fuli_ai_review_project_id = run.personal_project_id,
    item.fuli_ai_reviewed_at = $updated_at,
    item.fuli_ai_review_id = $review_id,
    item.fuli_ai_review_decision_id = $decision_id,
    decision.review_id = $review_id,
    decision.candidate_key = $candidate_key,
    decision.outcome = $outcome,
    decision.note = $note,
    decision.ai_review_evidence_token = $ai_review_evidence_token,
    decision.ai_assessment_json = $ai_assessment_json,
    decision.ai_review_scope = run.scope,
    decision.ai_review_project_id = run.personal_project_id,
    decision.updated_at = $updated_at,
    run.updated_at = $updated_at
MERGE (run)-[:HAS_REVIEW_DECISION]->(decision)
RETURN decision
'''
