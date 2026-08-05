import hashlib
import json
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException

from .models import ConfirmationBasis
from .personal_global_preference_models import (
    PersonalGlobalPreferenceDecisionApply,
    PersonalGlobalPreferenceDecisionInspection,
    PersonalGlobalPreferenceDecisionIntent,
    PersonalGlobalPreferenceDecisionPreview,
    PersonalGlobalPreferenceDecisionRecord,
    PersonalGlobalPreferenceDecisionRevision,
    PersonalGlobalPreferenceDecisionStatusRequest,
    PersonalGlobalPreferenceDecisionStatusResult,
    PersonalGlobalPreferenceEligibleTargetScope,
    PersonalGlobalPreferenceScopeOptions,
    PersonalGlobalPreferenceScopeOptionsRequest,
    PersonalGlobalPreferenceSourceSnapshot,
)
from .provider_values import (
    json_object,
    native_datetime,
    now_utc,
    preference_qualifiers,
    stable_uuid,
)


DECISION_PREVIEW_TTL = timedelta(minutes=10)


async def personal_global_preference_scope_options(
    store,
    actor: dict,
    candidate_id: str,
    request: PersonalGlobalPreferenceScopeOptionsRequest,
) -> PersonalGlobalPreferenceScopeOptions:
    space = await _personal_space(
        store,
        actor,
        request.personal_space_id,
        'reader',
    )
    snapshots = await _candidate_source_snapshots(
        store,
        space,
        candidate_id,
        request.source_items,
        request.preference_key,
    )
    eligible_target_scopes = await _eligible_target_scopes(
        store,
        space,
        snapshots,
    )
    return PersonalGlobalPreferenceScopeOptions(
        personal_space_id=space['id'],
        candidate_id=candidate_id,
        candidate_version=_candidate_version(
            snapshots,
            eligible_target_scopes,
        ),
        preference_key=request.preference_key,
        source_snapshots=snapshots,
        eligible_target_scopes=eligible_target_scopes,
    )


async def inspect_personal_global_preference_decision(
    store,
    actor: dict,
    candidate_id: str,
    request: PersonalGlobalPreferenceDecisionIntent,
) -> PersonalGlobalPreferenceDecisionInspection:
    space = await _personal_space(
        store,
        actor,
        request.personal_space_id,
        'reader',
    )
    snapshots, eligible_target_scopes = await _validated_source_snapshots(
        store,
        space,
        candidate_id,
        request,
    )
    current_revision = await _decision_revision(
        store,
        space['id'],
        candidate_id,
    )
    if current_revision != request.decision_revision:
        raise HTTPException(
            status_code=409,
            detail='personal-global decision changed; refresh before reviewing',
        )
    return PersonalGlobalPreferenceDecisionInspection(
        status='human_review_required',
        personal_space_id=space['id'],
        candidate_id=candidate_id,
        candidate_version=request.candidate_version,
        decision_revision=request.decision_revision,
        decision=request.decision,
        preference_key=request.preference_key,
        target_scope=request.target_scope,
        target_project_id=request.target_project_id,
        eligible_target_scopes=eligible_target_scopes,
        payload_fingerprint=_decision_payload_fingerprint(
            candidate_id,
            request,
        ),
        source_snapshots=snapshots,
        required_action=(
            'An independent human-review channel must mint the one-time '
            'approval token for this exact fingerprint.'
        ),
    )


async def preview_personal_global_preference_decision(
    store,
    actor: dict,
    candidate_id: str,
    request: PersonalGlobalPreferenceDecisionIntent,
    *,
    created_at: datetime | None = None,
    token_factory=secrets.token_urlsafe,
) -> PersonalGlobalPreferenceDecisionPreview:
    space = await _personal_space(
        store,
        actor,
        request.personal_space_id,
        'maintainer',
    )
    snapshots, eligible_target_scopes = await _validated_source_snapshots(
        store,
        space,
        candidate_id,
        request,
    )
    issued_at = created_at or now_utc()
    expires_at = issued_at + DECISION_PREVIEW_TTL
    approval_token = token_factory(32)
    token_hash = _sha256(approval_token)
    payload_fingerprint = _decision_payload_fingerprint(candidate_id, request)
    preview_id = stable_uuid(
        space['id'],
        'personal-global-preference-preview',
        token_hash,
    )
    records, _, _ = await store.runtime.driver.execute_query(
        _CREATE_DECISION_PREVIEW_QUERY,
        space_id=space['id'],
        candidate_id=candidate_id,
        candidate_version=request.candidate_version,
        decision_revision=request.decision_revision,
        target_scope=request.target_scope,
        target_project_id=request.target_project_id,
        preview_id=preview_id,
        token_hash=token_hash,
        payload_fingerprint=payload_fingerprint,
        issued_to_actor_id=actor['id'],
        issued_channel='independent_human_review',
        created_at=issued_at,
        expires_at=expires_at,
    )
    if not records:
        raise HTTPException(
            status_code=409,
            detail='personal-global decision changed before preview was created',
        )
    return PersonalGlobalPreferenceDecisionPreview(
        preview_id=preview_id,
        candidate_id=candidate_id,
        candidate_version=request.candidate_version,
        decision_revision=request.decision_revision,
        target_scope=request.target_scope,
        target_project_id=request.target_project_id,
        eligible_target_scopes=eligible_target_scopes,
        payload_fingerprint=payload_fingerprint,
        approval_token=approval_token,
        expires_at=expires_at,
        source_snapshots=snapshots,
    )


