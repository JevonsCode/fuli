import hashlib
import json
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException

from .provider_values import native_datetime, now_utc, stable_uuid
from .workflow_candidate_models import (
    WorkflowAuthorization,
    WorkflowCandidate,
    WorkflowCandidatePage,
    WorkflowCandidateReview,
    WorkflowCandidateReviewIntent,
    WorkflowCandidateReviewPreview,
    WorkflowCandidateSearch,
    WorkflowRecommendation,
    WorkflowRecommendationPage,
    WorkflowRecommendationPolicy,
    WorkflowRecommendationWeights,
    WorkflowRecency,
)

MINIMUM_OCCURRENCES = 3
MINIMUM_DISTINCT_SESSIONS = 3
RECOMMENDATION_THRESHOLD = 0.7
RECOMMENDATION_WEIGHTS = WorkflowRecommendationWeights(
    occurrences=0.45,
    distinct_sessions=0.25,
    recency=0.2,
    confirmation_authority=0.1,
)
DECLINE_PENALTY = 0.25
NEGATIVE_EVIDENCE_PENALTY = 0.1
HIGH_RISK_ACTION_CATEGORIES = [
    'send', 'delete', 'publish', 'payment', 'external_write'
]
REVIEW_PREVIEW_TTL = timedelta(minutes=10)
RECOMMENDATION_POLICY = WorkflowRecommendationPolicy(
    minimum_occurrences=MINIMUM_OCCURRENCES,
    minimum_distinct_sessions=MINIMUM_DISTINCT_SESSIONS,
    recommendation_threshold=RECOMMENDATION_THRESHOLD,
    weights=RECOMMENDATION_WEIGHTS,
    decline_penalty=DECLINE_PENALTY,
    negative_evidence_penalty=NEGATIVE_EVIDENCE_PENALTY,
)


async def recommend_workflow_candidates(
    store,
    actor: dict,
    request: WorkflowCandidateSearch,
    *,
    evaluated_at: datetime | None = None,
) -> WorkflowRecommendationPage:
    candidates = await _read_workflow_candidates(
        store, actor, request, evaluated_at=evaluated_at
    )
    return WorkflowRecommendationPage(
        policy=RECOMMENDATION_POLICY,
        candidates=[
            candidate
            for candidate in candidates
            if candidate.recommendation.recommended
            or candidate.execution_authorized
        ],
    )


async def search_workflow_candidates(
    store,
    actor: dict,
    request: WorkflowCandidateSearch,
    *,
    evaluated_at: datetime | None = None,
) -> WorkflowCandidatePage:
    return WorkflowCandidatePage(
        policy=RECOMMENDATION_POLICY,
        candidates=await _read_workflow_candidates(
            store, actor, request, evaluated_at=evaluated_at
        ),
    )


async def preview_workflow_candidate_review(
    store,
    actor: dict,
    candidate_id: str,
    request: WorkflowCandidateReviewIntent,
    *,
    created_at: datetime | None = None,
    token_factory=secrets.token_urlsafe,
) -> WorkflowCandidateReviewPreview:
    space = await _personal_space(
        store, actor, request.personal_space_id, 'maintainer'
    )
    target_rows, _, _ = await store.runtime.driver.execute_query(
        _WORKFLOW_CANDIDATE_REVIEW_TARGET_QUERY,
        space_id=space['id'],
        candidate_id=candidate_id,
        routing_='r',
    )
    if not target_rows:
        raise HTTPException(status_code=404, detail='workflow candidate not found')
    current_version = int(target_rows[0]['candidate_version'])
    current_evidence_revision = int(target_rows[0]['evidence_revision'])
    current_decision_revision = int(target_rows[0]['decision_revision'])
    if (
        current_version != request.candidate_version
        or current_evidence_revision != request.evidence_revision
        or current_decision_revision != request.decision_revision
    ):
        raise HTTPException(
            status_code=409,
            detail='workflow candidate changed; refresh before reviewing',
        )
    issued_at = created_at or now_utc()
    expires_at = issued_at + REVIEW_PREVIEW_TTL
    approval_token = token_factory(32)
    token_hash = _sha256(approval_token)
    payload_fingerprint = _review_payload_fingerprint(candidate_id, request)
    preview_id = stable_uuid(
        space['id'], 'workflow-review-preview', token_hash
    )
    records, _, _ = await store.runtime.driver.execute_query(
        _CREATE_WORKFLOW_REVIEW_PREVIEW_QUERY,
        space_id=space['id'],
        candidate_id=candidate_id,
        candidate_version=request.candidate_version,
        evidence_revision=request.evidence_revision,
        decision_revision=request.decision_revision,
        rule_fingerprint=(
            target_rows[0].get('rule_fingerprint') or candidate_id
        ),
        preview_id=preview_id,
        token_hash=token_hash,
        payload_fingerprint=payload_fingerprint,
        issued_to_actor_id=actor['id'],
        issued_channel='provider_http_human_review',
        created_at=issued_at,
        expires_at=expires_at,
    )
    if not records:
        raise HTTPException(
            status_code=409,
            detail='workflow candidate changed before review preview was created',
        )
    return WorkflowCandidateReviewPreview(
        preview_id=preview_id,
        candidate_id=candidate_id,
        candidate_version=request.candidate_version,
        evidence_revision=request.evidence_revision,
        decision_revision=request.decision_revision,
        payload_fingerprint=payload_fingerprint,
        approval_token=approval_token,
        expires_at=expires_at,
    )


