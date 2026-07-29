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
    if personal_space:
        allowed = await personal_edge_ids(
            store,
            personal_space,
            request.personal_project_ids,
            request.include_personal_global,
            [edge.uuid for edge in edges],
        )
        edges = [edge for edge in edges if edge.uuid in allowed]
    epistemic = await read_edge_epistemic_metadata(store, [edge.uuid for edge in edges])
    if not request.include_pending:
        edges = [
            edge for edge in edges
            if is_default_retrievable(epistemic.get(edge.uuid, {}))
        ]
    names = await _entity_names(store, edges)
    ranked_edges = sorted(
        (
            (_edge_relevance(request.query, edge, names, position, len(edges)), edge)
            for position, edge in enumerate(edges)
        ),
        key=lambda item: item[0],
        reverse=True,
    )
    ranked_edges = [item for item in ranked_edges if item[0] > 0][: request.limit]
    entities = await _personal_entities(store, personal_space, request) if personal_space else []
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
    if not edge_ids or (not project_ids and not include_personal_global):
        return set()
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
        WITH edge, assignment, episodes,
             collect(DISTINCT reference.project_id) AS reference_project_ids
        WHERE (
          edge.fuli_profile_aspect IS NOT NULL
          AND (
               (coalesce(edge.fuli_preference_scope, 'global') = 'global'
                AND $include_personal_global)
            OR (edge.fuli_preference_scope = 'project'
                AND edge.fuli_preference_project_id IN $project_ids)
          )
        ) OR (
          edge.fuli_profile_aspect IS NULL
          AND (
               (assignment.project_id IS NOT NULL AND assignment.project_id IN $project_ids)
            OR (assignment.project_id IS NULL AND (
                 any(episode IN episodes
                     WHERE episode.fuli_personal_project_id IN $project_ids)
                 OR ($include_personal_global AND
                     any(episode IN episodes
                         WHERE episode.fuli_personal_project_id IS NULL))
               ))
            OR any(project_id IN reference_project_ids WHERE project_id IN $project_ids)
          )
        )
        RETURN edge.uuid AS id
        ''',
        group_id=space['group_id'],
        space_id=space['id'],
        project_ids=project_ids,
        include_personal_global=include_personal_global,
        edge_ids=edge_ids,
        routing_='r',
    )
    return {record['id'] for record in records}


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


async def _personal_entities(store, space, request: SearchRequest) -> list[EntitySearchResult]:
    if not request.personal_project_ids and not request.include_personal_global:
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
        WHERE ((
          node.fuli_profile_aspect IS NOT NULL
          AND (
               (coalesce(node.fuli_preference_scope, 'global') = 'global'
                AND $include_personal_global)
            OR (node.fuli_preference_scope = 'project'
                AND node.fuli_preference_project_id IN $project_ids)
          )
        ) OR (
          node.fuli_profile_aspect IS NULL
          AND (
               (assignment.project_id IS NOT NULL AND assignment.project_id IN $project_ids)
            OR (assignment.project_id IS NULL AND any(
                  episode IN episodes
                  WHERE episode.fuli_personal_project_id IN $project_ids
                ))
            OR (assignment.project_id IS NULL AND $include_personal_global AND any(
                  episode IN episodes
                  WHERE episode.fuli_personal_project_id IS NULL
                ))
            OR any(reference IN references WHERE reference.project_id IN $project_ids)
          )
        ))
          AND ($include_historical OR node.fuli_invalid_at IS NULL)
          AND (
            $include_pending
            OR coalesce(node.fuli_confirmation_status, 'pending') = 'confirmed'
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
               coalesce(node.fuli_human_edited, false) AS human_edited,
               coalesce(node.fuli_human_change_status, 'none')
                 AS human_change_status,
               coalesce(node.fuli_human_change_version, 0)
                 AS human_change_version,
               node.fuli_last_human_changed_at AS last_human_changed_at,
               node.fuli_last_agent_viewed_at AS last_agent_viewed_at,
               node.fuli_last_agent_reviewed_at AS last_agent_reviewed_at
        ORDER BY node.created_at DESC
        LIMIT $candidate_limit
        ''',
        group_id=space['group_id'],
        space_id=space['id'],
        project_ids=request.personal_project_ids,
        include_personal_global=request.include_personal_global,
        include_historical=request.include_historical,
        include_pending=request.include_pending,
        candidate_limit=min(store.settings.graph_limit, max(request.limit * 20, 100)),
        routing_='r',
    )
    ranked = sorted(
        ((record, _relevance(request.query, record)) for record in records),
        key=lambda item: (item[1], _timestamp(item[0].get('created_at'))),
        reverse=True,
    )
    ranked = [item for item in ranked if item[1] > 0][: request.limit]
    return [
        _entity_search_result(record, score, space['id'])
        for record, score in ranked
    ]


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
    return EntitySearchResult(
        **value,
        space_id=space_id,
        created_at=created_at,
        last_human_changed_at=last_human_changed_at,
        last_agent_viewed_at=last_agent_viewed_at,
        last_agent_reviewed_at=last_agent_reviewed_at,
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