async def apply_personal_global_preference_decision(
    store,
    actor: dict,
    candidate_id: str,
    request: PersonalGlobalPreferenceDecisionApply,
    *,
    applied_at: datetime | None = None,
) -> PersonalGlobalPreferenceDecisionRecord:
    space = await _personal_space(
        store,
        actor,
        request.personal_space_id,
        'maintainer',
    )
    payload_fingerprint = _decision_payload_fingerprint(candidate_id, request)
    event_id = stable_uuid(
        space['id'],
        'personal-global-preference-decision-event',
        candidate_id,
        request.candidate_version,
        request.idempotency_key,
    )
    existing_rows, _, _ = await store.runtime.driver.execute_query(
        _DECISION_EVENT_QUERY,
        space_id=space['id'],
        event_id=event_id,
        routing_='r',
    )
    if existing_rows:
        if existing_rows[0].get('payload_fingerprint') != payload_fingerprint:
            raise HTTPException(
                status_code=409,
                detail=(
                    'personal-global decision idempotency key was used for '
                    'another candidate version or payload'
                ),
            )
        return _decision_record(existing_rows[0])

    snapshots, eligible_target_scopes = await _validated_source_snapshots(
        store,
        space,
        candidate_id,
        request,
    )
    changed_at = applied_at or now_utc()
    decision_status = (
        'approved' if request.decision == 'approve' else 'rejected'
    )
    global_assertion_id = (
        stable_uuid(
            space['group_id'],
            'personal-global-preference-assertion',
            event_id,
            payload_fingerprint,
        )
        if request.decision == 'approve'
        else None
    )
    episode_id = (
        stable_uuid(
            space['group_id'],
            'personal-global-preference-episode',
            event_id,
        )
        if global_assertion_id
        else None
    )
    source_uris = sorted({
        uri
        for snapshot in snapshots
        for uri in snapshot.source_uris
    })
    attributes = {
        'candidateId': candidate_id,
        'candidateVersion': request.candidate_version,
        'decisionRevision': request.decision_revision + 1,
        'preferenceKey': request.preference_key,
        'targetScope': request.target_scope,
        'targetProjectId': request.target_project_id,
        'eligibleTargetScopes': [
            scope.model_dump(mode='json')
            for scope in eligible_target_scopes
        ],
        'scopeDecision': decision_status,
        'humanConfirmationReason': request.human_confirmation_reason,
        'sourceItemIds': [item.item_id for item in snapshots],
        'sourceProjectIds': [item.project_id for item in snapshots],
        'sourceUris': source_uris,
        'sourcePreferenceSnapshots': [
            snapshot.model_dump(mode='json') for snapshot in snapshots
        ],
        'searchTerms': [candidate_id, request.candidate_version],
    }
    confirmation_basis = ConfirmationBasis.model_validate({
        'existence_reason': request.human_confirmation_reason,
        'quadrant_reason': request.human_confirmation_reason,
        'proposed_by': {
            'kind': 'user',
            'label': 'Independent human scope review',
        },
        'confirmed_by': {
            'kind': 'user',
            'label': 'Authenticated personal-space maintainer',
        },
        'confirmed_at': request.confirmed_at,
    })
    embedding = (
        await store.runtime.embedder.create(request.global_title)
        if global_assertion_id
        else None
    )
    token_hash = _sha256(request.approval_token)
    records, _, _ = await store.runtime.driver.execute_query(
        _APPLY_DECISION_QUERY,
        space_id=space['id'],
        group_id=space['group_id'],
        candidate_id=candidate_id,
        candidate_version=request.candidate_version,
        decision_revision=request.decision_revision,
        decision_status=decision_status,
        target_scope=request.target_scope,
        target_project_id=request.target_project_id,
        source_project_ids=sorted({
            snapshot.project_id for snapshot in snapshots
        }),
        expected_parent_scopes=[
            {
                'target_project_id': scope.target_project_id,
                'max_distance': scope.max_distance,
            }
            for scope in eligible_target_scopes
            if scope.target_scope == 'parent_project'
        ],
        token_hash=token_hash,
        payload_fingerprint=payload_fingerprint,
        event_id=event_id,
        actor_id=actor['id'],
        global_assertion_id=global_assertion_id,
        episode_id=episode_id,
        global_key=(
            'personal-preference-convergence:'
            f'{candidate_id}:{request.target_scope}:'
            f'{request.target_project_id or "personal-global"}'
        ),
        global_title=request.global_title,
        global_instruction=request.global_instruction,
        profile_aspect=request.profile_aspect,
        preference_scope=(
            'project'
            if request.target_scope == 'parent_project'
            else 'global'
        ),
        preference_project_id=request.target_project_id,
        inheritance_mode=(
            'descendants'
            if request.target_scope == 'parent_project'
            else 'local_only'
        ),
        confirmation_basis_json=json.dumps(
            confirmation_basis.model_dump(mode='json'),
            ensure_ascii=False,
            sort_keys=True,
        ),
        human_confirmation_reason=request.human_confirmation_reason,
        attributes_json=json.dumps(
            attributes,
            ensure_ascii=False,
            sort_keys=True,
        ),
        source_uri=source_uris[0] if source_uris else None,
        session_id=request.session_id,
        source_items=[
            item.model_dump(mode='json') for item in request.source_items
        ],
        source_items_json=json.dumps(
            [item.model_dump(mode='json') for item in request.source_items],
            ensure_ascii=False,
            sort_keys=True,
        ),
        source_snapshots=[
            _source_cas_row(snapshot) for snapshot in snapshots
        ],
        source_snapshots_json=json.dumps(
            [snapshot.model_dump(mode='json') for snapshot in snapshots],
            ensure_ascii=False,
            sort_keys=True,
        ),
        embedding=embedding,
        confirmed_at=request.confirmed_at,
        changed_at=changed_at,
        expires_after=changed_at,
    )
    if not records:
        raise HTTPException(
            status_code=409,
            detail=(
                'personal-global review token is invalid, expired, used, '
                'stale, or another decision won this revision'
            ),
        )
    return _decision_record(records[0])


