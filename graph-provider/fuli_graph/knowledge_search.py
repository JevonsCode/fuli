import re
from datetime import datetime

from fastapi import HTTPException
from graphiti_core.edges import EntityEdge

from .models import ConfirmationBasis, EntitySearchResult, SearchRequest, SearchResult
from .personal_project_access import authorize_personal_project
from .provider_values import (
    json_object,
    native_datetime as _native_datetime,
    normalized_text as _normalized,
)
from .search_projection import (
    effective_confirmation_status,
    fact_result,
    is_default_retrievable,
    read_edge_epistemic_metadata,
)

MIN_TERM_COVERAGE = 0.25
LATIN_QUERY_FILLERS = {
    'a', 'an', 'and', 'are', 'can', 'could', 'do', 'does', 'find', 'for',
    'from', 'give', 'how', 'i', 'in', 'is', 'it', 'me', 'of', 'on', 'please',
    'tell', 'that', 'the', 'this', 'to', 'was', 'what', 'when', 'where', 'which',
    'why', 'with', 'you',
}
CHINESE_QUERY_FILLERS = (
    '请问', '麻烦', '帮忙', '帮我', '告诉我', '查找', '查询', '是什么', '在哪里',
    '在哪儿', '为什么', '怎么样', '怎样', '怎么', '哪里', '哪个', '多少', '有没有',
    '是否', '一下',
)


async def search_knowledge(store, actor: dict, request: SearchRequest) -> SearchResult:
    spaces = [await store.authorize(actor, space_id, 'reader') for space_id in request.space_ids]
    personal_space = await _personal_search_space(store, actor, spaces, request)
    space_ids_by_group = {space['group_id']: space['id'] for space in spaces}
    group_ids = [space['group_id'] for space in spaces]
    edges = await store.runtime.graphiti.search(
        request.query,
        group_ids=group_ids,
        num_results=min(max(request.limit * 8, 40), 100),
    )
    if not request.include_historical:
        edges = [edge for edge in edges if edge.invalid_at is None]
    project_scopes = {}
    if personal_space:
        project_scopes = await personal_project_scopes(
            store,
            personal_space,
            request,
        )
        allowed = await personal_edge_scopes(
            store,
            personal_space,
            request,
            project_scopes,
            request.include_personal_global,
            [edge.uuid for edge in edges],
        )
        edges = [edge for edge in edges if edge.uuid in allowed]
    epistemic = await read_edge_epistemic_metadata(store, [edge.uuid for edge in edges])
    if personal_space:
        epistemic = {
            edge_id: {
                **metadata,
                **allowed.get(edge_id, {}),
            }
            for edge_id, metadata in epistemic.items()
        }
    if not request.include_pending:
        edges = [
            edge for edge in edges
            if is_default_retrievable(epistemic.get(edge.uuid, {}))
        ]
    names = await _entity_names(store, edges)
    ranked_edges = sorted(
        (
            (
                _ranked_relevance(
                    _edge_relevance(
                        request.query,
                        edge,
                        names,
                        position,
                        len(edges),
                    ),
                    epistemic.get(edge.uuid, {}),
                ),
                edge,
            )
            for position, edge in enumerate(edges)
        ),
        key=lambda item: item[0],
        reverse=True,
    )
    ranked_edges = [item for item in ranked_edges if item[0] > 0]
    if personal_space:
        ranked_edges = _dedupe_ranked_edges(
            ranked_edges,
            epistemic,
            request.active_personal_project_id,
        )
    ranked_edges = ranked_edges[: request.limit]
    entities = (
        await _personal_entities(
            store,
            personal_space,
            request,
            project_scopes,
        )
        if personal_space else []
    )
    return SearchResult(
        facts=[
            fact_result(
                edge,
                names,
                space_ids_by_group[edge.group_id],
                epistemic.get(edge.uuid, {}),
            ).model_copy(
                update={'score': score}
            )
            for score, edge in ranked_edges
        ],
        entities=entities,
    )