async def review_workflow_candidate(
    store,
    actor: dict,
    candidate_id: str,
    request: WorkflowCandidateReview,
    *,
    reviewed_at: datetime | None = None,
) -> WorkflowCandidate:
    space = await _personal_space(
        store, actor, request.personal_space_id, 'maintainer'
    )
    changed_at = reviewed_at or now_utc()
    payload_fingerprint = _review_payload_fingerprint(candidate_id, request)
    event_id = stable_uuid(
        space['id'],
        'workflow-review-event',
        candidate_id,
        str(request.candidate_version),
        request.idempotency_key,
    )
    existing_rows, _, _ = await store.runtime.driver.execute_query(
        _WORKFLOW_REVIEW_EVENT_QUERY,
        space_id=space['id'],
        event_id=event_id,
        routing_='r',
    )
    if existing_rows:
        if existing_rows[0].get('payload_fingerprint') != payload_fingerprint:
            raise HTTPException(
                status_code=409,
                detail='workflow review idempotency key was used for another payload',
            )
        return await _read_workflow_candidate(
            store, actor, space['id'], candidate_id, changed_at
        )
    token_hash = _sha256(request.approval_token)
    if request.decision == 'reject':
        records, _, _ = await store.runtime.driver.execute_query(
            _REJECT_WORKFLOW_CANDIDATE_QUERY,
            space_id=space['id'],
            candidate_id=candidate_id,
            candidate_version=request.candidate_version,
            evidence_revision=request.evidence_revision,
            decision_revision=request.decision_revision,
            token_hash=token_hash,
            payload_fingerprint=payload_fingerprint,
            event_id=event_id,
            actor_id=actor['id'],
            reason=request.reason,
            authority=request.authority.kind,
            authority_label=request.authority.label,
            decision_source=request.decision_source,
            reviewed_at=changed_at,
        )
    else:
        rule_id = stable_uuid(
            space['id'],
            'workflow-rule',
            candidate_id,
            str(request.candidate_version),
        )
        authorization_id = stable_uuid(
            space['id'],
            'workflow-authorization',
            event_id,
        )
        records, _, _ = await store.runtime.driver.execute_query(
            _APPROVE_WORKFLOW_CANDIDATE_QUERY,
            space_id=space['id'],
            candidate_id=candidate_id,
            candidate_version=request.candidate_version,
            evidence_revision=request.evidence_revision,
            decision_revision=request.decision_revision,
            token_hash=token_hash,
            payload_fingerprint=payload_fingerprint,
            rule_id=rule_id,
            authorization_id=authorization_id,
            event_id=event_id,
            actor_id=actor['id'],
            reason=request.reason,
            authority=request.authority.kind,
            authority_label=request.authority.label,
            decision_source=request.decision_source,
            high_risk_action_categories=HIGH_RISK_ACTION_CATEGORIES,
            reviewed_at=changed_at,
        )
    if not records:
        raise HTTPException(
            status_code=409,
            detail=(
                'workflow review token is invalid, expired, used, or bound '
                'to another candidate version'
            ),
        )
    return await _read_workflow_candidate(
        store, actor, space['id'], candidate_id, changed_at
    )


async def _read_workflow_candidate(
    store,
    actor: dict,
    space_id: str,
    candidate_id: str,
    evaluated_at: datetime,
) -> WorkflowCandidate:
    candidates = await _read_workflow_candidates(
        store,
        actor,
        WorkflowCandidateSearch(
            personal_space_id=space_id,
            limit=1,
        ),
        evaluated_at=evaluated_at,
        candidate_id=candidate_id,
    )
    if not candidates:
        raise HTTPException(status_code=404, detail='workflow candidate not found')
    return candidates[0]


async def _read_workflow_candidates(
    store,
    actor: dict,
    request: WorkflowCandidateSearch,
    *,
    evaluated_at: datetime | None,
    candidate_id: str | None = None,
) -> list[WorkflowCandidate]:
    space = await _personal_space(store, actor, request.personal_space_id, 'reader')
    rows, _, _ = await store.runtime.driver.execute_query(
        _WORKFLOW_CANDIDATE_QUERY,
        space_id=space['id'],
        personal_project_id=request.personal_project_id,
        after_step_key=request.after_step_key,
        candidate_id=candidate_id,
        minimum_occurrences=MINIMUM_OCCURRENCES,
        limit=request.limit,
        routing_='r',
    )
    return [
        _candidate(dict(row), evaluated_at=evaluated_at)
        for row in rows
    ]