async def personal_global_preference_decision_status(
    store,
    actor: dict,
    request: PersonalGlobalPreferenceDecisionStatusRequest,
) -> PersonalGlobalPreferenceDecisionStatusResult:
    space = await _personal_space(
        store,
        actor,
        request.personal_space_id,
        'reader',
    )
    rows, _, _ = await store.runtime.driver.execute_query(
        _DECISION_STATUS_QUERY,
        space_id=space['id'],
        candidates=[item.model_dump() for item in request.candidates],
        routing_='r',
    )
    decisions = []
    revisions = []
    for row in rows:
        value = dict(row)
        revisions.append(PersonalGlobalPreferenceDecisionRevision(
            candidate_id=value['candidate_id'],
            decision_revision=int(value.get('decision_revision') or 0),
            current_candidate_version=value.get('current_candidate_version'),
        ))
        if (
            value.get('decision_event_id')
            and value.get('current_candidate_version')
                == value.get('requested_candidate_version')
        ):
            decisions.append(_decision_record(value))
    return PersonalGlobalPreferenceDecisionStatusResult(
        personal_space_id=space['id'],
        decisions=decisions,
        revisions=revisions,
    )


async def _validated_source_snapshots(
    store,
    space: dict,
    candidate_id: str,
    request: PersonalGlobalPreferenceDecisionIntent,
) -> tuple[
    list[PersonalGlobalPreferenceSourceSnapshot],
    list[PersonalGlobalPreferenceEligibleTargetScope],
]:
    snapshots = await _candidate_source_snapshots(
        store,
        space,
        candidate_id,
        request.source_items,
        request.preference_key,
    )
    eligible_target_scopes = await _eligible_target_scopes(
        store,
        space,
        snapshots,
    )
    if _candidate_version(
        snapshots,
        eligible_target_scopes,
    ) != request.candidate_version:
        raise HTTPException(
            status_code=409,
            detail=(
                'candidate source or eligible target scope version changed; '
                'rediscover before reviewing'
            ),
        )
    requested_target = (
        request.target_scope,
        request.target_project_id,
    )
    eligible_targets = {
        (scope.target_scope, scope.target_project_id)
        for scope in eligible_target_scopes
    }
    if requested_target not in eligible_targets:
        raise HTTPException(
            status_code=409,
            detail=(
                'requested target scope is not an active, human-authorized '
                'common scope for every source project'
            ),
        )
    return snapshots, eligible_target_scopes


async def _candidate_source_snapshots(
    store,
    space: dict,
    candidate_id: str,
    source_items,
    requested_preference_key: str,
) -> list[PersonalGlobalPreferenceSourceSnapshot]:
    expected_candidate_id = _candidate_id(
        [item.item_id for item in source_items]
    )
    if candidate_id != expected_candidate_id:
        raise HTTPException(
            status_code=409,
            detail='candidate id does not match the selected source preferences',
        )
    source_refs = [item.model_dump() for item in source_items]
    records = []
    entity_sources = [
        item for item in source_refs if item['item_kind'] == 'entity'
    ]
    relationship_sources = [
        item for item in source_refs if item['item_kind'] == 'relationship'
    ]
    if entity_sources:
        rows, _, _ = await store.runtime.driver.execute_query(
            _SOURCE_ENTITY_QUERY,
            group_id=space['group_id'],
            sources=entity_sources,
            routing_='r',
        )
        records.extend(rows)
    if relationship_sources:
        rows, _, _ = await store.runtime.driver.execute_query(
            _SOURCE_RELATIONSHIP_QUERY,
            group_id=space['group_id'],
            sources=relationship_sources,
            routing_='r',
        )
        records.extend(rows)
    if len(records) != len(source_refs):
        raise HTTPException(
            status_code=409,
            detail='one or more candidate source preferences are missing',
        )
    snapshot_by_key = {}
    for record in records:
        value = dict(record)
        attributes = json_object(value.get('attributes_json'))
        preference_key = (
            attributes.get('preferenceKey')
            or attributes.get('preference_key')
            or value.get('key')
            or value.get('item_id')
        )
        basis = json_object(value.get('confirmation_basis_json'))
        try:
            snapshot = PersonalGlobalPreferenceSourceSnapshot(
                item_id=value['item_id'],
                item_kind=value['item_kind'],
                project_id=value['project_id'],
                key=value.get('key') or value['item_id'],
                preference_key=preference_key,
                preference_qualifiers=preference_qualifiers(attributes),
                title=value.get('title') or value['item_id'],
                instruction=value.get('instruction') or '',
                profile_aspect=value.get('profile_aspect'),
                confirmation_status=value.get('confirmation_status'),
                confirmation_basis=ConfirmationBasis.model_validate(basis),
                human_change_version=int(
                    value.get('human_change_version') or 0
                ),
                usage_generation=int(value.get('usage_generation') or 1),
                last_human_changed_at=native_datetime(
                    value.get('last_human_changed_at')
                ),
                negative_evidence_count=int(
                    value.get('negative_evidence_count') or 0
                ),
                requires_attention=value.get('requires_attention') is True,
                last_feedback_at=native_datetime(
                    value.get('last_feedback_at')
                ),
                source_uris=sorted(set(value.get('source_uris') or [])),
                stored_confirmation_basis_json=(
                    value.get('confirmation_basis_json') or '{}'
                ),
                stored_attributes_json=(
                    value.get('attributes_json') or '{}'
                ),
            )
        except (KeyError, TypeError, ValueError) as error:
            raise HTTPException(
                status_code=409,
                detail='candidate source preference is no longer eligible',
            ) from error
        snapshot_by_key[(snapshot.item_kind, snapshot.item_id)] = snapshot
    snapshots = []
    for reference in source_items:
        snapshot = snapshot_by_key.get(
            (reference.item_kind, reference.item_id)
        )
        if (
            not snapshot
            or snapshot.project_id != reference.project_id
            or snapshot.preference_key != requested_preference_key
            or snapshot.requires_attention
        ):
            raise HTTPException(
                status_code=409,
                detail='candidate source preference is no longer eligible',
            )
        snapshots.append(snapshot)
    snapshots.sort(key=lambda item: item.item_id)
    return snapshots