async def personal_edge_ids(
    store,
    space: dict,
    project_ids: list[str],
    include_personal_global: bool,
    edge_ids: list[str],
) -> set[str]:
    request = SearchRequest(
        space_ids=[space['id']],
        query='scope',
        personal_project_ids=project_ids,
        include_personal_global=include_personal_global,
    )
    scopes = {
        project_id: {
            'scope_distance': 0,
            'scope_path': [project_id],
            'inherited': False,
        }
        for project_id in project_ids
    }
    return set(await personal_edge_scopes(
        store,
        space,
        request,
        scopes,
        include_personal_global,
        edge_ids,
    ))


async def personal_edge_scopes(
    store,
    space: dict,
    request: SearchRequest,
    project_scopes: dict[str, dict],
    include_personal_global: bool,
    edge_ids: list[str],
) -> dict[str, dict]:
    if not edge_ids or (not project_scopes and not include_personal_global):
        return {}
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH ()-[edge:RELATES_TO {group_id: $group_id}]->()
        WHERE edge.uuid IN $edge_ids
        OPTIONAL MATCH (assignment:FuliKnowledgeAssignment {
          space_id: $space_id,
          item_kind: 'relationship',
          item_id: edge.uuid
        })
        WITH edge, assignment
        OPTIONAL MATCH (episode:Episodic {group_id: $group_id})
        WHERE episode.uuid IN coalesce(edge.episodes, [])
        WITH edge, assignment, collect(DISTINCT episode) AS episodes
        OPTIONAL MATCH (:FuliSpace {id: $space_id})-[:HAS_KNOWLEDGE_REFERENCE]->
              (reference:FuliKnowledgeProjectReference {
                item_kind: 'relationship', item_id: edge.uuid, status: 'active'
              })
        RETURN edge.uuid AS id,
               edge.fuli_profile_aspect AS profile_aspect,
               coalesce(edge.fuli_preference_scope, 'global')
                 AS preference_scope,
               edge.fuli_preference_project_id AS preference_project_id,
               assignment.project_id AS assignment_project_id,
               [episode IN episodes
                 WHERE episode.fuli_personal_project_id IS NOT NULL |
                 episode.fuli_personal_project_id] AS episode_project_ids,
               any(episode IN episodes
                   WHERE episode.fuli_personal_project_id IS NULL)
                 AS has_global_episode,
               collect(DISTINCT reference.project_id) AS reference_project_ids,
               coalesce(edge.fuli_inheritance_mode, 'local_only')
                 AS inheritance_mode,
               coalesce(edge.fuli_inherited_project_ids, [])
                 AS inherited_project_ids
        ''',
        group_id=space['group_id'],
        space_id=space['id'],
        project_ids=list(project_scopes),
        include_personal_global=include_personal_global,
        edge_ids=edge_ids,
        routing_='r',
    )
    return {
        record['id']: scope
        for record in records
        if (
            scope := _item_scope_metadata(
                record,
                request,
                project_scopes,
                include_personal_global,
            )
        ) is not None
    }


async def personal_project_scopes(
    store,
    space: dict,
    request: SearchRequest,
) -> dict[str, dict]:
    scopes = {
        project_id: {
            'scope_distance': 0,
            'scope_path': [project_id],
            'inherited': False,
        }
        for project_id in request.personal_project_ids
    }
    active_id = request.active_personal_project_id
    if (
        not active_id
        or not request.inherit_project_knowledge
    ):
        return scopes
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
        )
          AND EXISTS {
            MATCH (space)-[:CONTAINS_PROJECT]->(source)
          }
        RETURN source.project_id AS project_id,
               [node IN nodes(path) | node.project_id] AS scope_path,
               length(path) AS scope_distance
        ORDER BY scope_distance ASC
        LIMIT $inheritance_limit
        ''',
        space_id=space['id'],
        active_project_id=active_id,
        inheritance_limit=min(
            int(getattr(getattr(store, 'settings', None), 'graph_limit', 500)),
            64,
        ),
        routing_='r',
    )
    for record in records:
        project_id = record['project_id']
        distance = int(record['scope_distance'])
        existing = scopes.get(project_id)
        if existing is not None and existing['scope_distance'] <= distance:
            continue
        path = list(record.get('scope_path') or [])
        if len(path) != len(set(path)):
            continue
        scopes[project_id] = {
            'scope_distance': distance,
            'scope_path': path,
            'inherited': True,
        }
    return scopes