async def _personal_space(store, actor: dict, space_id: str, role: str) -> dict:
    space = await store.authorize(actor, space_id, role)
    if space['kind'] != 'personal':
        raise HTTPException(status_code=422, detail='workflow candidates are personal-only')
    return space


async def materialize_workflow_candidates(
    store,
    space: dict,
    *,
    personal_project_id: str | None,
    pairs: list[dict],
) -> list[str]:
    if not pairs:
        return []
    rows, _, _ = await store.runtime.driver.execute_query(
        _WORKFLOW_CANDIDATE_EVIDENCE_QUERY,
        group_id=space['group_id'],
        personal_project_id=personal_project_id,
        pairs=pairs,
        routing_='r',
    )
    changed_at = now_utc()
    candidates = []
    for value in (dict(row) for row in rows):
        occurrence_count = int(value.get('occurrence_count') or 0)
        if occurrence_count < MINIMUM_OCCURRENCES:
            continue
        condition_json = value.get('condition_json') or '{}'
        candidate_id = stable_uuid(
            space['id'],
            'workflow-candidate',
            personal_project_id or 'personal-global',
            value['workflow_key'],
            value['source_step_id'],
            value['target_step_id'],
        )
        evidence_ids = sorted(value.get('evidence_ids') or [])
        evidence_fingerprint = stable_uuid(
            'workflow-evidence',
            json.dumps(
                {
                    'occurrence_count': occurrence_count,
                    'distinct_session_count': int(
                        value.get('distinct_session_count') or 0
                    ),
                    'first_observed_at': native_datetime(
                        value['first_observed_at']
                    ).isoformat(),
                    'last_observed_at': native_datetime(
                        value['last_observed_at']
                    ).isoformat(),
                    'confirmation_authority': (
                        value.get('confirmation_authority') or 'none'
                    ),
                    'negative_evidence_count': int(
                        value.get('negative_evidence_count') or 0
                    ),
                    'evidence_ids': evidence_ids,
                },
                ensure_ascii=False,
                separators=(',', ':'),
                sort_keys=True,
            ),
        )
        candidates.append({
            'candidate_id': candidate_id,
            'personal_space_id': space['id'],
            'personal_project_id': personal_project_id,
            'workflow_key': value['workflow_key'],
            'source_step_id': value['source_step_id'],
            'source_step_key': value['source_step_key'],
            'source_step_name': value['source_step_name'],
            'target_step_id': value['target_step_id'],
            'target_step_key': value['target_step_key'],
            'target_step_name': value['target_step_name'],
            'condition_json': condition_json,
            'rule_fingerprint': stable_uuid(
                'workflow-rule',
                value['workflow_key'],
                value['source_step_id'],
                value['target_step_id'],
                condition_json,
            ),
            'evidence_fingerprint': evidence_fingerprint,
            'occurrence_count': occurrence_count,
            'distinct_session_count': int(
                value.get('distinct_session_count') or 0
            ),
            'first_observed_at': value['first_observed_at'],
            'last_observed_at': value['last_observed_at'],
            'confirmation_authority': (
                value.get('confirmation_authority') or 'none'
            ),
            'negative_evidence_count': int(
                value.get('negative_evidence_count') or 0
            ),
            'evidence_ids': evidence_ids,
            'changed_at': changed_at,
        })
    if not candidates:
        return []
    records, _, _ = await store.runtime.driver.execute_query(
        _MATERIALIZE_WORKFLOW_CANDIDATE_QUERY,
        space_id=space['id'],
        candidates=candidates,
    )
    return [record['candidate_id'] for record in records]