async def _eligible_target_scopes(
    store,
    space: dict,
    snapshots: list[PersonalGlobalPreferenceSourceSnapshot],
) -> list[PersonalGlobalPreferenceEligibleTargetScope]:
    source_project_ids = sorted({item.project_id for item in snapshots})
    rows, _, _ = await store.runtime.driver.execute_query(
        _ELIGIBLE_PARENT_SCOPE_QUERY,
        space_id=space['id'],
        source_project_ids=source_project_ids,
        source_project_count=len(source_project_ids),
        routing_='r',
    )
    result = [
        PersonalGlobalPreferenceEligibleTargetScope(
            target_scope='parent_project',
            target_project_id=row['target_project_id'],
            max_distance=int(row['max_distance']),
        )
        for row in rows
        if row.get('target_project_id') not in source_project_ids
    ]
    result.sort(key=lambda item: (
        item.max_distance or 0,
        item.target_project_id or '',
    ))
    result.append(PersonalGlobalPreferenceEligibleTargetScope(
        target_scope='personal_global',
    ))
    return result


async def _decision_revision(store, space_id: str, candidate_id: str) -> int:
    rows, _, _ = await store.runtime.driver.execute_query(
        _DECISION_REVISION_QUERY,
        space_id=space_id,
        candidate_id=candidate_id,
        routing_='r',
    )
    return int(rows[0]['decision_revision']) if rows else 0


async def _personal_space(store, actor, space_id: str, role: str) -> dict:
    store._require_personal()
    space = await store.authorize(actor, space_id, role)
    if space['kind'] != 'personal':
        raise HTTPException(
            status_code=422,
            detail='personal-global preference decisions are personal-only',
        )
    return space


def _candidate_id(item_ids: list[str]) -> str:
    digest = _sha256('\n'.join(sorted(item_ids)))[:20]
    return f'personal-global-{digest}'


def _candidate_version(
    snapshots: list[PersonalGlobalPreferenceSourceSnapshot],
    eligible_target_scopes: list[
        PersonalGlobalPreferenceEligibleTargetScope
    ],
) -> str:
    source_state = [{
        'item_id': item.item_id,
        'item_kind': item.item_kind,
        'project_id': item.project_id,
        'key': item.key,
        'preference_key': item.preference_key,
        'preference_qualifiers': item.preference_qualifiers,
        'title': item.title,
        'instruction': item.instruction,
        'profile_aspect': item.profile_aspect,
        'confirmation_status': item.confirmation_status,
        'confirmation_basis': item.confirmation_basis.model_dump(mode='json'),
        'stored_confirmation_basis_json': (
            item.stored_confirmation_basis_json
        ),
        'stored_attributes_json': item.stored_attributes_json,
        'human_change_version': item.human_change_version,
        'usage_generation': item.usage_generation,
        'last_human_changed_at': _json_datetime(item.last_human_changed_at),
        'negative_evidence_count': item.negative_evidence_count,
        'requires_attention': item.requires_attention,
        'last_feedback_at': _json_datetime(item.last_feedback_at),
        'source_uris': sorted(set(item.source_uris)),
    } for item in sorted(snapshots, key=lambda value: value.item_id)]
    candidate_state = {
        'eligible_target_scopes': [
            item.model_dump(mode='json')
            for item in eligible_target_scopes
        ],
        'sources': source_state,
    }
    canonical = json.dumps(
        candidate_state,
        ensure_ascii=False,
        sort_keys=True,
        separators=(',', ':'),
    )
    return f'v1:{_sha256(canonical)[:24]}'


def _decision_payload_fingerprint(
    candidate_id: str,
    request: PersonalGlobalPreferenceDecisionIntent,
) -> str:
    payload = {
        'candidate_id': candidate_id,
        **request.model_dump(
            mode='json',
            exclude={'approval_token'},
        ),
    }
    return _sha256(json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(',', ':'),
    ))


