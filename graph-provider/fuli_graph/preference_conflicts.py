import json
from datetime import datetime, timezone

from fastapi import HTTPException

from .knowledge_management import (
    _read_item,
    revise_knowledge_item,
    set_preference_scope,
)
from .models import (
    KnowledgeRevisionCreate,
    PreferenceConflictCompleteCreate,
    PreferenceConflictDeferCreate,
    PreferenceConflictRecord,
    PreferenceConflictResolveCreate,
    PreferenceScopeChange,
)
from .provider_values import native_datetime as _native_datetime


async def defer_preference_conflict(
    store,
    actor: dict,
    request: PreferenceConflictDeferCreate,
) -> PreferenceConflictRecord:
    space = await _authorize_personal_space(
        store,
        actor,
        request.personal_space_id,
        'maintainer',
    )
    left = await _active_preference_item(
        store,
        space,
        request.left_item_id,
        request.left_item_kind,
    )
    right = await _active_preference_item(
        store,
        space,
        request.right_item_id,
        request.right_item_kind,
    )
    _validate_pair_scope(left, right, request)
    deferred_at = datetime.now(timezone.utc)
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (space:FuliSpace {id: $space_id, kind: 'personal'})
        MERGE (conflict:FuliPreferenceConflict {id: $conflict_id})
        ON CREATE SET conflict.personal_space_id = $space_id,
                      conflict.preference_key = $preference_key,
                      conflict.preference_scope = $preference_scope,
                      conflict.preference_project_id = $preference_project_id,
                      conflict.left_item_id = $left_item_id,
                      conflict.left_item_kind = $left_item_kind,
                      conflict.right_item_id = $right_item_id,
                      conflict.right_item_kind = $right_item_kind,
                      conflict.created_at = $deferred_at
        SET conflict.status = 'ai_pending',
            conflict.requested_by = $requested_by,
            conflict.reason = $reason,
            conflict.resolution = NULL,
            conflict.resolved_by = NULL,
            conflict.resolution_reason = NULL,
            conflict.resolved_at = NULL,
            conflict.deferred_at = $deferred_at,
            conflict.updated_at = $deferred_at
        MERGE (space)-[:HAS_PREFERENCE_CONFLICT]->(conflict)
        RETURN conflict
        ''',
        space_id=space['id'],
        conflict_id=request.conflict_id,
        preference_key=request.preference_key,
        preference_scope=request.preference_scope,
        preference_project_id=request.preference_project_id,
        left_item_id=request.left_item_id,
        left_item_kind=request.left_item_kind,
        right_item_id=request.right_item_id,
        right_item_kind=request.right_item_kind,
        requested_by=request.operation_actor,
        reason=request.reason,
        deferred_at=deferred_at,
    )
    return _record(records[0]['conflict'])


async def list_preference_conflicts(
    store,
    actor: dict,
    personal_space_id: str,
    *,
    status: str | None = None,
    limit: int = 500,
) -> list[PreferenceConflictRecord]:
    await _authorize_personal_space(
        store,
        actor,
        personal_space_id,
        'reader',
    )
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (:FuliSpace {id: $space_id, kind: 'personal'})-
              [:HAS_PREFERENCE_CONFLICT]->(conflict:FuliPreferenceConflict)
        WHERE $status IS NULL OR conflict.status = $status
        RETURN conflict
        ORDER BY conflict.updated_at DESC
        LIMIT $limit
        ''',
        space_id=personal_space_id,
        status=status,
        limit=min(max(limit, 1), 1000),
        routing_='r',
    )
    return [_record(record['conflict']) for record in records]


async def resolve_preference_conflict(
    store,
    actor: dict,
    conflict_id: str,
    request: PreferenceConflictResolveCreate,
) -> PreferenceConflictRecord:
    space = await _authorize_personal_space(
        store,
        actor,
        request.personal_space_id,
        'maintainer',
    )
    conflict = await _read_conflict(store, space['id'], conflict_id)
    if conflict.status == 'resolved':
        return conflict
    if conflict.status != 'ai_pending':
        raise HTTPException(status_code=409, detail='preference conflict is not queued for AI')

    left = await _active_preference_item(
        store,
        space,
        conflict.left_item_id,
        conflict.left_item_kind,
    )
    right = await _active_preference_item(
        store,
        space,
        conflict.right_item_id,
        conflict.right_item_kind,
    )

    if request.resolution == 'merge':
        await _merge_items(store, actor, space, conflict, left, right, request)
    elif request.resolution in {'keep_left', 'keep_right'}:
        await _keep_one_item(store, actor, conflict, request)
    else:
        await _split_scope(store, actor, space, conflict, left, right, request)

    return await _complete(
        store,
        space['id'],
        conflict_id,
        request.resolution,
        request.reason,
        request.operation_actor,
    )