def _candidate(row: dict, *, evaluated_at: datetime | None) -> WorkflowCandidate:
    now = evaluated_at or datetime.now(timezone.utc)
    first_observed_at = native_datetime(row['first_observed_at'])
    last_observed_at = native_datetime(row['last_observed_at'])
    age_days = max((now - last_observed_at).total_seconds() / 86_400, 0)
    recency_score = _recency_score(age_days)
    occurrence_count = int(row.get('occurrence_count') or 0)
    distinct_session_count = int(row.get('distinct_session_count') or 0)
    negative_evidence_count = int(row.get('negative_evidence_count') or 0)
    decline_count = int(row.get('decline_count') or 0)
    authority = row.get('confirmation_authority') or 'none'
    candidate_version = int(row.get('candidate_version') or 1)
    evidence_revision = int(row.get('evidence_revision') or 1)
    decision_revision = int(row.get('decision_revision') or 0)
    rule_fingerprint = row.get('rule_fingerprint') or row['candidate_id']
    authorization = _authorization(row)
    execution_authorized = bool(
        authorization
        and authorization.active
        and authorization.candidate_version == candidate_version
        and authorization.rule_fingerprint == rule_fingerprint
    )
    score = _recommendation_score(
        occurrence_count=occurrence_count,
        distinct_session_count=distinct_session_count,
        recency_score=recency_score,
        authority=authority,
        negative_evidence_count=negative_evidence_count,
        decline_count=decline_count,
    )
    recommended = (
        score >= RECOMMENDATION_THRESHOLD
        and distinct_session_count >= MINIMUM_DISTINCT_SESSIONS
    )
    action = (
        'authorized_rule_available'
        if execution_authorized
        else 'ask_user'
        if recommended
        else 'none'
    )
    return WorkflowCandidate(
        candidate_id=row['candidate_id'],
        candidate_version=candidate_version,
        evidence_revision=evidence_revision,
        decision_revision=decision_revision,
        rule_fingerprint=rule_fingerprint,
        workflow_key=(
            row.get('workflow_key')
            or f"{row['source_step_key']}->{row['target_step_key']}"
        ),
        condition=_workflow_condition(row.get('condition_json')),
        personal_space_id=row['personal_space_id'],
        personal_project_id=row.get('personal_project_id'),
        source_step_id=row['source_step_id'],
        source_step_key=row['source_step_key'],
        source_step_name=row['source_step_name'],
        target_step_id=row['target_step_id'],
        target_step_key=row['target_step_key'],
        target_step_name=row['target_step_name'],
        status=row.get('status') or 'pending',
        occurrence_count=occurrence_count,
        distinct_session_count=distinct_session_count,
        recency=WorkflowRecency(
            first_observed_at=first_observed_at,
            last_observed_at=last_observed_at,
            age_days=round(age_days, 4),
            score=recency_score,
        ),
        confirmation_authority=authority,
        negative_evidence_count=negative_evidence_count,
        decline_count=decline_count,
        reviewed_at=native_datetime(row.get('reviewed_at')),
        review_reason=row.get('review_reason'),
        recommendation=WorkflowRecommendation(
            recommended=recommended,
            score=score,
            threshold=RECOMMENDATION_THRESHOLD,
            action=action,
        ),
        execution_authorized=execution_authorized,
        authorization=authorization,
    )


def _authorization(row: dict) -> WorkflowAuthorization | None:
    if not row.get('authorization_id'):
        return None
    return WorkflowAuthorization(
        authorization_id=row['authorization_id'],
        candidate_id=row.get('authorization_candidate_id') or row['candidate_id'],
        candidate_version=int(
            row.get('authorization_candidate_version')
            or row.get('candidate_version')
            or 1
        ),
        rule_id=row.get('authorization_rule_id') or row['authorization_id'],
        rule_fingerprint=(
            row.get('authorization_rule_fingerprint')
            or row.get('rule_fingerprint')
            or row['candidate_id']
        ),
        scope='durable',
        active=row.get('authorization_active') is True,
        authority=row['authorization_authority'],
        created_at=native_datetime(row['authorization_created_at']),
        high_risk_per_call_approval_required=True,
        high_risk_action_categories=(
            row.get('high_risk_action_categories')
            or HIGH_RISK_ACTION_CATEGORIES
        ),
    )


def _recommendation_score(
    *,
    occurrence_count: int,
    distinct_session_count: int,
    recency_score: float,
    authority: str,
    negative_evidence_count: int,
    decline_count: int,
) -> float:
    occurrence_signal = min(occurrence_count / MINIMUM_OCCURRENCES, 1)
    session_signal = min(
        distinct_session_count / MINIMUM_DISTINCT_SESSIONS,
        1,
    )
    authority_signal = 1 if authority in {'user', 'authoritative_source'} else 0
    weighted = (
        occurrence_signal * RECOMMENDATION_WEIGHTS.occurrences
        + session_signal * RECOMMENDATION_WEIGHTS.distinct_sessions
        + recency_score * RECOMMENDATION_WEIGHTS.recency
        + authority_signal * RECOMMENDATION_WEIGHTS.confirmation_authority
    )
    penalty = (
        decline_count * DECLINE_PENALTY
        + negative_evidence_count * NEGATIVE_EVIDENCE_PENALTY
    )
    return round(min(max(weighted - penalty, 0), 1), 4)


def _recency_score(age_days: float) -> float:
    if age_days <= 7:
        return 1
    if age_days <= 30:
        return 0.75
    if age_days <= 90:
        return 0.5
    return 0.25


def _review_payload_fingerprint(
    candidate_id: str,
    request: WorkflowCandidateReviewIntent,
) -> str:
    payload = {
        'candidate_id': candidate_id,
        **request.model_dump(mode='json', exclude={'approval_token'}),
    }
    return _sha256(json.dumps(
        payload,
        ensure_ascii=False,
        separators=(',', ':'),
        sort_keys=True,
    ))


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