def _source_cas_row(
    snapshot: PersonalGlobalPreferenceSourceSnapshot,
) -> dict:
    return {
        'item_id': snapshot.item_id,
        'item_kind': snapshot.item_kind,
        'project_id': snapshot.project_id,
        'key': snapshot.key,
        'preference_key': snapshot.preference_key,
        'title': snapshot.title,
        'instruction': snapshot.instruction,
        'profile_aspect': snapshot.profile_aspect,
        'confirmation_status': snapshot.confirmation_status,
        'confirmation_basis_json': (
            snapshot.stored_confirmation_basis_json
        ),
        'human_change_version': snapshot.human_change_version,
        'usage_generation': snapshot.usage_generation,
        'last_human_changed_at': snapshot.last_human_changed_at,
        'negative_evidence_count': snapshot.negative_evidence_count,
        'requires_attention': snapshot.requires_attention,
        'last_feedback_at': snapshot.last_feedback_at,
        'source_uris': snapshot.source_uris,
        'attributes_json': snapshot.stored_attributes_json,
    }


def _decision_record(record) -> PersonalGlobalPreferenceDecisionRecord:
    value = dict(record)
    return PersonalGlobalPreferenceDecisionRecord(
        decision_event_id=value['decision_event_id'],
        candidate_id=value['candidate_id'],
        candidate_version=value['candidate_version'],
        decision_revision=int(value['decision_revision']),
        decision=value['decision'],
        target_scope=value.get('target_scope') or 'personal_global',
        target_project_id=value.get('target_project_id'),
        global_assertion_id=value.get('global_assertion_id'),
        global_assertion_active=value.get('global_assertion_active') is True,
        decision_sequence=int(
            value.get('decision_sequence') or value['decision_revision']
        ),
        decided_at=native_datetime(value['decided_at']),
        human_confirmation_reason=value['human_confirmation_reason'],
    )


def _json_datetime(value: datetime | None) -> str | None:
    if value is None:
        return None
    native = native_datetime(value)
    if native.tzinfo is None:
        native = native.replace(tzinfo=timezone.utc)
    return native.astimezone(timezone.utc).isoformat().replace('+00:00', 'Z')


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


_SOURCE_ENTITY_QUERY = '''
/* fuli:personal-global-source-entities */
UNWIND $sources AS source
MATCH (item:Entity {
  group_id: $group_id,
  uuid: source.item_id
})
WHERE item.fuli_invalid_at IS NULL
  AND item.fuli_profile_aspect IS NOT NULL
  AND item.fuli_preference_scope = 'project'
  AND item.fuli_preference_project_id = source.project_id
  AND coalesce(item.fuli_confirmation_status, 'pending')
      IN ['confirmed', 'agent_confirmed']
OPTIONAL MATCH (episode:Episodic {group_id: $group_id})-[:MENTIONS]->(item)
WITH source, item,
     [uri IN collect(DISTINCT episode.fuli_source_uri)
      WHERE uri IS NOT NULL] AS source_uris
RETURN item.uuid AS item_id,
       'entity' AS item_kind,
       item.fuli_preference_project_id AS project_id,
       coalesce(item.fuli_key, item.uuid) AS key,
       item.name AS title,
       coalesce(item.summary, '') AS instruction,
       item.fuli_profile_aspect AS profile_aspect,
       item.fuli_confirmation_status AS confirmation_status,
       item.fuli_confirmation_basis_json AS confirmation_basis_json,
       coalesce(item.fuli_human_change_version, 0) AS human_change_version,
       coalesce(item.fuli_usage_generation, 1) AS usage_generation,
       item.fuli_last_human_changed_at AS last_human_changed_at,
       coalesce(item.fuli_negative_evidence_count, 0)
         AS negative_evidence_count,
       coalesce(item.fuli_requires_attention, false) AS requires_attention,
       item.fuli_last_feedback_at AS last_feedback_at,
       item.fuli_attributes_json AS attributes_json,
       source_uris
'''


_SOURCE_RELATIONSHIP_QUERY = '''
/* fuli:personal-global-source-relationships */
UNWIND $sources AS source
MATCH ()-[item:RELATES_TO {
  group_id: $group_id,
  uuid: source.item_id
}]->()
WHERE item.invalid_at IS NULL
  AND item.fuli_profile_aspect IS NOT NULL
  AND item.fuli_preference_scope = 'project'
  AND item.fuli_preference_project_id = source.project_id
  AND coalesce(item.fuli_confirmation_status, 'pending')
      IN ['confirmed', 'agent_confirmed']
OPTIONAL MATCH (episode:Episodic {group_id: $group_id})
WHERE episode.uuid IN coalesce(item.episodes, [])
WITH source, item,
     [uri IN collect(DISTINCT episode.fuli_source_uri)
      WHERE uri IS NOT NULL] AS source_uris
RETURN item.uuid AS item_id,
       'relationship' AS item_kind,
       item.fuli_preference_project_id AS project_id,
       coalesce(item.fuli_key, item.uuid) AS key,
       coalesce(item.name, 'Preference relationship') AS title,
       coalesce(item.fact, '') AS instruction,
       item.fuli_profile_aspect AS profile_aspect,
       item.fuli_confirmation_status AS confirmation_status,
       item.fuli_confirmation_basis_json AS confirmation_basis_json,
       coalesce(item.fuli_human_change_version, 0) AS human_change_version,
       coalesce(item.fuli_usage_generation, 1) AS usage_generation,
       item.fuli_last_human_changed_at AS last_human_changed_at,
       coalesce(item.fuli_negative_evidence_count, 0)
         AS negative_evidence_count,
       coalesce(item.fuli_requires_attention, false) AS requires_attention,
       item.fuli_last_feedback_at AS last_feedback_at,
       item.fuli_attributes_json AS attributes_json,
       source_uris
'''


