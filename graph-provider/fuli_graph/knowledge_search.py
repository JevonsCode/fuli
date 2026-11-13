import math
import re
from datetime import datetime

from fastapi import HTTPException
from graphiti_core.edges import EntityEdge

from .models import ConfirmationBasis, EntitySearchResult, SearchRequest, SearchResult
from .personal_project_access import authorize_personal_project
from .project_agent_access import authorize_project_agent
from .provider_values import (
    json_object,
    native_datetime as _native_datetime,
    normalized_text as _normalized,
    preference_key,
    preference_qualifiers,
)
from .search_projection import (
    effective_confirmation_status,
    fact_result,
    is_default_retrievable,
    read_edge_epistemic_metadata,
    source_uris_from_references,
)
from .knowledge_semantic import cosine_parts, fused_ranking, standing_out, usable_cosine, vector_norm
from .knowledge_sensitivity import normal_safe_ids
from .knowledge_weight import knowledge_weight, ranking_weight
from .knowledge_tag_ranking import TagRanking
from .knowledge_visibility import AgentReader, fla_endpoints_visible_cypher, fla_visible, reader_parameter

MIN_TERM_COVERAGE = 0.25
# How much of an item's rank its relevance alone decides; the rest scales with
# its knowledge weight. At 0.5 an exact match that is still pending ranks above a
# partial match a person confirmed, and no tag boost (at most 1.25) lifts an item
# flagged for attention above an unflagged one that matches as well.
RELEVANCE_SHARE = 0.5
# With the query's terms weighed by how few candidates carry them
# (_term_weights), a record must carry this share of the query's weight.
MIN_WEIGHTED_COVERAGE = 0.33
# ...and one of the terms it carries must be distinctive: carried by fewer
# than about one candidate in six. Carrying nearly the whole query needs no
# distinctive term.
DISTINCTIVE_TERM_WEIGHT = math.log(6)
WHOLE_QUERY_COVERAGE = 0.75
# Below this many candidates, how many carry a term says nothing about the
# term: every term counts the same, as without weights.
MIN_WEIGHED_CANDIDATES = 8
# A term no candidate carries is either a word nobody wrote down or two
# characters that only meet across a word boundary (按钮设计 -> 钮设): it
# counts against a match, at half the weight of the rarest real term.
UNSEEN_TERM_FACTOR = 0.5
# How many items with a vector of the query's model one search compares (rec#88).
SEMANTIC_CANDIDATE_LIMIT = 5000
# A preference key's separators, so `reply-language` is also the words "reply language".
_KEY_SEPARATORS = re.compile(r'[-_.:/]+')
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
    # After the longer forms above: the bare question words name nothing either.
    '什么', '如何', '哪些',
)