async def complete_preference_conflict(
    store,
    actor: dict,
    conflict_id: str,
    request: PreferenceConflictCompleteCreate,
) -> PreferenceConflictRecord:
    space = await _authorize_personal_space(
        store,
        actor,
        request.personal_space_id,
        'maintainer',
    )
    await _read_conflict(store, space['id'], conflict_id)
    return await _complete(
        store,
        space['id'],
        conflict_id,
        request.resolution,
        request.reason,
        request.operation_actor,
    )


async def _merge_items(store, actor, space, conflict, left, right, request):
    if request.canonical_item_id not in {
        conflict.left_item_id,
        conflict.right_item_id,
    }:
        raise HTTPException(
            status_code=422,
            detail='canonical item must belong to the deferred conflict',
        )
    canonical_is_left = request.canonical_item_id == conflict.left_item_id
    canonical_kind = (
        conflict.left_item_kind if canonical_is_left else conflict.right_item_kind
    )
    canonical = left if canonical_is_left else right
    historical_id = (
        conflict.right_item_id if canonical_is_left else conflict.left_item_id
    )
    historical_kind = (
        conflict.right_item_kind if canonical_is_left else conflict.left_item_kind
    )
    confirmation = _preserved_confirmation(canonical)
    update = {
        'personal_space_id': space['id'],
        'item_kind': canonical_kind,
        'action': 'update',
        'reason': request.reason,
        'operation_actor': request.operation_actor,
    }
    if canonical_kind == 'entity':
        update['summary'] = request.merged_instruction
    else:
        update['fact'] = request.merged_instruction
    if confirmation:
        update.update(confirmation)
    await revise_knowledge_item(
        store,
        actor,
        request.canonical_item_id,
        KnowledgeRevisionCreate(**update),
    )
    await revise_knowledge_item(
        store,
        actor,
        historical_id,
        KnowledgeRevisionCreate(
            personal_space_id=space['id'],
            item_kind=historical_kind,
            action='invalidate',
            reason=request.reason,
            replacement_item_id=request.canonical_item_id,
            replacement_item_kind=canonical_kind,
            operation_actor=request.operation_actor,
        ),
    )


async def _keep_one_item(store, actor, conflict, request):
    keep_left = request.resolution == 'keep_left'
    kept_id = conflict.left_item_id if keep_left else conflict.right_item_id
    kept_kind = conflict.left_item_kind if keep_left else conflict.right_item_kind
    historical_id = conflict.right_item_id if keep_left else conflict.left_item_id
    historical_kind = (
        conflict.right_item_kind if keep_left else conflict.left_item_kind
    )
    await revise_knowledge_item(
        store,
        actor,
        historical_id,
        KnowledgeRevisionCreate(
            personal_space_id=request.personal_space_id,
            item_kind=historical_kind,
            action='invalidate',
            reason=request.reason,
            replacement_item_id=kept_id,
            replacement_item_kind=kept_kind,
            operation_actor=request.operation_actor,
        ),
    )


async def _split_scope(store, actor, space, conflict, left, right, request):
    if request.split_item_id not in {
        conflict.left_item_id,
        conflict.right_item_id,
    }:
        raise HTTPException(
            status_code=422,
            detail='split item must belong to the deferred conflict',
        )
    split_left = request.split_item_id == conflict.left_item_id
    item_kind = conflict.left_item_kind if split_left else conflict.right_item_kind
    item = left if split_left else right
    if (
        item.get('preference_scope') == 'project'
        and item.get('preference_project_id') == request.split_project_id
    ):
        return
    await set_preference_scope(
        store,
        actor,
        request.split_item_id,
        PreferenceScopeChange(
            personal_space_id=space['id'],
            item_kind=item_kind,
            scope='project',
            project_id=request.split_project_id,
            reason=request.reason,
            operation_actor=request.operation_actor,
        ),
    )


