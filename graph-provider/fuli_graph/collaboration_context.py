from collections import defaultdict

from fastapi import HTTPException

from .models import (
    CollaborationContextResult,
    CollaborationPreferenceConflict,
    CollaborationPreferenceItem,
    ConfirmationBasis,
)
from .personal_project_access import authorize_personal_project
from .provider_values import json_object, native_datetime as _native_datetime


async def read_collaboration_context(
    store,
    actor: dict,
    space_id: str,
    personal_project_id: str | None = None,
    limit: int = 100,
) -> CollaborationContextResult:
    space = await store.authorize(actor, space_id, 'reader')
    if space['kind'] != 'personal':
        raise HTTPException(
            status_code=422,
            detail='collaboration preferences require a personal space',
        )
    if personal_project_id:
        await authorize_personal_project(
            store,
            actor,
            space,
            personal_project_id,
        )

    candidate_limit = min(max(limit * 3, 100), store.settings.graph_limit)
    node_records, _, _ = await store.runtime.driver.execute_query(
        _node_query(),
        group_id=space['group_id'],
        project_id=personal_project_id,
        limit=candidate_limit + 1,
        routing_='r',
    )
    edge_records, _, _ = await store.runtime.driver.execute_query(
        _edge_query(),
        group_id=space['group_id'],
        project_id=personal_project_id,
        limit=candidate_limit + 1,
        routing_='r',
    )
    truncated = (
        len(node_records) > candidate_limit
        or len(edge_records) > candidate_limit
    )
    nodes = [
        item
        for record in node_records[:candidate_limit]
        if (item := _node_item(record)) is not None
    ]
    edge_pairs = [
        (record, item)
        for record in edge_records[:candidate_limit]
        if (item := _edge_item(record)) is not None
    ]
    edges = [item for _, item in edge_pairs]
    edge_endpoint_ids = {
        endpoint_id
        for record, _ in edge_pairs
        for endpoint_id in (record.get('source_id'), record.get('target_id'))
    }
    items = [
        *edges,
        *(item for item in nodes if item.id not in edge_endpoint_ids),
    ]
    items.sort(key=_sort_key)
    if len(items) > limit:
        truncated = True
        items = items[:limit]

    global_preferences = [
        item for item in items if item.preference_scope == 'global'
    ]
    project_preferences = [
        item for item in items if item.preference_scope == 'project'
    ]
    global_effective, global_conflicts = _conflict_free(global_preferences)
    project_effective, project_conflicts = _conflict_free(project_preferences)
    project_keys = {item.preference_key for item in project_preferences}
    overridden_global_ids = [
        item.id
        for item in global_effective
        if item.preference_key in project_keys
    ]
    effective_preferences = [
        item
        for item in global_effective
        if item.preference_key not in project_keys
    ] + project_effective

    return CollaborationContextResult(
        personal_space_id=space_id,
        personal_project_id=personal_project_id,
        global_preferences=global_preferences,
        project_preferences=project_preferences,
        effective_preferences=effective_preferences,
        conflicts=[*global_conflicts, *project_conflicts],
        overridden_global_ids=overridden_global_ids,
        truncated=truncated,
    )


def _node_query() -> str:
    return '''
        MATCH (node:Entity {group_id: $group_id})
        WHERE node.fuli_profile_aspect IS NOT NULL
          AND node.fuli_invalid_at IS NULL
          AND node.fuli_confirmation_status = 'confirmed'
          AND (
               coalesce(node.fuli_preference_scope, 'global') = 'global'
            OR (
              node.fuli_preference_scope = 'project'
              AND node.fuli_preference_project_id = $project_id
            )
          )
        RETURN node.uuid AS id,
               coalesce(node.fuli_key, node.uuid) AS key,
               node.name AS title,
               coalesce(node.summary, node.name) AS instruction,
               node.fuli_profile_aspect AS profile_aspect,
               coalesce(node.fuli_preference_scope, 'global') AS preference_scope,
               node.fuli_preference_project_id AS preference_project_id,
               node.fuli_attributes_json AS attributes_json,
               node.fuli_confirmation_basis_json AS confirmation_basis_json,
               node.created_at AS created_at
        ORDER BY node.created_at DESC
        LIMIT $limit
    '''