_ELIGIBLE_PARENT_SCOPE_QUERY = '''
/* fuli:personal-global-eligible-parent-scopes */
UNWIND $source_project_ids AS source_project_id
MATCH (space:FuliSpace {id: $space_id, kind: 'personal'})
      -[:CONTAINS_PROJECT]->
      (source:FuliPersonalProject {project_id: source_project_id})
MATCH path=(source)-[:PERSONAL_PROJECT_RELATION*1..2]->
      (target:FuliPersonalProject)
WHERE all(relation IN relationships(path)
          WHERE relation.relation_type = 'PART_OF'
            AND relation.status = 'active'
            AND relation.confirmation_authority = 'human_review')
  AND EXISTS {
    MATCH (space)-[:CONTAINS_PROJECT]->(target)
  }
  AND NOT target.project_id IN $source_project_ids
WITH target, source_project_id, min(length(path)) AS distance
WITH target,
     collect(DISTINCT source_project_id) AS covered_source_project_ids,
     max(distance) AS max_distance
WHERE size(covered_source_project_ids) = $source_project_count
RETURN target.project_id AS target_project_id,
       max_distance
ORDER BY max_distance ASC, target_project_id ASC
'''


_DECISION_REVISION_QUERY = '''
/* fuli:personal-global-decision-revision */
MATCH (decision:FuliPersonalGlobalPreferenceDecision {
  space_id: $space_id,
  candidate_id: $candidate_id
})
RETURN coalesce(decision.decision_revision, 0) AS decision_revision
'''


_CREATE_DECISION_PREVIEW_QUERY = '''
/* fuli:create-personal-global-decision-preview */
MATCH (space:FuliSpace {id: $space_id, kind: 'personal'})
MERGE (decision:FuliPersonalGlobalPreferenceDecision {
  space_id: $space_id,
  candidate_id: $candidate_id
})
ON CREATE SET decision.decision_revision = 0,
              decision.created_at = $created_at
WITH space, decision
WHERE decision.decision_revision = $decision_revision
CREATE (preview:FuliPersonalGlobalPreferenceDecisionPreview {
  id: $preview_id,
  space_id: $space_id,
  candidate_id: $candidate_id,
  candidate_version: $candidate_version,
  decision_revision: $decision_revision,
  target_scope: $target_scope,
  target_project_id: $target_project_id,
  token_hash: $token_hash,
  payload_fingerprint: $payload_fingerprint,
  issued_to_actor_id: $issued_to_actor_id,
  issued_channel: $issued_channel,
  created_at: $created_at,
  expires_at: $expires_at,
  used_at: null
})
RETURN preview.id AS preview_id
'''


_DECISION_EVENT_QUERY = '''
/* fuli:personal-global-decision-event */
MATCH (event:FuliPersonalGlobalPreferenceDecisionEvent {
  space_id: $space_id,
  id: $event_id
})
OPTIONAL MATCH (current:FuliPersonalGlobalPreferenceDecision {
  space_id: $space_id,
  candidate_id: event.candidate_id,
  current_event_id: event.id
})
OPTIONAL MATCH (assertion:Entity {uuid: event.global_assertion_id})
RETURN event.id AS decision_event_id,
       event.payload_fingerprint AS payload_fingerprint,
       event.candidate_id AS candidate_id,
       event.candidate_version AS candidate_version,
       event.decision_revision AS decision_revision,
       event.decision AS decision,
       coalesce(event.target_scope, 'personal_global') AS target_scope,
       event.target_project_id AS target_project_id,
       event.global_assertion_id AS global_assertion_id,
       current IS NOT NULL
         AND event.global_assertion_id IS NOT NULL
         AND assertion IS NOT NULL
         AND assertion.fuli_invalid_at IS NULL AS global_assertion_active,
       event.decision_revision AS decision_sequence,
       event.decided_at AS decided_at,
       event.human_confirmation_reason AS human_confirmation_reason
'''