def _workflow_condition(value: str | None) -> dict[str, object]:
    try:
        parsed = json.loads(value or '{}')
    except (TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


_WORKFLOW_CANDIDATE_QUERY = '''
MATCH (:FuliSpace {id: $space_id, kind: 'personal'})-
      [:HAS_WORKFLOW_CANDIDATE]->(candidate:FuliWorkflowCandidate)
WHERE candidate.occurrence_count >= $minimum_occurrences
  AND ($candidate_id IS NULL OR candidate.id = $candidate_id)
  AND ($personal_project_id IS NULL OR
       candidate.personal_project_id = $personal_project_id)
  AND ($after_step_key IS NULL OR candidate.source_step_key = $after_step_key)
OPTIONAL MATCH (candidate)-[:HAS_WORKFLOW_AUTHORIZATION]->
              (authorization:FuliWorkflowAuthorization {active: true})
WITH candidate, authorization
ORDER BY authorization.created_at DESC
WITH candidate, head(collect(authorization)) AS authorization
RETURN candidate.id AS candidate_id,
       coalesce(candidate.candidate_version, 1) AS candidate_version,
       coalesce(candidate.evidence_revision, 1) AS evidence_revision,
       coalesce(candidate.decision_revision, 0) AS decision_revision,
       coalesce(candidate.rule_fingerprint, candidate.id) AS rule_fingerprint,
       candidate.workflow_key AS workflow_key,
       coalesce(candidate.condition_json, '{}') AS condition_json,
       candidate.personal_space_id AS personal_space_id,
       candidate.personal_project_id AS personal_project_id,
       candidate.source_step_id AS source_step_id,
       candidate.source_step_key AS source_step_key,
       candidate.source_step_name AS source_step_name,
       candidate.target_step_id AS target_step_id,
       candidate.target_step_key AS target_step_key,
       candidate.target_step_name AS target_step_name,
       coalesce(candidate.status, 'pending') AS status,
       candidate.occurrence_count AS occurrence_count,
       candidate.distinct_session_count AS distinct_session_count,
       candidate.first_observed_at AS first_observed_at,
       candidate.last_observed_at AS last_observed_at,
       coalesce(candidate.confirmation_authority, 'none') AS confirmation_authority,
       coalesce(candidate.negative_evidence_count, 0) AS negative_evidence_count,
       coalesce(candidate.decline_count, 0) AS decline_count,
       candidate.reviewed_at AS reviewed_at,
       candidate.review_reason AS review_reason,
       authorization.id AS authorization_id,
       coalesce(authorization.active, false) AS authorization_active,
       authorization.candidate_id AS authorization_candidate_id,
       authorization.candidate_version AS authorization_candidate_version,
       authorization.rule_id AS authorization_rule_id,
       authorization.rule_fingerprint AS authorization_rule_fingerprint,
       authorization.authority AS authorization_authority,
       authorization.created_at AS authorization_created_at,
       authorization.high_risk_action_categories AS high_risk_action_categories
ORDER BY candidate.last_observed_at DESC, candidate.id
LIMIT $limit
'''


_WORKFLOW_CANDIDATE_REVIEW_TARGET_QUERY = '''
/* WORKFLOW_CANDIDATE_REVIEW_TARGET */
MATCH (:FuliSpace {id: $space_id, kind: 'personal'})-
      [:HAS_WORKFLOW_CANDIDATE]->(candidate:FuliWorkflowCandidate {
        id: $candidate_id
      })
RETURN coalesce(candidate.candidate_version, 1) AS candidate_version,
       coalesce(candidate.evidence_revision, 1) AS evidence_revision,
       coalesce(candidate.decision_revision, 0) AS decision_revision,
       coalesce(candidate.rule_fingerprint, candidate.id) AS rule_fingerprint
'''


_CREATE_WORKFLOW_REVIEW_PREVIEW_QUERY = '''
/* WORKFLOW_REVIEW_PREVIEW_CREATE */
MATCH (space:FuliSpace {id: $space_id, kind: 'personal'})-
      [:HAS_WORKFLOW_CANDIDATE]->(candidate:FuliWorkflowCandidate {
        id: $candidate_id,
        candidate_version: $candidate_version,
        evidence_revision: $evidence_revision,
        decision_revision: $decision_revision,
        rule_fingerprint: $rule_fingerprint
      })
CREATE (preview:FuliWorkflowReviewPreview {
  id: $preview_id,
  candidate_id: $candidate_id,
  candidate_version: $candidate_version,
  evidence_revision: $evidence_revision,
  decision_revision: $decision_revision,
  rule_fingerprint: $rule_fingerprint,
  token_hash: $token_hash,
  payload_fingerprint: $payload_fingerprint,
  issued_to_actor_id: $issued_to_actor_id,
  issued_channel: $issued_channel,
  created_at: $created_at,
  expires_at: $expires_at,
  used_at: null
})
MERGE (candidate)-[:HAS_WORKFLOW_REVIEW_PREVIEW]->(preview)
RETURN preview.id AS preview_id
'''


_WORKFLOW_REVIEW_EVENT_QUERY = '''
/* WORKFLOW_REVIEW_EVENT_LOOKUP */
MATCH (:FuliSpace {id: $space_id, kind: 'personal'})-
      [:HAS_WORKFLOW_CANDIDATE]->(:FuliWorkflowCandidate)-
      [:HAS_WORKFLOW_REVIEW_EVENT]->(event:FuliWorkflowReviewEvent {
        id: $event_id
      })
RETURN event.payload_fingerprint AS payload_fingerprint
'''


_REJECT_WORKFLOW_CANDIDATE_QUERY = '''
/* WORKFLOW_CANDIDATE_REJECT */
MATCH (space:FuliSpace {id: $space_id, kind: 'personal'})-
      [:HAS_WORKFLOW_CANDIDATE]->(candidate:FuliWorkflowCandidate {
        id: $candidate_id
      })
MATCH (candidate)-[:HAS_WORKFLOW_REVIEW_PREVIEW]->
      (preview:FuliWorkflowReviewPreview {
        token_hash: $token_hash
      })
WHERE preview.used_at IS NULL
  AND preview.expires_at >= $reviewed_at
  AND preview.payload_fingerprint = $payload_fingerprint
  AND preview.candidate_version = $candidate_version
  AND preview.evidence_revision = $evidence_revision
  AND preview.decision_revision = $decision_revision
  AND preview.issued_to_actor_id = $actor_id
  AND preview.rule_fingerprint = candidate.rule_fingerprint
SET candidate.review_lock_nonce =
      coalesce(candidate.review_lock_nonce, 0) + 1
WITH candidate, preview
WHERE preview.used_at IS NULL
  AND candidate.candidate_version = $candidate_version
  AND candidate.evidence_revision = $evidence_revision
  AND candidate.decision_revision = $decision_revision
  AND candidate.rule_fingerprint = preview.rule_fingerprint
MERGE (event:FuliWorkflowReviewEvent {id: $event_id})
ON CREATE SET event.candidate_id = $candidate_id,
              event.candidate_version = $candidate_version,
              event.evidence_revision = $evidence_revision,
              event.decision_revision = $decision_revision,
              event.payload_fingerprint = $payload_fingerprint,
              event.decision = 'reject',
              event.reason = $reason,
              event.authority = $authority,
              event.authority_label = $authority_label,
              event.decision_source = $decision_source,
              event.created_at = $reviewed_at,
              preview.used_at = $reviewed_at,
              preview.used_by_event_id = $event_id,
              candidate.status = 'rejected',
              candidate.decision_revision = $decision_revision + 1,
              candidate.decline_count =
                coalesce(candidate.decline_count, 0) + 1,
              candidate.reviewed_at = $reviewed_at,
              candidate.review_reason = $reason,
              candidate.review_authority = $authority
MERGE (candidate)-[:HAS_WORKFLOW_REVIEW_EVENT]->(event)
WITH candidate, event
OPTIONAL MATCH (candidate)-[:HAS_WORKFLOW_AUTHORIZATION]->
              (authorization:FuliWorkflowAuthorization {active: true})
WITH candidate, event, collect(authorization) AS active_authorizations
FOREACH (authorization IN active_authorizations |
  SET authorization.active = false,
      authorization.revoked_at = $reviewed_at,
      authorization.revocation_reason = $reason
)
RETURN event.id AS event_id
'''


_APPROVE_WORKFLOW_CANDIDATE_QUERY = '''
/* WORKFLOW_CANDIDATE_APPROVE */
MATCH (space:FuliSpace {id: $space_id, kind: 'personal'})-
      [:HAS_WORKFLOW_CANDIDATE]->(candidate:FuliWorkflowCandidate {
        id: $candidate_id
      })
MATCH (candidate)-[:HAS_WORKFLOW_REVIEW_PREVIEW]->
      (preview:FuliWorkflowReviewPreview {
        token_hash: $token_hash
      })
WHERE preview.used_at IS NULL
  AND preview.expires_at >= $reviewed_at
  AND preview.payload_fingerprint = $payload_fingerprint
  AND preview.candidate_version = $candidate_version
  AND preview.evidence_revision = $evidence_revision
  AND preview.decision_revision = $decision_revision
  AND preview.issued_to_actor_id = $actor_id
  AND preview.rule_fingerprint = candidate.rule_fingerprint
SET candidate.review_lock_nonce =
      coalesce(candidate.review_lock_nonce, 0) + 1
WITH candidate, preview
WHERE preview.used_at IS NULL
  AND candidate.candidate_version = $candidate_version
  AND candidate.evidence_revision = $evidence_revision
  AND candidate.decision_revision = $decision_revision
  AND candidate.rule_fingerprint = preview.rule_fingerprint
MERGE (event:FuliWorkflowReviewEvent {id: $event_id})
ON CREATE SET event.candidate_id = $candidate_id,
              event.candidate_version = $candidate_version,
              event.evidence_revision = $evidence_revision,
              event.decision_revision = $decision_revision,
              event.payload_fingerprint = $payload_fingerprint,
              event.decision = 'approve',
              event.reason = $reason,
              event.authority = $authority,
              event.authority_label = $authority_label,
              event.decision_source = $decision_source,
              event.created_at = $reviewed_at,
              preview.used_at = $reviewed_at,
              preview.used_by_event_id = $event_id,
              candidate.status = 'approved',
              candidate.decision_revision = $decision_revision + 1,
              candidate.reviewed_at = $reviewed_at,
              candidate.review_reason = $reason,
              candidate.review_authority = $authority
MERGE (candidate)-[:HAS_WORKFLOW_REVIEW_EVENT]->(event)
WITH candidate, event
OPTIONAL MATCH (candidate)-[:HAS_WORKFLOW_AUTHORIZATION]->
              (previous:FuliWorkflowAuthorization {active: true})
WHERE previous IS NULL OR previous.id <> $authorization_id
WITH candidate, event, collect(previous) AS previous_authorizations
FOREACH (previous IN previous_authorizations |
  SET previous.active = false,
      previous.revoked_at = $reviewed_at,
      previous.revocation_reason = 'superseded by a later workflow approval'
)
MERGE (rule:FuliWorkflowRule {id: $rule_id})
ON CREATE SET rule.candidate_id = $candidate_id,
              rule.candidate_version = $candidate_version,
              rule.rule_fingerprint = candidate.rule_fingerprint,
              rule.source_step_id = candidate.source_step_id,
              rule.source_step_key = candidate.source_step_key,
              rule.target_step_id = candidate.target_step_id,
              rule.target_step_key = candidate.target_step_key,
              rule.condition_json = candidate.condition_json,
              rule.created_at = $reviewed_at
MERGE (candidate)-[:MATERIALIZED_AS_WORKFLOW_RULE]->(rule)
MERGE (authorization:FuliWorkflowAuthorization {id: $authorization_id})
ON CREATE SET authorization.candidate_id = $candidate_id,
              authorization.candidate_version = $candidate_version,
              authorization.rule_id = $rule_id,
              authorization.rule_fingerprint = candidate.rule_fingerprint,
              authorization.scope = 'durable',
              authorization.active = true,
              authorization.authority = $authority,
              authorization.authority_label = $authority_label,
              authorization.decision_source = $decision_source,
              authorization.created_at = $reviewed_at,
              authorization.high_risk_per_call_approval_required = true,
              authorization.high_risk_action_categories =
                $high_risk_action_categories
MERGE (candidate)-[:HAS_WORKFLOW_AUTHORIZATION]->(authorization)
MERGE (authorization)-[:AUTHORIZES_WORKFLOW_RULE]->(rule)
RETURN event.id AS event_id
'''


_WORKFLOW_CANDIDATE_EVIDENCE_QUERY = '''
/* WORKFLOW_CANDIDATE_EVIDENCE_AGGREGATION */
UNWIND $pairs AS pair
MATCH (source:Entity {uuid: pair.source_step_id})-
      [evidence:RELATES_TO {
        group_id: $group_id,
        name: 'RECOMMENDS_NEXT'
      }]->(target:Entity {uuid: pair.target_step_id})
WHERE evidence.invalid_at IS NULL
  AND evidence.fuli_key = pair.workflow_key
  AND coalesce(evidence.fuli_workflow_condition_json, '{}') = pair.condition_json
  AND evidence.fuli_workflow_session_authority = 'mcp_host'
WITH pair, source, target, collect(DISTINCT evidence) AS evidence_items
UNWIND evidence_items AS evidence
UNWIND coalesce(evidence.episodes, []) AS episode_id
MATCH (episode:Episodic {uuid: episode_id, group_id: $group_id})
WHERE episode.fuli_workflow_session_authority = 'mcp_host'
  AND (
    episode.fuli_personal_project_id = $personal_project_id
    OR (
      episode.fuli_personal_project_id IS NULL
      AND $personal_project_id IS NULL
    )
  )
WITH pair, source, target,
     collect(DISTINCT evidence) AS evidence_items,
     collect(DISTINCT episode) AS episodes
WITH pair, source, target, episodes,
     CASE
       WHEN any(evidence IN evidence_items
                WHERE evidence.fuli_workflow_confirmation_authority = 'user')
       THEN 'user'
       WHEN any(evidence IN evidence_items
                WHERE evidence.fuli_workflow_confirmation_authority =
                      'authoritative_source')
       THEN 'authoritative_source'
       WHEN any(evidence IN evidence_items
                WHERE evidence.fuli_workflow_confirmation_authority =
                      'agent_proposed')
       THEN 'agent_proposed'
       WHEN any(evidence IN evidence_items
                WHERE evidence.fuli_workflow_confirmation_authority =
                      'import_proposed')
       THEN 'import_proposed'
       ELSE 'none'
     END AS confirmation_authority,
     reduce(
       total = 0,
       evidence IN evidence_items |
         total + coalesce(evidence.fuli_negative_evidence_count, 0)
     ) AS negative_evidence_count,
     [evidence IN evidence_items | evidence.uuid] AS evidence_ids
UNWIND episodes AS episode
RETURN source.uuid AS source_step_id,
       pair.workflow_key AS workflow_key,
       coalesce(source.fuli_key, pair.source_step_key) AS source_step_key,
       source.name AS source_step_name,
       target.uuid AS target_step_id,
       coalesce(target.fuli_key, pair.target_step_key) AS target_step_key,
       target.name AS target_step_name,
       pair.condition_json AS condition_json,
       count(DISTINCT episode.uuid) AS occurrence_count,
       count(DISTINCT episode.fuli_session_id) AS distinct_session_count,
       min(episode.valid_at) AS first_observed_at,
       max(episode.valid_at) AS last_observed_at,
       confirmation_authority,
       negative_evidence_count,
       evidence_ids
'''


_MATERIALIZE_WORKFLOW_CANDIDATE_QUERY = '''
UNWIND $candidates AS row
MATCH (space:FuliSpace {id: $space_id, kind: 'personal'})
MATCH (source:Entity {uuid: row.source_step_id})
MATCH (target:Entity {uuid: row.target_step_id})
MERGE (candidate:FuliWorkflowCandidate {id: row.candidate_id})
ON CREATE SET candidate.status = 'pending',
              candidate.decline_count = 0,
              candidate.candidate_version = 1,
              candidate.evidence_revision = 1,
              candidate.decision_revision = 0,
              candidate.rule_fingerprint = row.rule_fingerprint,
              candidate.evidence_fingerprint = row.evidence_fingerprint,
              candidate.created_at = row.changed_at
WITH space, source, target, candidate, row,
     candidate.rule_fingerprint <> row.rule_fingerprint AS rule_changed,
     candidate.evidence_fingerprint <> row.evidence_fingerprint
       AS evidence_changed
SET candidate.candidate_version =
      CASE WHEN rule_changed
           THEN coalesce(candidate.candidate_version, 1) + 1
           ELSE coalesce(candidate.candidate_version, 1) END,
    candidate.evidence_revision =
      CASE WHEN evidence_changed
           THEN coalesce(candidate.evidence_revision, 1) + 1
           ELSE coalesce(candidate.evidence_revision, 1) END,
    candidate.decision_revision =
      CASE WHEN rule_changed
           THEN coalesce(candidate.decision_revision, 0) + 1
           ELSE coalesce(candidate.decision_revision, 0) END,
    candidate.status =
      CASE WHEN rule_changed THEN 'pending'
           ELSE coalesce(candidate.status, 'pending') END,
    candidate.reviewed_at =
      CASE WHEN rule_changed THEN null ELSE candidate.reviewed_at END,
    candidate.review_reason =
      CASE WHEN rule_changed THEN null ELSE candidate.review_reason END,
    candidate.personal_space_id = row.personal_space_id,
    candidate.personal_project_id = row.personal_project_id,
    candidate.workflow_key = row.workflow_key,
    candidate.source_step_id = row.source_step_id,
    candidate.source_step_key = row.source_step_key,
    candidate.source_step_name = row.source_step_name,
    candidate.target_step_id = row.target_step_id,
    candidate.target_step_key = row.target_step_key,
    candidate.target_step_name = row.target_step_name,
    candidate.condition_json = row.condition_json,
    candidate.rule_fingerprint = row.rule_fingerprint,
    candidate.evidence_fingerprint = row.evidence_fingerprint,
    candidate.occurrence_count = row.occurrence_count,
    candidate.distinct_session_count = row.distinct_session_count,
    candidate.first_observed_at = row.first_observed_at,
    candidate.last_observed_at = row.last_observed_at,
    candidate.confirmation_authority = row.confirmation_authority,
    candidate.negative_evidence_count = row.negative_evidence_count,
    candidate.evidence_ids = row.evidence_ids,
    candidate.updated_at = row.changed_at
WITH space, source, target, candidate, row, rule_changed
OPTIONAL MATCH (candidate)-[:HAS_WORKFLOW_AUTHORIZATION]->
              (authorization:FuliWorkflowAuthorization {active: true})
WITH space, source, target, candidate, row, rule_changed,
     collect(authorization) AS active_authorizations
FOREACH (authorization IN
  CASE WHEN rule_changed THEN active_authorizations ELSE [] END |
  SET authorization.active = false,
      authorization.revoked_at = row.changed_at,
      authorization.revocation_reason = 'workflow rule fingerprint changed'
)
MERGE (space)-[:HAS_WORKFLOW_CANDIDATE]->(candidate)
MERGE (candidate)-[:FROM_WORKFLOW_STEP]->(source)
MERGE (candidate)-[:TO_WORKFLOW_STEP]->(target)
RETURN candidate.id AS candidate_id,
       candidate.candidate_version AS candidate_version,
       candidate.evidence_revision AS evidence_revision
'''