async def search_knowledge(store, actor: dict, request: SearchRequest, *, tag_explanations=None) -> SearchResult:
    spaces = [await store.authorize(actor, space_id, 'reader') for space_id in request.space_ids]
    personal_space = await _personal_search_space(store, actor, spaces, request)
    space_ids_by_group = {space['group_id']: space['id'] for space in spaces}
    group_ids = [space['group_id'] for space in spaces]
    edges = await store.runtime.graphiti.search(
        request.query,
        group_ids=group_ids,
        num_results=min(max(request.limit * 8, 40), 100),
    )
    # Relationships found only by their retrieval terms join the lexical ones (rec#92).
    edge_terms, term_edges = await _term_edge_candidates(store, personal_space, request)
    found = {edge.uuid for edge in edges}
    edges = [*edges, *(edge for edge in term_edges if edge.uuid not in found)]
    lexical_ids = {edge.uuid for edge in edges}
    # Relationships found by meaning pass the very same filters below.
    meaning_scores, meaning_edges = await _semantic_edge_candidates(store, personal_space, request)
    edges = [*edges, *(edge for edge in meaning_edges if edge.uuid not in lexical_ids)]
    if not request.include_historical:
        edges = [edge for edge in edges if edge.invalid_at is None]
    if request.max_sensitivity == 'normal':
        normal_ids = await normal_safe_ids(store, 'relationship', [edge.uuid for edge in edges])
        edges = [edge for edge in edges if edge.uuid in normal_ids]
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
    tag_ranking = await TagRanking.for_search(store, personal_space, request, project_scopes)
    in_scope_scores = {edge.uuid: meaning_scores[edge.uuid] for edge in edges if edge.uuid in meaning_scores}
    edges = [edge for edge in edges if edge.uuid in lexical_ids]
    matched_edges = [
        (_edge_relevance(request.query, edge, names, position, len(edges), edge_terms.get(edge.uuid)), edge)
        for position, edge in enumerate(edges)
    ]
    # Same score and weight: the closer match first (a band holds unequal matches).
    ranked_edges = [
        (score, edge) for score, _, edge in sorted(
            ((_ranked_relevance(matched, epistemic.get(edge.uuid, {})), matched, edge) for matched, edge in matched_edges),
            key=lambda item: (item[0], _tie_weight(epistemic.get(item[2].uuid, {})), item[1]),
            reverse=True,
        ) if score > 0
    ]
    meaning_edges = {edge.uuid: edge for edge in meaning_edges}
    ranked_edges, edge_matches = _fused_with_meaning(
        ranked_edges, [meaning_edges[edge_id] for edge_id in standing_out(in_scope_scores, request.limit)],
        lambda edge: edge.uuid)
    if personal_space:
        ranked_edges = _dedupe_ranked_edges(
            ranked_edges,
            epistemic,
            request.active_personal_project_id,
            request.project_agent_id,
        )
    ranked_edges = [(score, edge) for _, score, edge in await tag_ranking.rerank(
        [(edge.uuid, score, edge) for score, edge in ranked_edges], 'relationship', tag_explanations
    )][: request.limit]
    entities = (
        await _personal_entities(
            store,
            personal_space,
            request,
            project_scopes,
            tag_ranking,
            tag_explanations,
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
                update={'score': score, 'matched_by': edge_matches.get(edge.uuid, 'lexical')}
            )
            for score, edge in ranked_edges
        ],
        entities=entities,
    )


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
        MATCH (source)-[edge:RELATES_TO {group_id: $group_id}]->(target)
        WHERE edge.uuid IN $edge_ids
          AND size(coalesce(edge.fuli_unresolved_bases, [])) = 0
        WITH edge, ''' + fla_endpoints_visible_cypher('source', 'target') + ''' AS endpoints_visible
        OPTIONAL MATCH (assignment:FuliKnowledgeAssignment {
          space_id: $space_id,
          item_kind: 'relationship',
          item_id: edge.uuid
        })
        WITH edge, endpoints_visible, assignment
        OPTIONAL MATCH (episode:Episodic {group_id: $group_id})
        WHERE episode.uuid IN coalesce(edge.episodes, [])
        WITH edge, endpoints_visible, assignment, collect(DISTINCT episode) AS episodes
        OPTIONAL MATCH (:FuliSpace {id: $space_id})-[:HAS_KNOWLEDGE_REFERENCE]->
              (reference:FuliKnowledgeProjectReference {
                item_kind: 'relationship', item_id: edge.uuid, status: 'active'
              })
        RETURN edge.uuid AS id, endpoints_visible,
               edge.fuli_profile_aspect AS profile_aspect,
               coalesce(edge.fuli_preference_scope, 'global')
                 AS preference_scope,
               edge.fuli_preference_project_id AS preference_project_id,
               edge.fuli_preference_project_ids AS preference_project_ids,
               edge.fuli_preference_agent_id AS preference_agent_id,
               assignment.project_id AS assignment_project_id,
               [episode IN episodes
                 WHERE episode.fuli_personal_project_id IS NOT NULL |
                 episode.fuli_personal_project_id] AS episode_project_ids,
               [episode IN episodes
                 WHERE episode.fuli_project_agent_id IS NOT NULL |
                 episode.fuli_project_agent_id] AS episode_project_agent_ids,
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
        reader=reader_parameter(_search_reader(request)),
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
            AND relation.status = 'active'
            AND relation.confirmation_authority = 'human_review'
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
    if request.project_agent_id:
        agent = await authorize_project_agent(
            store,
            actor,
            space,
            request.active_personal_project_id,
            request.project_agent_id,
            require_active=True,
            require_memory=True,
        )
        request.project_agent_id = agent['agent_id']
    return space