_APPLY_DECISION_QUERY = '''
/* fuli:apply-personal-global-decision */
MATCH (space:FuliSpace {id: $space_id, kind: 'personal'})
MATCH (current:FuliPersonalGlobalPreferenceDecision {
  space_id: $space_id,
  candidate_id: $candidate_id
})
SET current.cas_lock = coalesce(current.cas_lock, 0) + 1
WITH space, current
WHERE current.decision_revision = $decision_revision
MATCH (preview:FuliPersonalGlobalPreferenceDecisionPreview {
  space_id: $space_id,
  candidate_id: $candidate_id,
  candidate_version: $candidate_version,
  decision_revision: $decision_revision,
  token_hash: $token_hash,
  payload_fingerprint: $payload_fingerprint
})
WHERE preview.used_at IS NULL
  AND preview.expires_at > $expires_after
  AND preview.issued_to_actor_id = $actor_id
CALL {
  WITH space
  UNWIND [source IN $source_snapshots
          WHERE source.item_kind = 'entity'] AS source
  OPTIONAL MATCH (item:Entity {
    group_id: $group_id,
    uuid: source.item_id
  })
  OPTIONAL MATCH (episode:Episodic {group_id: $group_id})-[:MENTIONS]->(item)
  WITH source, item,
       [uri IN collect(DISTINCT episode.fuli_source_uri)
        WHERE uri IS NOT NULL] AS current_source_uris
  WHERE item.fuli_invalid_at IS NULL
    AND item.fuli_preference_scope = 'project'
    AND item.fuli_preference_project_id = source.project_id
    AND coalesce(item.fuli_key, item.uuid) = source.key
    AND item.name = source.title
    AND coalesce(item.summary, '') = source.instruction
    AND item.fuli_profile_aspect = source.profile_aspect
    AND item.fuli_confirmation_status = source.confirmation_status
    AND coalesce(item.fuli_confirmation_basis_json, '{}') =
        source.confirmation_basis_json
    AND coalesce(item.fuli_human_change_version, 0) =
        source.human_change_version
    AND coalesce(item.fuli_usage_generation, 1) = source.usage_generation
    AND (
      item.fuli_last_human_changed_at = source.last_human_changed_at
      OR (
        item.fuli_last_human_changed_at IS NULL
        AND source.last_human_changed_at IS NULL
      )
    )
    AND coalesce(item.fuli_negative_evidence_count, 0) =
        source.negative_evidence_count
    AND coalesce(item.fuli_requires_attention, false) =
        source.requires_attention
    AND (
      item.fuli_last_feedback_at = source.last_feedback_at
      OR (
        item.fuli_last_feedback_at IS NULL
        AND source.last_feedback_at IS NULL
      )
    )
    AND coalesce(item.fuli_attributes_json, '{}') = source.attributes_json
    AND size(current_source_uris) = size(source.source_uris)
    AND all(uri IN current_source_uris WHERE uri IN source.source_uris)
  RETURN count(item) AS valid_entity_count
}
CALL {
  WITH space
  UNWIND [source IN $source_snapshots
          WHERE source.item_kind = 'relationship'] AS source
  OPTIONAL MATCH ()-[item:RELATES_TO {
    group_id: $group_id,
    uuid: source.item_id
  }]->()
  OPTIONAL MATCH (episode:Episodic {group_id: $group_id})
  WHERE episode.uuid IN coalesce(item.episodes, [])
  WITH source, item,
       [uri IN collect(DISTINCT episode.fuli_source_uri)
        WHERE uri IS NOT NULL] AS current_source_uris
  WHERE item.invalid_at IS NULL
    AND item.fuli_preference_scope = 'project'
    AND item.fuli_preference_project_id = source.project_id
    AND coalesce(item.fuli_key, item.uuid) = source.key
    AND coalesce(item.name, 'Preference relationship') = source.title
    AND coalesce(item.fact, '') = source.instruction
    AND item.fuli_profile_aspect = source.profile_aspect
    AND item.fuli_confirmation_status = source.confirmation_status
    AND coalesce(item.fuli_confirmation_basis_json, '{}') =
        source.confirmation_basis_json
    AND coalesce(item.fuli_human_change_version, 0) =
        source.human_change_version
    AND coalesce(item.fuli_usage_generation, 1) = source.usage_generation
    AND (
      item.fuli_last_human_changed_at = source.last_human_changed_at
      OR (
        item.fuli_last_human_changed_at IS NULL
        AND source.last_human_changed_at IS NULL
      )
    )
    AND coalesce(item.fuli_negative_evidence_count, 0) =
        source.negative_evidence_count
    AND coalesce(item.fuli_requires_attention, false) =
        source.requires_attention
    AND (
      item.fuli_last_feedback_at = source.last_feedback_at
      OR (
        item.fuli_last_feedback_at IS NULL
        AND source.last_feedback_at IS NULL
      )
    )
    AND coalesce(item.fuli_attributes_json, '{}') = source.attributes_json
    AND size(current_source_uris) = size(source.source_uris)
    AND all(uri IN current_source_uris WHERE uri IN source.source_uris)
  RETURN count(item) AS valid_relationship_count
}
CALL {
  WITH space
  UNWIND $source_project_ids AS source_project_id
  MATCH (space)-[:CONTAINS_PROJECT]->
        (source:FuliPersonalProject {project_id: source_project_id})
  MATCH path=(source)-[:PERSONAL_PROJECT_RELATION*1..2]->
        (target:FuliPersonalProject)
  WHERE all(relation IN relationships(path)
            WHERE relation.relation_type = 'PART_OF'
              AND relation.status = 'active'
              AND relation.confirmation_authority = 'human_review')
    AND EXISTS {
      MATCH (space)-[:CONTAINS_PROJECT]->(target)
    }
    AND NOT target.project_id IN $source_project_ids
  WITH target, source_project_id, min(length(path)) AS distance
  WITH target,
       collect(DISTINCT source_project_id) AS covered_source_project_ids,
       max(distance) AS max_distance
  WHERE size(covered_source_project_ids) = size($source_project_ids)
  WITH {
    target_project_id: target.project_id,
    max_distance: max_distance
  } AS option
  ORDER BY option.max_distance ASC, option.target_project_id ASC
  RETURN collect(option) AS current_parent_scopes
}
WITH space, preview, current, valid_entity_count,
     valid_relationship_count, current_parent_scopes
WHERE valid_entity_count = size([
        source IN $source_snapshots WHERE source.item_kind = 'entity'
      ])
  AND valid_relationship_count = size([
        source IN $source_snapshots WHERE source.item_kind = 'relationship'
      ])
  AND current_parent_scopes = $expected_parent_scopes
OPTIONAL MATCH (old_assertion:Entity {
  uuid: current.global_assertion_id,
  group_id: $group_id
})
SET preview.used_at = $changed_at
FOREACH (_ IN CASE WHEN old_assertion IS NULL THEN [] ELSE [1] END |
  SET old_assertion.fuli_invalid_at = $changed_at,
      old_assertion.expired_at = $changed_at
)
SET current.candidate_version = $candidate_version,
    current.decision_revision = $decision_revision + 1,
    current.decision = $decision_status,
    current.target_scope = $target_scope,
    current.target_project_id = $target_project_id,
    current.global_assertion_id = $global_assertion_id,
    current.current_event_id = $event_id,
    current.updated_at = $changed_at
CREATE (event:FuliPersonalGlobalPreferenceDecisionEvent {
  id: $event_id,
  space_id: $space_id,
  candidate_id: $candidate_id,
  candidate_version: $candidate_version,
  decision_revision: $decision_revision + 1,
  decision: $decision_status,
  target_scope: $target_scope,
  target_project_id: $target_project_id,
  payload_fingerprint: $payload_fingerprint,
  global_assertion_id: $global_assertion_id,
  decided_by_actor_id: $actor_id,
  decision_channel: 'independent_human_review_token',
  human_confirmation_reason: $human_confirmation_reason,
  source_items_json: $source_items_json,
  source_snapshots_json: $source_snapshots_json,
  decided_at: $confirmed_at,
  recorded_at: $changed_at
})
FOREACH (_ IN CASE WHEN $global_assertion_id IS NULL THEN [] ELSE [1] END |
  MERGE (assertion:Entity {uuid: $global_assertion_id})
  ON CREATE SET assertion.group_id = $group_id,
                assertion.name = $global_title,
                assertion.name_embedding = $embedding,
                assertion.summary = $global_instruction,
                assertion.created_at = $changed_at,
                assertion.fuli_key = $global_key,
                assertion.fuli_type = 'PersonalPreference',
                assertion.fuli_origin_quadrant = 'known_known',
                assertion.fuli_current_quadrant = 'known_known',
                assertion.fuli_epistemic_status = 'confirmed',
                assertion.fuli_confirmation_status = 'confirmed',
                assertion.fuli_confirmation_basis_json =
                  $confirmation_basis_json,
                assertion.fuli_reasoning_summary =
                  $human_confirmation_reason,
                assertion.fuli_profile_aspect = $profile_aspect,
                assertion.fuli_preference_scope = $preference_scope,
                assertion.fuli_preference_project_id =
                  $preference_project_id,
                assertion.fuli_inheritance_mode = $inheritance_mode,
                assertion.fuli_inherited_project_ids = [],
                assertion.fuli_attributes_json = $attributes_json,
                assertion.fuli_utility_score = 0.0,
                assertion.fuli_confidence_score = 1.0,
                assertion.fuli_qualified_use_count = 0,
                assertion.fuli_distinct_task_count = 0,
                assertion.fuli_usage_generation = 1,
                assertion.fuli_invalid_at = null
  MERGE (episode:Episodic {uuid: $episode_id})
  ON CREATE SET episode.group_id = $group_id,
                episode.name = 'Personal-global preference human review',
                episode.source = 'json',
                episode.source_description = $human_confirmation_reason,
                episode.content = '',
                episode.valid_at = $confirmed_at,
                episode.created_at = $changed_at,
                episode.entity_edges = [],
                episode.fuli_session_id = $session_id,
                episode.fuli_source_kind = 'human_scope_decision',
                episode.fuli_source_uri = $source_uri,
                episode.fuli_summary = $global_instruction,
                episode.fuli_sensitivity = 'private',
                episode.fuli_personal_project_id =
                  $preference_project_id,
                episode.fuli_idempotency_key = $event_id
  MERGE (episode)-[mention:MENTIONS]->(assertion)
  ON CREATE SET mention.uuid = $event_id + ':mention',
                mention.group_id = $group_id,
                mention.created_at = $changed_at
)
RETURN event.id AS decision_event_id,
       event.candidate_id AS candidate_id,
       event.candidate_version AS candidate_version,
       event.decision_revision AS decision_revision,
       event.decision AS decision,
       event.target_scope AS target_scope,
       event.target_project_id AS target_project_id,
       event.global_assertion_id AS global_assertion_id,
       event.global_assertion_id IS NOT NULL AS global_assertion_active,
       event.decision_revision AS decision_sequence,
       event.decided_at AS decided_at,
       event.human_confirmation_reason AS human_confirmation_reason
'''