async def _personal_search_space(store, actor, spaces, request):
    personal_spaces = [space for space in spaces if space['kind'] == 'personal']
    if not personal_spaces:
        if request.personal_project_ids or request.include_personal_global:
            raise HTTPException(
                status_code=422,
                detail='personal context can only be used with one personal space',
            )
        return None
    if len(spaces) != 1:
        raise HTTPException(
            status_code=422,
            detail='personal context search requires exactly one personal space',
        )
    space = personal_spaces[0]
    for project_id in request.personal_project_ids:
        await authorize_personal_project(store, actor, space, project_id)
    return space


async def _personal_entities(
    store,
    space,
    request: SearchRequest,
    project_scopes: dict[str, dict],
) -> list[EntitySearchResult]:
    if not project_scopes and not request.include_personal_global:
        return []
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (node:Entity {group_id: $group_id})
        OPTIONAL MATCH (episode:Episodic {group_id: $group_id})-[:MENTIONS]->(node)
        WITH node, collect(DISTINCT episode) AS episodes
        OPTIONAL MATCH (assignment:FuliKnowledgeAssignment {
          space_id: $space_id,
          item_kind: 'entity',
          item_id: node.uuid
        })
        OPTIONAL MATCH (:FuliSpace {id: $space_id})-[:HAS_KNOWLEDGE_REFERENCE]->
              (reference:FuliKnowledgeProjectReference {
                item_kind: 'entity', item_id: node.uuid, status: 'active'
              })
        WITH node, episodes, assignment, collect(DISTINCT reference) AS references
        WHERE ($include_historical OR node.fuli_invalid_at IS NULL)
          AND (
            $include_pending
            OR coalesce(node.fuli_confirmation_status, 'pending')
               IN ['confirmed', 'agent_confirmed']
          )
          AND NOT EXISTS {
            MATCH (:FuliSpace {id: $space_id})-[:HAS_KNOWLEDGE_CONFLICT]->
                  (conflict:FuliKnowledgeConflict)
            WHERE conflict.target_item_id = node.uuid
              AND conflict.target_project_id IN $project_ids
              AND conflict.status = 'resolved'
              AND conflict.resolution = 'use_source'
          }
        RETURN node.uuid AS id, node.group_id AS group_id,
               node.name AS name, coalesce(node.fuli_type, 'Entity') AS type,
               coalesce(node.summary, '') AS summary,
               node.created_at AS created_at,
               coalesce(node.fuli_origin_quadrant, 'known_known') AS origin_quadrant,
               coalesce(node.fuli_current_quadrant, 'known_known') AS current_quadrant,
               coalesce(node.fuli_epistemic_status, 'confirmed') AS epistemic_status,
               coalesce(node.fuli_confirmation_status, 'pending')
                 AS confirmation_status,
               node.fuli_confirmation_basis_json AS confirmation_basis_json,
               node.fuli_reasoning_summary AS reasoning_summary,
               node.fuli_profile_aspect AS profile_aspect,
               CASE WHEN node.fuli_profile_aspect IS NULL THEN NULL
                    ELSE coalesce(node.fuli_preference_scope, 'global') END
                    AS preference_scope,
               node.fuli_preference_project_id AS preference_project_id,
               coalesce(node.fuli_key, node.uuid) AS key,
               assignment.project_id AS assignment_project_id,
               [episode IN episodes
                 WHERE episode.fuli_personal_project_id IS NOT NULL |
                 episode.fuli_personal_project_id] AS episode_project_ids,
               any(episode IN episodes
                   WHERE episode.fuli_personal_project_id IS NULL)
                 AS has_global_episode,
               [reference IN references | reference.project_id]
                 AS reference_project_ids,
               coalesce(node.fuli_inheritance_mode, 'local_only')
                 AS inheritance_mode,
               coalesce(node.fuli_inherited_project_ids, [])
                 AS inherited_project_ids,
               coalesce(node.fuli_human_edited, false) AS human_edited,
               coalesce(node.fuli_human_change_status, 'none')
                 AS human_change_status,
               coalesce(node.fuli_human_change_version, 0)
                 AS human_change_version,
               node.fuli_last_human_changed_at AS last_human_changed_at,
               node.fuli_last_agent_viewed_at AS last_agent_viewed_at,
               node.fuli_last_agent_reviewed_at AS last_agent_reviewed_at,
               coalesce(node.fuli_utility_score, 0.0) AS utility_score,
               coalesce(node.fuli_confidence_score, 0.5) AS confidence_score,
               coalesce(node.fuli_qualified_use_count, 0)
                 AS qualified_use_count,
               coalesce(node.fuli_distinct_task_count, 0)
                 AS distinct_task_count,
               node.fuli_last_used_at AS last_used_at
        ORDER BY node.name, node.uuid
        LIMIT $candidate_limit
        ''',
        group_id=space['group_id'],
        space_id=space['id'],
        project_ids=list(project_scopes),
        include_historical=request.include_historical,
        include_pending=request.include_pending,
        candidate_limit=store.settings.graph_limit,
        routing_='r',
    )
    scoped_records = []
    for record in records:
        record = dict(record)
        effective_status = effective_confirmation_status(record)
        if effective_status != record.get('confirmation_status'):
            record['confidence_score'] = min(
                float(record.get('confidence_score') or 0.5),
                0.5,
            )
        record['confirmation_status'] = effective_status
        if (
            not request.include_pending
            and not is_default_retrievable(record)
        ):
            continue
        scope = _item_scope_metadata(
            record,
            request,
            project_scopes,
            request.include_personal_global,
        )
        if scope is not None:
            scoped_records.append({**record, **scope})
    ranked = sorted(
        (
            (
                record,
                _ranked_relevance(
                    _relevance(request.query, record),
                    record,
                ),
            )
            for record in scoped_records
        ),
        key=lambda item: (item[1], _timestamp(item[0].get('created_at'))),
        reverse=True,
    )
    ranked = [item for item in ranked if item[1] > 0]
    ranked = _dedupe_ranked_entities(
        ranked,
        request.active_personal_project_id,
    )[: request.limit]
    return [
        _entity_search_result(record, score, space['id'])
        for record, score in ranked
    ]


def _item_scope_metadata(
    record,
    request: SearchRequest,
    project_scopes: dict[str, dict],
    include_personal_global: bool,
) -> dict | None:
    if not any(
        field in record
        for field in (
            'profile_aspect',
            'assignment_project_id',
            'episode_project_ids',
            'reference_project_ids',
            'has_global_episode',
        )
    ):
        # Backward-compatible projection for older Provider clients that returned
        # only already-filtered item IDs.
        return _global_scope_metadata()
    profile_aspect = record.get('profile_aspect')
    if profile_aspect:
        preference_scope = record.get('preference_scope') or 'global'
        if preference_scope == 'global':
            if not include_personal_global:
                return None
            return _global_scope_metadata()
        project_id = record.get('preference_project_id')
        if project_id not in request.personal_project_ids:
            return None
        return _project_scope_metadata(project_id, project_scopes[project_id])

    assignment_project_id = record.get('assignment_project_id')
    episode_project_ids = list(record.get('episode_project_ids') or [])
    reference_project_ids = list(record.get('reference_project_ids') or [])
    project_ids = (
        [assignment_project_id]
        if assignment_project_id else episode_project_ids
    )
    project_ids = list(dict.fromkeys([
        *project_ids,
        *reference_project_ids,
    ]))
    candidates = []
    active_id = request.active_personal_project_id
    inheritance_mode = record.get('inheritance_mode') or 'local_only'
    selected_project_ids = set(record.get('inherited_project_ids') or [])
    for project_id in project_ids:
        scope = project_scopes.get(project_id)
        if scope is None:
            continue
        if scope.get('inherited'):
            eligible = (
                inheritance_mode == 'descendants'
                or (
                    inheritance_mode == 'selected_projects'
                    and active_id in selected_project_ids
                )
            )
            if not eligible:
                continue
        candidates.append((project_id, scope))
    if candidates:
        project_id, scope = min(
            candidates,
            key=lambda item: (
                0 if item[0] == active_id else 1,
                1 if item[1].get('inherited') else 0,
                int(item[1].get('scope_distance') or 0),
                item[0],
            ),
        )
        return _project_scope_metadata(project_id, scope)
    if include_personal_global and record.get('has_global_episode'):
        return _global_scope_metadata()
    return None


def _global_scope_metadata() -> dict:
    return {
        'defined_project_id': None,
        'scope_distance': 0,
        'inherited_from_project_id': None,
        'scope_path': [],
        'inherited': False,
    }


def _project_scope_metadata(project_id: str, scope: dict) -> dict:
    inherited = scope.get('inherited') is True
    return {
        'defined_project_id': project_id,
        'scope_distance': int(scope.get('scope_distance') or 0),
        'inherited_from_project_id': project_id if inherited else None,
        'scope_path': list(scope.get('scope_path') or [project_id]),
        'inherited': inherited,
    }


def _ranked_relevance(base_score: float, metadata) -> float:
    if base_score <= 0:
        return 0.0
    status_factor = {
        'confirmed': 1.0,
        'agent_confirmed': 0.88,
        'pending': 0.72,
    }.get(metadata.get('confirmation_status'), 0.72)
    confidence = float(
        metadata['confidence_score']
        if metadata.get('confidence_score') is not None else 0.5
    )
    utility = float(metadata.get('utility_score') or 0)
    scope_distance = int(metadata.get('scope_distance') or 0)
    confidence_factor = 0.75 + min(max(confidence, 0), 1) * 0.25
    utility_factor = 0.95 + min(max(utility, 0), 1) * 0.1
    scope_factor = max(0.65, 1.0 - scope_distance * 0.15)
    return round(
        base_score
        * status_factor
        * confidence_factor
        * utility_factor
        * scope_factor,
        4,
    )


def _scope_precedence(metadata, active_project_id: str | None) -> tuple:
    project_id = metadata.get('defined_project_id')
    return (
        0 if active_project_id and project_id == active_project_id else 1,
        1 if metadata.get('inherited_from_project_id') else 0,
        int(metadata.get('scope_distance') or 0),
    )


def _dedupe_ranked_edges(ranked, metadata_by_id, active_project_id):
    selected = {}
    for score, edge in ranked:
        metadata = metadata_by_id.get(edge.uuid, {})
        key = metadata.get('key') or edge.uuid
        quality = (_scope_precedence(metadata, active_project_id), -score)
        current = selected.get(key)
        if current is None or quality < current[0]:
            selected[key] = (quality, score, edge)
    return sorted(
        ((score, edge) for _, score, edge in selected.values()),
        key=lambda item: item[0],
        reverse=True,
    )


def _dedupe_ranked_entities(ranked, active_project_id):
    selected = {}
    for record, score in ranked:
        key = record.get('key') or record.get('id')
        quality = (_scope_precedence(record, active_project_id), -score)
        current = selected.get(key)
        if current is None or quality < current[0]:
            selected[key] = (quality, record, score)
    return sorted(
        ((record, score) for _, record, score in selected.values()),
        key=lambda item: (item[1], _timestamp(item[0].get('created_at'))),
        reverse=True,
    )


def _entity_search_result(record, score: float, space_id: str) -> EntitySearchResult:
    value = dict(record)
    basis = json_object(value.pop('confirmation_basis_json', None))
    created_at = _native_datetime(value.pop('created_at', None))
    last_human_changed_at = _native_datetime(
        value.pop('last_human_changed_at', None)
    )
    last_agent_viewed_at = _native_datetime(
        value.pop('last_agent_viewed_at', None)
    )
    last_agent_reviewed_at = _native_datetime(
        value.pop('last_agent_reviewed_at', None)
    )
    last_used_at = _native_datetime(value.pop('last_used_at', None))
    for field in (
        'assignment_project_id',
        'episode_project_ids',
        'has_global_episode',
        'reference_project_ids',
        'inherited',
    ):
        value.pop(field, None)
    return EntitySearchResult(
        **value,
        space_id=space_id,
        created_at=created_at,
        last_human_changed_at=last_human_changed_at,
        last_agent_viewed_at=last_agent_viewed_at,
        last_agent_reviewed_at=last_agent_reviewed_at,
        last_used_at=last_used_at,
        confirmation_basis=(
            ConfirmationBasis.model_validate(basis) if basis else None
        ),
        score=score,
    )


async def _entity_names(store, edges: list[EntityEdge]) -> dict[str, str]:
    uuids = list({
        uuid
        for edge in edges
        for uuid in (edge.source_node_uuid, edge.target_node_uuid)
    })
    if not uuids:
        return {}
    records, _, _ = await store.runtime.driver.execute_query(
        'MATCH (n:Entity) WHERE n.uuid IN $uuids RETURN n.uuid AS uuid, n.name AS name',
        uuids=uuids,
        routing_='r',
    )
    return {record['uuid']: record['name'] for record in records}


def _relevance(query: str, record) -> float:
    needle = _normalized(query)
    haystack = _normalized(' '.join(filter(None, [
        record.get('name'), record.get('type'), record.get('summary'),
        record.get('reasoning_summary'), record.get('profile_aspect'),
    ])))
    if not needle:
        return 0.0
    score = 8.0 if needle in haystack else 0.0
    terms = _terms(needle)
    if terms:
        coverage = len(terms & _terms(haystack)) / len(terms)
        if not score and coverage < MIN_TERM_COVERAGE:
            return 0.0
        score += coverage * 4.0
    if score and record.get('profile_aspect'):
        score += 0.25
    return round(score, 4)


def _edge_relevance(query: str, edge, names: dict[str, str], position: int, total: int) -> float:
    lexical = _relevance(query, {
        'name': edge.name,
        'type': 'Relationship',
        'summary': ' '.join(filter(None, [
            edge.fact,
            names.get(edge.source_node_uuid),
            names.get(edge.target_node_uuid),
        ])),
        'reasoning_summary': None,
        'profile_aspect': None,
    })
    if lexical == 0:
        return 0.0
    semantic_order = max(0.0, (total - position) / max(total, 1)) * 0.5
    return round(lexical + semantic_order, 4)


def _terms(value: str) -> set[str]:
    latin = {
        term for term in re.findall(r'[a-z0-9_]+', value)
        if term not in LATIN_QUERY_FILLERS
    }
    chinese = ''.join(re.findall(r'[\u4e00-\u9fff]', value))
    for filler in CHINESE_QUERY_FILLERS:
        chinese = chinese.replace(filler, '')
    grams = {chinese[index:index + 2] for index in range(max(0, len(chinese) - 1))}
    return latin | grams


def _timestamp(value) -> float:
    native = _native_datetime(value)
    return native.timestamp() if isinstance(native, datetime) else 0.0
