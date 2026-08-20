from collections import defaultdict
from math import isfinite

from fastapi import HTTPException

from .models import (
    CollaborationContextResult,
    CollaborationPreferenceConflict,
    CollaborationPreferenceItem,
    ConfirmationBasis,
    _validate_confirmation_state,
)
from .personal_project_access import authorize_personal_project
from .project_agent_access import authorize_project_agent
from .provider_values import json_object, native_datetime as _native_datetime


async def read_collaboration_context(
    store,
    actor: dict,
    space_id: str,
    personal_project_id: str | None = None,
    limit: int = 100,
    project_agent_id: str | None = None,
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
    if project_agent_id:
        if not personal_project_id:
            raise HTTPException(
                status_code=422,
                detail='project Agent preferences require a personal project',
            )
        await authorize_project_agent(
            store,
            actor,
            space,
            personal_project_id,
            project_agent_id,
            require_memory=True,
        )
    project_scopes = await _project_scopes(
        store,
        space,
        personal_project_id,
    )
    inherited_project_ids = [
        project_id
        for project_id, scope in project_scopes.items()
        if scope['scope_distance'] > 0
    ]

    candidate_limit = min(max(limit * 3, 100), store.settings.graph_limit)
    node_records, _, _ = await store.runtime.driver.execute_query(
        _node_query(),
        group_id=space['group_id'],
        project_id=personal_project_id,
        project_agent_id=project_agent_id,
        inherited_project_ids=inherited_project_ids,
        limit=candidate_limit + 1,
        routing_='r',
    )
    edge_records, _, _ = await store.runtime.driver.execute_query(
        _edge_query(),
        group_id=space['group_id'],
        project_id=personal_project_id,
        project_agent_id=project_agent_id,
        inherited_project_ids=inherited_project_ids,
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
        if (item := _node_item(record, project_scopes)) is not None
    ]
    edge_pairs = [
        (record, item)
        for record in edge_records[:candidate_limit]
        if (item := _edge_item(record, project_scopes)) is not None
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
    agent_preferences = [
        item for item in items if item.preference_scope == 'agent'
    ]
    (
        authoritative_global,
        authoritative_project,
        authoritative_agent,
        cross_scope_lower_authority_ids,
    ) = _highest_authority_by_key(
        global_preferences,
        project_preferences,
        agent_preferences,
    )
    (
        project_effective,
        project_conflicts,
        overridden_inherited_ids,
        overridden_lower_authority_ids,
    ) = _scope_conflict_free(authoritative_project)
    agent_effective, agent_conflicts = _conflict_free(authoritative_agent)
    overridden_lower_authority_ids = sorted({
        *cross_scope_lower_authority_ids,
        *overridden_lower_authority_ids,
    })
    # Any authoritative project-layer claim blocks global fallback for that
    # semantic key. A same-layer project conflict must remain deferred instead
    # of silently reviving a global value as effective.
    agent_keys = {item.preference_key for item in authoritative_agent}
    project_keys = {item.preference_key for item in authoritative_project}
    overridden_project_ids = sorted([
        item.id
        for item in authoritative_project
        if item.preference_key in agent_keys
    ])
    overridden_global_ids = sorted([
        item.id
        for item in authoritative_global
        if item.preference_key in project_keys or item.preference_key in agent_keys
    ])
    global_effective, global_conflicts = _conflict_free([
        item for item in authoritative_global
        if item.preference_key not in project_keys
        and item.preference_key not in agent_keys
    ])
    project_effective = [
        item for item in project_effective
        if item.preference_key not in agent_keys
    ]
    effective_preferences = [
        *global_effective,
        *project_effective,
        *agent_effective,
    ]

    return CollaborationContextResult(
        personal_space_id=space_id,
        personal_project_id=personal_project_id,
        project_agent_id=project_agent_id,
        global_preferences=global_preferences,
        project_preferences=project_preferences,
        agent_preferences=agent_preferences,
        effective_preferences=effective_preferences,
        conflicts=[*global_conflicts, *project_conflicts, *agent_conflicts],
        overridden_global_ids=overridden_global_ids,
        overridden_inherited_ids=overridden_inherited_ids,
        overridden_project_ids=overridden_project_ids,
        overridden_lower_authority_ids=overridden_lower_authority_ids,
        truncated=truncated,
    )


async def _project_scopes(store, space, personal_project_id):
    if not personal_project_id:
        return {}
    scopes = {
        personal_project_id: {
            'scope_distance': 0,
            'scope_path': [personal_project_id],
        },
    }
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (space:FuliSpace {id: $space_id, kind: 'personal'})-
              [:CONTAINS_PROJECT]->
              (active:FuliPersonalProject {project_id: $active_project_id})
        MATCH path=(active)-[:PERSONAL_PROJECT_RELATION*1..2]->
              (source:FuliPersonalProject)
        WHERE all(
          relation IN relationships(path)
          WHERE relation.relation_type IN ['PART_OF', 'USES_KNOWLEDGE_FROM']
            AND relation.status = 'active'
            AND relation.confirmation_authority = 'human_review'
        )
          AND EXISTS {
            MATCH (space)-[:CONTAINS_PROJECT]->(source)
          }
        RETURN source.project_id AS project_id,
               [node IN nodes(path) | node.project_id] AS scope_path,
               length(path) AS scope_distance
        ORDER BY scope_distance ASC, project_id ASC
        LIMIT $inheritance_limit
        ''',
        space_id=space['id'],
        active_project_id=personal_project_id,
        inheritance_limit=min(
            int(getattr(getattr(store, 'settings', None), 'graph_limit', 500)),
            64,
        ),
        routing_='r',
    )
    for record in records:
        project_id = record['project_id']
        distance = int(record['scope_distance'])
        path = list(record.get('scope_path') or [])
        if len(path) != distance + 1 or len(path) != len(set(path)):
            continue
        existing = scopes.get(project_id)
        if existing is not None and existing['scope_distance'] <= distance:
            continue
        scopes[project_id] = {
            'scope_distance': distance,
            'scope_path': path,
        }
    return scopes


def _node_query() -> str:
    return '''
        MATCH (node:Entity {group_id: $group_id})
        WHERE node.fuli_profile_aspect IS NOT NULL
          AND node.fuli_invalid_at IS NULL
          AND node.fuli_confirmation_status IN ['confirmed', 'agent_confirmed']
          AND (
               coalesce(node.fuli_preference_scope, 'global') = 'global'
            OR (
              node.fuli_preference_scope = 'project'
              AND (
                   node.fuli_preference_project_id = $project_id
                OR (
                  node.fuli_preference_project_id IN $inherited_project_ids
                  AND (
                       node.fuli_inheritance_mode = 'descendants'
                    OR (
                      node.fuli_inheritance_mode = 'selected_projects'
                      AND $project_id IN coalesce(node.fuli_inherited_project_ids, [])
                    )
                  )
                )
              )
            )
            OR (
              node.fuli_preference_scope = 'agent'
              AND node.fuli_preference_project_id = $project_id
              AND node.fuli_preference_agent_id = $project_agent_id
            )
          )
        RETURN node.uuid AS id,
               coalesce(node.fuli_key, node.uuid) AS key,
               node.name AS title,
               coalesce(node.summary, node.name) AS instruction,
               node.fuli_profile_aspect AS profile_aspect,
               coalesce(node.fuli_preference_scope, 'global') AS preference_scope,
               node.fuli_preference_project_id AS preference_project_id,
               node.fuli_preference_agent_id AS preference_agent_id,
               node.fuli_attributes_json AS attributes_json,
               node.fuli_confirmation_basis_json AS confirmation_basis_json,
               node.fuli_reasoning_summary AS reasoning_summary,
               coalesce(node.fuli_inheritance_mode, 'local_only') AS inheritance_mode,
               coalesce(node.fuli_inherited_project_ids, []) AS inherited_project_ids,
               node.fuli_confirmation_status AS confirmation_status,
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
          AND edge.fuli_confirmation_status IN ['confirmed', 'agent_confirmed']
          AND (
               coalesce(edge.fuli_preference_scope, 'global') = 'global'
            OR (
              edge.fuli_preference_scope = 'project'
              AND (
                   edge.fuli_preference_project_id = $project_id
                OR (
                  edge.fuli_preference_project_id IN $inherited_project_ids
                  AND (
                       edge.fuli_inheritance_mode = 'descendants'
                    OR (
                      edge.fuli_inheritance_mode = 'selected_projects'
                      AND $project_id IN coalesce(edge.fuli_inherited_project_ids, [])
                    )
                  )
                )
              )
            )
            OR (
              edge.fuli_preference_scope = 'agent'
              AND edge.fuli_preference_project_id = $project_id
              AND edge.fuli_preference_agent_id = $project_agent_id
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
               edge.fuli_preference_agent_id AS preference_agent_id,
               edge.fuli_attributes_json AS attributes_json,
               edge.fuli_confirmation_basis_json AS confirmation_basis_json,
               edge.fuli_reasoning_summary AS reasoning_summary,
               coalesce(edge.fuli_inheritance_mode, 'local_only') AS inheritance_mode,
               coalesce(edge.fuli_inherited_project_ids, []) AS inherited_project_ids,
               edge.fuli_confirmation_status AS confirmation_status,
               edge.created_at AS created_at
        ORDER BY edge.created_at DESC
        LIMIT $limit
    '''


def _node_item(record, project_scopes) -> CollaborationPreferenceItem | None:
    return _preference_item(
        record,
        item_kind='entity',
        title=record.get('title') or record.get('key') or record.get('id'),
        instruction=record.get('instruction') or record.get('title') or '',
        project_scopes=project_scopes,
    )


def _edge_item(record, project_scopes) -> CollaborationPreferenceItem | None:
    source = record.get('source_name') or '偏好'
    target = record.get('target_name') or '适用场景'
    return _preference_item(
        record,
        item_kind='relationship',
        title=f'{source} → {target}',
        instruction=record.get('instruction') or '',
        project_scopes=project_scopes,
    )


def _preference_item(
    record,
    *,
    item_kind: str,
    title: str,
    instruction: str,
    project_scopes: dict[str, dict],
) -> CollaborationPreferenceItem | None:
    basis_data = json_object(record.get('confirmation_basis_json'))
    if not basis_data:
        return None
    try:
        basis = ConfirmationBasis.model_validate(basis_data)
        confirmation_status = record.get('confirmation_status') or 'confirmed'
        _validate_confirmation_state(confirmation_status, basis)
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
    project_id = record.get('preference_project_id')
    agent_id = record.get('preference_agent_id')
    scope = project_scopes.get(project_id, {
        'scope_distance': 0,
        'scope_path': [],
    })
    scope_distance = int(scope['scope_distance'])
    inheritance_mode = record.get('inheritance_mode') or 'local_only'
    inherited_project_ids = list(record.get('inherited_project_ids') or [])
    active_project_id = scope['scope_path'][0] if scope['scope_path'] else None
    if scope_distance > 0 and (
        inheritance_mode == 'local_only'
        or (
            inheritance_mode == 'selected_projects'
            and active_project_id not in inherited_project_ids
        )
    ):
        return None
    weight = attributes.get('weight')
    if (
        not isinstance(weight, (int, float))
        or isinstance(weight, bool)
        or not isfinite(weight)
        or weight < 0
        or weight > 1
    ):
        weight = None
    reason = attributes.get('reason')
    if not isinstance(reason, str) or not reason.strip():
        reason = record.get('reasoning_summary') or basis.existence_reason
    return CollaborationPreferenceItem(
        id=str(record['id']),
        item_kind=item_kind,
        key=key,
        preference_key=preference_key,
        title=str(title),
        instruction=str(instruction),
        profile_aspect=record['profile_aspect'],
        preference_scope=record['preference_scope'],
        preference_project_id=project_id,
        preference_agent_id=agent_id,
        attributes=attributes,
        weight=weight,
        reason=reason,
        confirmation_basis=basis,
        reasoning_summary=record.get('reasoning_summary'),
        inheritance_mode=inheritance_mode,
        inherited_project_ids=inherited_project_ids,
        confirmation_status=confirmation_status,
        confirmed_at=basis.confirmed_at,
        created_at=_native_datetime(record.get('created_at')),
        scope_distance=scope_distance,
        inherited_from_project_id=project_id if scope_distance > 0 else None,
        scope_path=list(scope['scope_path']),
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
        strongest_status = (
            'confirmed'
            if any(item.confirmation_status == 'confirmed' for item in candidates)
            else 'agent_confirmed'
        )
        candidates = [
            item for item in candidates
            if item.confirmation_status == strongest_status
        ]
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
            preference_agent_id=first.preference_agent_id,
            item_ids=[item.id for item in candidates],
        ))
    effective.sort(key=_sort_key)
    return effective, conflicts


def _scope_conflict_free(
    items: list[CollaborationPreferenceItem],
) -> tuple[
    list[CollaborationPreferenceItem],
    list[CollaborationPreferenceConflict],
    list[str],
    list[str],
]:
    grouped: dict[str, list[CollaborationPreferenceItem]] = defaultdict(list)
    for item in items:
        grouped[item.preference_key].append(item)

    effective = []
    conflicts = []
    overridden = []
    lower_authority = []
    for candidates in grouped.values():
        strongest_status = (
            'confirmed'
            if any(item.confirmation_status == 'confirmed' for item in candidates)
            else 'agent_confirmed'
        )
        authoritative = [
            item for item in candidates
            if item.confirmation_status == strongest_status
        ]
        lower_authority.extend(
            item.id for item in candidates
            if item.confirmation_status != strongest_status
        )
        nearest_distance = min(item.scope_distance for item in authoritative)
        nearest = [
            item for item in authoritative
            if item.scope_distance == nearest_distance
        ]
        overridden.extend(
            item.id for item in authoritative
            if item.scope_distance > nearest_distance
        )
        group_effective, group_conflicts = _conflict_free(nearest)
        effective.extend(group_effective)
        conflicts.extend(group_conflicts)
    effective.sort(key=_sort_key)
    conflicts.sort(key=lambda conflict: conflict.preference_key)
    return effective, conflicts, sorted(overridden), sorted(lower_authority)


def _highest_authority_by_key(
    global_items: list[CollaborationPreferenceItem],
    project_items: list[CollaborationPreferenceItem],
    agent_items: list[CollaborationPreferenceItem],
) -> tuple[
    list[CollaborationPreferenceItem],
    list[CollaborationPreferenceItem],
    list[CollaborationPreferenceItem],
    list[str],
]:
    grouped: dict[str, list[CollaborationPreferenceItem]] = defaultdict(list)
    for item in [*global_items, *project_items, *agent_items]:
        grouped[item.preference_key].append(item)
    selected_ids = set()
    lower_authority_ids = []
    for candidates in grouped.values():
        strongest_status = (
            'confirmed'
            if any(item.confirmation_status == 'confirmed' for item in candidates)
            else 'agent_confirmed'
        )
        for item in candidates:
            if item.confirmation_status == strongest_status:
                selected_ids.add(item.id)
            else:
                lower_authority_ids.append(item.id)
    return (
        [item for item in global_items if item.id in selected_ids],
        [item for item in project_items if item.id in selected_ids],
        [item for item in agent_items if item.id in selected_ids],
        sorted(lower_authority_ids),
    )


def _sort_key(item: CollaborationPreferenceItem) -> tuple:
    created = -item.created_at.timestamp() if item.created_at else 0
    return (
        {'global': 0, 'project': 1, 'agent': 2}[item.preference_scope],
        0 if item.confirmation_status == 'confirmed' else 1,
        item.profile_aspect,
        item.preference_key,
        -(item.weight or 0),
        created,
        item.id,
    )


def _normalize(value: str) -> str:
    return ' '.join(value.casefold().split())