async def _personal_entities(
    store,
    space,
    request: SearchRequest,
    project_scopes: dict[str, dict],
    tag_ranking=None,
    tag_explanations=None,
) -> list[EntitySearchResult]:
    if not project_scopes and not request.include_personal_global:
        return []
    scoped_records = await _scoped_entity_records(store, space, request, project_scopes)
    term_weights = _term_weights(request.query, scoped_records)
    ranked = _ranked_records([(record, _relevance(request.query, record, term_weights)) for record in scoped_records])
    meaning = await _semantic_entities(store, space, request, project_scopes)
    fused, entity_matches = _fused_with_meaning(
        [(score, record) for record, score in ranked], meaning, lambda record: record['id'])
    ranked = _dedupe_ranked_entities(
        [(record, score) for score, record in fused],
        request.active_personal_project_id,
        request.project_agent_id,
    )
    ranked = [(record, score) for _, score, record in await (tag_ranking or TagRanking()).rerank(
        [(record['id'], score, record) for record, score in ranked], 'entity', tag_explanations
    )][: request.limit]
    return [
        _entity_search_result(record, score, space['id'], entity_matches.get(record['id'], 'lexical'))
        for record, score in ranked
    ]


async def _scoped_entity_records(store, space, request: SearchRequest, project_scopes: dict[str, dict],
                                 *, semantic_model: str | None = None) -> list[dict]:
    """The entities this search may return, with their scope. With a
    semantic_model, only those carrying a vector of that model, and what
    its cosine with the query is made of: the same filters decide either way
    (rec#88)."""
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (node:Entity {group_id: $group_id})
        WHERE $semantic_model IS NULL OR node.fuli_semantic_model = $semantic_model
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
          AND size(coalesce(node.fuli_unresolved_bases, [])) = 0
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
               node.created_at AS created_at, node.fuli_invalid_at AS invalid_at,
               coalesce(node.fuli_origin_quadrant, 'known_known') AS origin_quadrant,
               coalesce(node.fuli_current_quadrant, 'known_known') AS current_quadrant,
               coalesce(node.fuli_epistemic_status, 'confirmed') AS epistemic_status,
               coalesce(node.fuli_confirmation_status, 'pending')
                 AS confirmation_status,
               node.fuli_confirmation_basis_json AS confirmation_basis_json,
               node.fuli_reasoning_summary AS reasoning_summary,
               node.fuli_attributes_json AS attributes_json,
               node.fuli_profile_aspect AS profile_aspect,
               CASE WHEN node.fuli_profile_aspect IS NULL THEN NULL
                    ELSE coalesce(node.fuli_preference_scope, 'global') END
                    AS preference_scope,
               node.fuli_preference_project_id AS preference_project_id,
               node.fuli_preference_project_ids AS preference_project_ids,
               node.fuli_preference_agent_id AS preference_agent_id,
               coalesce(node.fuli_key, node.uuid) AS key,
               assignment.project_id AS assignment_project_id,
               [episode IN episodes
                 WHERE episode.fuli_personal_project_id IS NOT NULL |
                 episode.fuli_personal_project_id] AS episode_project_ids,
               [episode IN episodes
                 WHERE episode.fuli_project_agent_id IS NOT NULL |
                 episode.fuli_project_agent_id] AS episode_project_agent_ids,
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
               node.fuli_last_used_at AS last_used_at,
               coalesce(node.fuli_negative_evidence_count, 0)
                 AS negative_evidence_count,
               coalesce(node.fuli_requires_attention, false)
                 AS requires_attention,
               node.fuli_last_feedback_kind AS last_feedback_kind,
               node.fuli_last_feedback_at AS last_feedback_at,
               node.fuli_retrieval_terms AS retrieval_terms,
               node.fuli_retrieval_context AS retrieval_context,
               <semantic parts>,
               CASE WHEN $semantic_model IS NOT NULL THEN node.fuli_semantic_hash END
                 AS semantic_hash,
               [episode IN episodes | episode.uuid] AS evidence_ids,
               [episode IN episodes
                 WHERE episode.fuli_source_uri IS NOT NULL |
                 {
                   uri: episode.fuli_source_uri,
                   reference_time: episode.valid_at,
                   created_at: episode.created_at
                 }] AS source_references
        ORDER BY node.name, node.uuid
        LIMIT $candidate_limit
        '''.replace('<semantic parts>',
                   cosine_parts('node.fuli_semantic_vector') if semantic_model else 'null AS semantic_dot'),
        group_id=space['group_id'],
        space_id=space['id'],
        project_ids=list(project_scopes),
        include_historical=request.include_historical,
        include_pending=request.include_pending,
        semantic_model=semantic_model,
        **({'query_vector': request.semantic.vector, 'length': len(request.semantic.vector)} if semantic_model else {}),
        candidate_limit=SEMANTIC_CANDIDATE_LIMIT if semantic_model else store.settings.graph_limit,
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
    if request.max_sensitivity == 'normal':
        normal_ids = await normal_safe_ids(store, 'entity', [record['id'] for record in scoped_records])
        scoped_records = [record for record in scoped_records if record['id'] in normal_ids]
    return scoped_records


async def _semantic_entities(store, space, request: SearchRequest, project_scopes: dict[str, dict]) -> list[dict]:
    """The in-scope entities that stand out for the query's meaning, best first."""
    if request.semantic is None:
        return []
    records = await _scoped_entity_records(store, space, request, project_scopes,
                                           semantic_model=request.semantic.model)
    query_norm = vector_norm(request.semantic.vector)
    by_id, scores = {}, {}
    for record in records:
        score = usable_cosine('entity', record, query_norm)
        if score is not None:
            by_id[record['id']], scores[record['id']] = record, score
    return [by_id[item_id] for item_id in standing_out(scores, request.limit)]


async def _semantic_edge_candidates(store, space, request: SearchRequest) -> tuple[dict, list[EntityEdge]]:
    """Every relationship of the personal space with a usable vector of the
    query's model and its cosine with the query, as candidates for the
    search's own filters (rec#88)."""
    if request.semantic is None or space is None:
        return {}, []
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (source:Entity)-[edge:RELATES_TO {group_id: $group_id}]->(target:Entity)
        WHERE edge.fuli_semantic_model = $semantic_model
          AND size(edge.fuli_semantic_vector) = $length
        RETURN edge.uuid AS uuid, source.uuid AS source_node_uuid, target.uuid AS target_node_uuid,
               edge.group_id AS group_id, edge.name AS name, edge.fact AS fact,
               coalesce(edge.episodes, []) AS episodes, edge.created_at AS created_at,
               edge.valid_at AS valid_at, edge.invalid_at AS invalid_at, edge.expired_at AS expired_at,
               <semantic parts>, edge.fuli_semantic_hash AS semantic_hash,
               edge.fuli_retrieval_terms AS retrieval_terms, edge.fuli_retrieval_context AS retrieval_context
        ORDER BY edge.uuid
        LIMIT $candidate_limit
        '''.replace('<semantic parts>', cosine_parts('edge.fuli_semantic_vector')),
        group_id=space['group_id'],
        semantic_model=request.semantic.model,
        query_vector=request.semantic.vector,
        length=len(request.semantic.vector),
        candidate_limit=SEMANTIC_CANDIDATE_LIMIT,
        routing_='r',
    )
    query_norm = vector_norm(request.semantic.vector)
    scores, edges = {}, []
    for record in records:
        score = usable_cosine('relationship', record, query_norm)
        if score is None:
            continue
        scores[record['uuid']] = score
        edges.append(_edge_from_record(record))
    return scores, edges