async def _complete(
    store,
    space_id,
    conflict_id,
    resolution,
    reason,
    resolved_by,
):
    resolved_at = datetime.now(timezone.utc)
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (:FuliSpace {id: $space_id, kind: 'personal'})-
              [:HAS_PREFERENCE_CONFLICT]->
              (conflict:FuliPreferenceConflict {id: $conflict_id})
        SET conflict.status = 'resolved',
            conflict.resolution = $resolution,
            conflict.resolved_by = $resolved_by,
            conflict.resolution_reason = $reason,
            conflict.resolved_at = $resolved_at,
            conflict.updated_at = $resolved_at
        RETURN conflict
        ''',
        space_id=space_id,
        conflict_id=conflict_id,
        resolution=resolution,
        resolved_by=resolved_by,
        reason=reason,
        resolved_at=resolved_at,
    )
    if not records:
        raise HTTPException(status_code=404, detail='preference conflict not found')
    return _record(records[0]['conflict'])


async def _read_conflict(store, space_id, conflict_id):
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (:FuliSpace {id: $space_id, kind: 'personal'})-
              [:HAS_PREFERENCE_CONFLICT]->
              (conflict:FuliPreferenceConflict {id: $conflict_id})
        RETURN conflict
        ''',
        space_id=space_id,
        conflict_id=conflict_id,
        routing_='r',
    )
    if not records:
        raise HTTPException(status_code=404, detail='preference conflict not found')
    return _record(records[0]['conflict'])


async def _active_preference_item(store, space, item_id, item_kind):
    item = await _read_item(store, space, item_id, item_kind)
    if item is None:
        raise HTTPException(status_code=404, detail='preference item not found')
    if item.get('invalid_at'):
        raise HTTPException(status_code=409, detail='historical preference cannot be queued')
    if not item.get('profile_aspect'):
        raise HTTPException(status_code=422, detail='item is not a collaboration preference')
    return item


def _validate_pair_scope(left, right, request):
    left_scope = left.get('preference_scope') or 'global'
    right_scope = right.get('preference_scope') or 'global'
    if left_scope != right_scope or left_scope != request.preference_scope:
        raise HTTPException(status_code=409, detail='preference scopes no longer match')
    if (
        left.get('preference_project_id') != right.get('preference_project_id')
        or left.get('preference_project_id') != request.preference_project_id
    ):
        raise HTTPException(status_code=409, detail='preference projects no longer match')


def _preserved_confirmation(item):
    if item.get('confirmation_status') != 'confirmed':
        return {}
    value = item.get('confirmation_basis_json')
    if not value:
        return {}
    basis = json.loads(value) if isinstance(value, str) else value
    if not basis.get('confirmed_by') or not basis.get('confirmed_at'):
        return {}
    return {
        'confirmation_status': 'confirmed',
        'confirmation_basis': basis,
    }


async def _authorize_personal_space(store, actor, space_id, role):
    store._require_personal()
    space = await store.authorize(actor, space_id, role)
    if space['kind'] != 'personal':
        raise HTTPException(status_code=422, detail='preference conflicts are personal-only')
    return space


def _record(value) -> PreferenceConflictRecord:
    data = dict(value)
    return PreferenceConflictRecord(
        id=data['id'],
        personal_space_id=data['personal_space_id'],
        preference_key=data['preference_key'],
        preference_scope=data['preference_scope'],
        preference_project_id=data.get('preference_project_id'),
        left_item_id=data['left_item_id'],
        left_item_kind=data['left_item_kind'],
        right_item_id=data['right_item_id'],
        right_item_kind=data['right_item_kind'],
        status=data['status'],
        requested_by=data['requested_by'],
        resolution=data.get('resolution'),
        resolved_by=data.get('resolved_by'),
        reason=data['reason'],
        resolution_reason=data.get('resolution_reason'),
        deferred_at=_native_datetime(data['deferred_at']),
        resolved_at=_native_datetime(data.get('resolved_at')),
        updated_at=_native_datetime(data['updated_at']),
    )