_DECISION_STATUS_QUERY = '''
/* fuli:personal-global-decision-status */
UNWIND $candidates AS requested
OPTIONAL MATCH (current:FuliPersonalGlobalPreferenceDecision {
  space_id: $space_id,
  candidate_id: requested.candidate_id
})
OPTIONAL MATCH (event:FuliPersonalGlobalPreferenceDecisionEvent {
  space_id: $space_id,
  id: current.current_event_id
})
OPTIONAL MATCH (assertion:Entity {uuid: current.global_assertion_id})
RETURN event.id AS decision_event_id,
       requested.candidate_id AS candidate_id,
       requested.candidate_version AS requested_candidate_version,
       current.candidate_version AS current_candidate_version,
       requested.candidate_version AS candidate_version,
       coalesce(current.decision_revision, 0) AS decision_revision,
       current.decision AS decision,
       coalesce(event.target_scope, current.target_scope,
                'personal_global') AS target_scope,
       coalesce(event.target_project_id,
                current.target_project_id) AS target_project_id,
       current.global_assertion_id AS global_assertion_id,
       current.decision = 'approved'
         AND assertion IS NOT NULL
         AND assertion.fuli_invalid_at IS NULL AS global_assertion_active,
       current.decision_revision AS decision_sequence,
       event.decided_at AS decided_at,
       event.human_confirmation_reason AS human_confirmation_reason
ORDER BY current.updated_at DESC
'''