async def _term_edge_candidates(store, space, request: SearchRequest) -> tuple[dict, list[EntityEdge]]:
    """The retrieval terms of the personal space's relationships, by id, and
    the relationships the query finds through them, as candidates for the
    search's own filters (rec#92). Word search over facts alone never sees
    terms stored beside them."""
    if space is None:
        return {}, []
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (source:Entity)-[edge:RELATES_TO {group_id: $group_id}]->(target:Entity)
        WHERE edge.fuli_retrieval_terms IS NOT NULL
        RETURN edge.uuid AS uuid, source.uuid AS source_node_uuid, target.uuid AS target_node_uuid,
               edge.group_id AS group_id, edge.name AS name, edge.fact AS fact,
               coalesce(edge.episodes, []) AS episodes, edge.created_at AS created_at,
               edge.valid_at AS valid_at, edge.invalid_at AS invalid_at, edge.expired_at AS expired_at,
               edge.fuli_retrieval_terms AS retrieval_terms, edge.fuli_retrieval_context AS retrieval_context
        ORDER BY edge.uuid
        LIMIT $candidate_limit
        ''',
        group_id=space['group_id'],
        candidate_limit=SEMANTIC_CANDIDATE_LIMIT,
        routing_='r',
    )
    terms = {record['uuid']: {'retrieval_terms': record['retrieval_terms'],
                              'retrieval_context': record['retrieval_context']} for record in records}
    found = [_edge_from_record(record) for record in records
             if _relevance(request.query, {'summary': record['fact'], **terms[record['uuid']]}) > 0]
    return terms, found


def _edge_from_record(record) -> EntityEdge:
    return EntityEdge(
        uuid=record['uuid'], source_node_uuid=record['source_node_uuid'],
        target_node_uuid=record['target_node_uuid'], group_id=record['group_id'],
        name=record['name'] or '', fact=record['fact'] or '', episodes=list(record['episodes']),
        created_at=_native_datetime(record['created_at']), valid_at=_native_datetime(record['valid_at']),
        invalid_at=_native_datetime(record['invalid_at']), expired_at=_native_datetime(record['expired_at']),
    )


def _fused_with_meaning(lexical, meaning, item_id):
    """lexical: [(score, payload)] in its ranked order; meaning: [payload] best
    first. Without meaning the lexical result stands as it is. Otherwise every
    item's score is its reciprocal rank fusion value; an item found only by
    meaning never met the term-coverage cut. Returns the ranked
    [(score, payload)] and {item id: matched_by}."""
    if not meaning:
        return lexical, {}
    fused = fused_ranking([item_id(payload) for _, payload in lexical], [item_id(payload) for payload in meaning])
    payloads = {item_id(payload): payload for payload in meaning}
    payloads.update({item_id(payload): payload for _, payload in lexical})
    ranked = sorted(((fused[key][0], payloads[key]) for key in fused), key=lambda item: -item[0])
    return ranked, {key: matched_by for key, (_, matched_by) in fused.items()}


def _item_scope_metadata(
    record,
    request: SearchRequest,
    project_scopes: dict[str, dict],
    include_personal_global: bool,
) -> dict | None:
    if not fla_visible(record, _search_reader(request)):
        return None
    profile_aspect = record.get('profile_aspect')
    if profile_aspect:
        preference_scope = record.get('preference_scope') or 'global'
        if preference_scope == 'global':
            if not include_personal_global:
                return None
            return _global_scope_metadata()
        project_id = record.get('preference_project_id')
        if preference_scope == 'agent':
            if project_id not in request.personal_project_ids:
                return None
            return _agent_scope_metadata(
                project_id,
                project_scopes[project_id],
                record.get('preference_agent_id'),
            )
        project_ids = record.get('preference_project_ids') or [project_id]
        candidates = [pid for pid in project_ids if pid in request.personal_project_ids and pid in project_scopes]
        if not candidates:
            return None
        selected = min(candidates, key=lambda pid: (pid != request.active_personal_project_id, pid))
        return _project_scope_metadata(selected, project_scopes[selected])

    assignment_project_id = record.get('assignment_project_id')
    episode_project_ids = list(record.get('episode_project_ids') or [])
    if record.get('episode_project_agent_ids'):
        return _agent_scope_metadata(
            request.active_personal_project_id,
            project_scopes[request.active_personal_project_id],
            request.project_agent_id,
        )
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
    # A later project assignment, or an existing project origin, takes
    # precedence over a historical unscoped episode. It is not global access.
    if (
        include_personal_global
        and record.get('has_global_episode')
        and not assignment_project_id
        and not episode_project_ids
    ):
        return _global_scope_metadata()
    return None


def _search_reader(request: SearchRequest) -> AgentReader:
    # The FLA was authorized in _personal_search_space; search shows no
    # FLA-scoped item to the person's console either unless it names the FLA.
    return AgentReader(request.active_personal_project_id, request.project_agent_id)


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


def _agent_scope_metadata(project_id: str, scope: dict, agent_id: str) -> dict:
    return {
        **_project_scope_metadata(project_id, scope),
        'project_agent_id': agent_id,
        'inherited_from_project_id': None,
        'scope_distance': 0,
        'scope_path': [project_id],
        'inherited': False,
    }


def _ranked_records(matched_records):
    """Records with how well each matched, best first as (record, score). At
    the same score and weight the closer match comes first, then the newer: a
    band holds unequal matches, and the newer one is not the better answer."""
    return [
        (record, score) for record, score, _ in sorted(
            ((record, _ranked_relevance(matched, record), matched) for record, matched in matched_records),
            key=lambda item: (item[1], _tie_weight(item[0]), item[2], _timestamp(item[0].get('created_at'))),
            reverse=True,
        ) if score > 0
    ]


def _ranked_relevance(base_score: float, metadata) -> float:
    """Relevance first, then the item's knowledge weight (the one people see):
    at equal relevance the stronger confirmation always ranks higher, but a
    weak match no longer outranks a strong one only because it is confirmed."""
    if base_score <= 0:
        return 0.0
    scope_distance = int(metadata.get('scope_distance') or 0)
    scope_factor = max(0.65, 1.0 - scope_distance * 0.15)
    weight = ranking_weight(metadata, evidence_ids=metadata.get('evidence_ids') or [])
    return round(_relevance_band(base_score) * (RELEVANCE_SHARE + (1 - RELEVANCE_SHARE) * weight) * scope_factor, 4)


def _relevance_band(base_score: float) -> float:
    """Relevance in whole steps: items that match about equally well share a
    band, so inside it the weight alone orders them (a small difference in
    semantic order never puts a pending item above a confirmed one)."""
    # Half a step is what semantic order adds at most (_edge_relevance): it stays in the band.
    return float(math.ceil(base_score - 0.5)) or base_score


def _scope_precedence(
    metadata,
    active_project_id: str | None,
    project_agent_id: str | None = None,
) -> tuple:
    project_id = metadata.get('defined_project_id')
    return (
        0 if project_agent_id and metadata.get('project_agent_id') == project_agent_id else 1,
        0 if active_project_id and project_id == active_project_id else 1,
        1 if metadata.get('inherited_from_project_id') else 0,
        int(metadata.get('scope_distance') or 0),
    )


def _dedupe_ranked_edges(
    ranked,
    metadata_by_id,
    active_project_id,
    project_agent_id=None,
):
    selected = {}
    for score, edge in ranked:
        metadata = metadata_by_id.get(edge.uuid, {})
        key = _dedupe_key(metadata.get('key'), edge.uuid, edge.invalid_at)
        quality = (
            _scope_precedence(metadata, active_project_id, project_agent_id),
            -score,
            edge.uuid,
        )
        current = selected.get(key)
        if current is None or quality < current[0]:
            selected[key] = (quality, score, edge)
    return sorted(
        ((score, edge) for _, score, edge in selected.values()),
        key=lambda item: (-item[0], -_tie_weight(metadata_by_id.get(item[1].uuid, {})), _scope_precedence(
            metadata_by_id.get(item[1].uuid, {}), active_project_id, project_agent_id), item[1].uuid),
    )


def _dedupe_ranked_entities(ranked, active_project_id, project_agent_id=None):
    selected = {}
    for record, score in ranked:
        key = _dedupe_key(record.get('key'), record.get('id'), record.get('invalid_at'))
        quality = (
            _scope_precedence(record, active_project_id, project_agent_id),
            -score,
            record['id'],
        )
        current = selected.get(key)
        if current is None or quality < current[0]:
            selected[key] = (quality, record, score)
    return sorted(
        ((record, score) for _, record, score in selected.values()),
        key=lambda item: (-item[1], -_tie_weight(item[0]), _scope_precedence(
            item[0], active_project_id, project_agent_id), item[0]['id']),
    )


def _dedupe_key(key, item_id, invalid_at):
    """One current item per key across scopes. A historical version, asked
    for explicitly, never stands in for the current one: each is its own."""
    return ('current', key or item_id) if invalid_at is None else ('historical', item_id)


def _tie_weight(metadata) -> float:
    """At equal score, the heavier item comes first."""
    return ranking_weight(metadata, evidence_ids=metadata.get('evidence_ids') or [])


def _entity_search_result(record, score: float, space_id: str, matched_by: str = 'lexical') -> EntitySearchResult:
    value = dict(record)
    value.update(knowledge_weight(record, evidence_ids=value.pop('evidence_ids', [])))
    attributes = json_object(value.get('attributes_json'))
    value['preference_key'] = preference_key(attributes, value.get('key'), value.get('id'))
    value['preference_qualifiers'] = preference_qualifiers(attributes)
    basis = json_object(value.pop('confirmation_basis_json', None))
    source_references = value.pop('source_references', [])
    created_at = _native_datetime(value.pop('created_at', None))
    invalid_at = _native_datetime(value.pop('invalid_at', None))
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
    last_feedback_at = _native_datetime(
        value.pop('last_feedback_at', None)
    )
    for field in (
        'attributes_json',
        'preference_project_ids',
        'assignment_project_id',
        'episode_project_ids',
        'episode_project_agent_ids',
        'has_global_episode',
        'reference_project_ids',
        'inherited',
        'semantic_dot',
        'semantic_norm2',
        'semantic_hash',
        'retrieval_terms',
        'retrieval_context',
    ):
        value.pop(field, None)
    return EntitySearchResult(
        **value,
        space_id=space_id,
        created_at=created_at,
        invalid_at=invalid_at,
        last_human_changed_at=last_human_changed_at,
        last_agent_viewed_at=last_agent_viewed_at,
        last_agent_reviewed_at=last_agent_reviewed_at,
        last_used_at=last_used_at,
        last_feedback_at=last_feedback_at,
        confirmation_basis=(
            ConfirmationBasis.model_validate(basis) if basis else None
        ),
        source_uris=source_uris_from_references(source_references),
        score=score,
        matched_by=matched_by,
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


def _haystack(record) -> str:
    return _normalized(' '.join(filter(None, [
        record.get('name'), record.get('type'), record.get('summary'),
        record.get('reasoning_summary'), record.get('profile_aspect'), record.get('retrieval_context'),
    ])))


def _term_weights(query: str, records) -> dict[str, float]:
    """How much each term of the query tells apart the records this search
    may return: a word most of them carry (the product's name, 控制台, fla)
    says little, one few carry says a lot. Sharing only common words with the
    query is then not a match (rec#111). The usual inverse document frequency,
    over the search's own candidates; empty (no weighing) for a handful of them."""
    terms = _terms(_normalized(query))
    if not terms or len(records) < MIN_WEIGHED_CANDIDATES:
        return {}
    carried = dict.fromkeys(terms, 0)
    for record in records:
        for term in terms & _terms(_haystack(record)):
            carried[term] += 1
    total = len(records)
    return {term: math.log((total - count + 0.5) / (count + 0.5) + 1) * (1.0 if count else UNSEEN_TERM_FACTOR)
            for term, count in carried.items()}


def _too_common(matched, coverage: float, term_weights: dict[str, float]) -> bool:
    """Not a match: too little of the query's weight, or only words most candidates carry."""
    if coverage < MIN_WEIGHTED_COVERAGE:
        return True
    return (coverage < WHOLE_QUERY_COVERAGE
            and max((term_weights.get(term, 0.0) for term in matched), default=0.0) < DISTINCTIVE_TERM_WEIGHT)


def _relevance(query: str, record, term_weights: dict[str, float] | None = None) -> float:
    needle = _normalized(query)
    haystack = _haystack(record)
    if not needle:
        return 0.0
    score = 8.0 if needle in haystack or _joined(needle) in _joined(haystack) else 0.0
    score = max(score, _alias_relevance(needle, _retrieval_aliases(record)))
    terms = _terms(needle)
    if terms:
        matched = terms & _terms(haystack)
        whole = sum(term_weights.get(term, 1.0) for term in terms) if term_weights else len(terms)
        coverage = (sum(term_weights.get(term, 1.0) for term in matched) if term_weights else len(matched)) / whole
        if not score and (_too_common(matched, coverage, term_weights) if term_weights
                          else coverage < MIN_TERM_COVERAGE):
            return 0.0
        score += coverage * 4.0
    if score and record.get('profile_aspect'):
        score += 0.25
    return round(score, 4)


def _edge_relevance(query: str, edge, names: dict[str, str], position: int, total: int,
                    retrieval: dict | None = None) -> float:
    lexical = _relevance(query, {
        **(retrieval or {}),
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


# 的 and 之 between two Chinese characters only link them: 控制台的端口 is the
# phrase 控制台端口, as a whole and in its two-character terms.
_LINKING_PARTICLE = re.compile(r'(?<=[一-鿿])[的之](?=[一-鿿])')


def _joined(value: str) -> str:
    return _LINKING_PARTICLE.sub('', value)


def _terms(value: str) -> set[str]:
    value = _joined(value)
    latin = {
        _word_stem(term) for term in re.findall(r'[a-z0-9_]+', value)
        if term not in LATIN_QUERY_FILLERS
    }
    chinese_segments = re.findall(r'[\u4e00-\u9fff]+', value)
    grams = set()
    for chinese in chinese_segments:
        for filler in CHINESE_QUERY_FILLERS:
            chinese = chinese.replace(filler, '')
        grams.update(
            chinese[index:index + 2]
            for index in range(max(0, len(chinese) - 1))
        )
    return latin | grams


def _word_stem(term: str) -> str:
    """One English word form for its inflections, applied to both sides of a
    match: "owns", "owned" and "owner" meet, as do "codes" and "code"; a
    question names a concept in whatever form it happens to use (rec#63)."""
    if not term.isalpha() or len(term) < 4:
        return term
    if term.endswith('ies') and len(term) > 4:
        term = term[:-3] + 'y'
    elif term.endswith('s') and not term.endswith(('ss', 'us', 'is')):
        term = term[:-1]
    for suffix in ('ing', 'ed', 'er'):
        if term.endswith(suffix) and len(term) - len(suffix) >= 3:
            term = term[:-len(suffix)]
            break
    return term[:-1] if term.endswith('e') and len(term) > 3 else term


def _retrieval_aliases(record) -> list[str]:
    attributes = record.get('attributes')
    if not isinstance(attributes, dict):
        attributes = json_object(record.get('attributes_json'))
    values = (
        attributes.get('searchTerms')
        or attributes.get('search_terms')
        or []
    )
    if isinstance(values, str):
        values = [values]
    if not isinstance(values, list):
        return []
    # Terms stored beside the item later count like those it was saved with (rec#92).
    stored = record.get('retrieval_terms')
    values = [*values, *(stored if isinstance(stored, list) else [])]
    aliases = [
        value.strip()
        for value in values[:64]
        if isinstance(value, str) and 0 < len(value.strip()) <= 256
    ]
    # A preference is found by its key, as written and as words (rec#75).
    if record.get('profile_aspect'):
        key = preference_key(attributes, record.get('key'), None)
        if isinstance(key, str) and 0 < len(key.strip()) <= 256:
            aliases += [key.strip(), _KEY_SEPARATORS.sub(' ', key).strip()]
    return aliases


def _alias_relevance(query: str, aliases: list[str]) -> float:
    query_terms = _terms(query)
    best = 0.0
    for alias in aliases:
        normalized_alias = _normalized(alias)
        if not normalized_alias:
            continue
        if normalized_alias in query:
            best = max(best, 8.0)
            continue
        alias_terms = _terms(normalized_alias)
        if len(alias_terms) < 2:
            continue
        coverage = len(alias_terms & query_terms) / len(alias_terms)
        if coverage >= 0.75:
            best = max(best, 6.0 + coverage * 2.0)
    return round(best, 4)


def _timestamp(value) -> float:
    native = _native_datetime(value)
    return native.timestamp() if isinstance(native, datetime) else 0.0