def _edge_query() -> str:
    return '''
        MATCH (source:Entity)-[edge:RELATES_TO {group_id: $group_id}]->
              (target:Entity)
        WHERE edge.fuli_profile_aspect IS NOT NULL
          AND edge.invalid_at IS NULL
          AND edge.fuli_confirmation_status = 'confirmed'
          AND (
               coalesce(edge.fuli_preference_scope, 'global') = 'global'
            OR (
              edge.fuli_preference_scope = 'project'
              AND edge.fuli_preference_project_id = $project_id
            )
          )
        RETURN edge.uuid AS id,
               coalesce(edge.fuli_key, edge.uuid) AS key,
               source.uuid AS source_id,
               target.uuid AS target_id,
               source.name AS source_name,
               target.name AS target_name,
               edge.fact AS instruction,
               edge.fuli_profile_aspect AS profile_aspect,
               coalesce(edge.fuli_preference_scope, 'global') AS preference_scope,
               edge.fuli_preference_project_id AS preference_project_id,
               edge.fuli_attributes_json AS attributes_json,
               edge.fuli_confirmation_basis_json AS confirmation_basis_json,
               edge.created_at AS created_at
        ORDER BY edge.created_at DESC
        LIMIT $limit
    '''


def _node_item(record) -> CollaborationPreferenceItem | None:
    return _preference_item(
        record,
        item_kind='entity',
        title=record.get('title') or record.get('key') or record.get('id'),
        instruction=record.get('instruction') or record.get('title') or '',
    )


def _edge_item(record) -> CollaborationPreferenceItem | None:
    source = record.get('source_name') or '偏好'
    target = record.get('target_name') or '适用场景'
    return _preference_item(
        record,
        item_kind='relationship',
        title=f'{source} → {target}',
        instruction=record.get('instruction') or '',
    )


def _preference_item(
    record,
    *,
    item_kind: str,
    title: str,
    instruction: str,
) -> CollaborationPreferenceItem | None:
    basis_data = json_object(record.get('confirmation_basis_json'))
    if not basis_data:
        return None
    try:
        basis = ConfirmationBasis.model_validate(basis_data)
    except ValueError:
        return None
    if not basis.confirmed_by or not basis.confirmed_at:
        return None
    attributes = json_object(record.get('attributes_json'))
    key = str(record.get('key') or record.get('id'))
    preference_key = str(
        attributes.get('preferenceKey')
        or attributes.get('preference_key')
        or key
    )
    return CollaborationPreferenceItem(
        id=str(record['id']),
        item_kind=item_kind,
        key=key,
        preference_key=preference_key,
        title=str(title),
        instruction=str(instruction),
        profile_aspect=record['profile_aspect'],
        preference_scope=record['preference_scope'],
        preference_project_id=record.get('preference_project_id'),
        attributes=attributes,
        confirmed_at=basis.confirmed_at,
        created_at=_native_datetime(record.get('created_at')),
    )


def _conflict_free(
    items: list[CollaborationPreferenceItem],
) -> tuple[
    list[CollaborationPreferenceItem],
    list[CollaborationPreferenceConflict],
]:
    grouped: dict[str, list[CollaborationPreferenceItem]] = defaultdict(list)
    for item in items:
        grouped[item.preference_key].append(item)

    effective = []
    conflicts = []
    for preference_key, candidates in grouped.items():
        instructions = {
            _normalize(item.instruction)
            for item in candidates
        }
        if len(instructions) <= 1:
            effective.append(candidates[0])
            continue
        first = candidates[0]
        conflicts.append(CollaborationPreferenceConflict(
            preference_key=preference_key,
            preference_scope=first.preference_scope,
            preference_project_id=first.preference_project_id,
            item_ids=[item.id for item in candidates],
        ))
    effective.sort(key=_sort_key)
    return effective, conflicts


def _sort_key(item: CollaborationPreferenceItem) -> tuple:
    created = -item.created_at.timestamp() if item.created_at else 0
    return (
        0 if item.preference_scope == 'global' else 1,
        item.profile_aspect,
        item.preference_key,
        created,
        item.id,
    )


def _normalize(value: str) -> str:
    return ' '.join(value.casefold().split())
