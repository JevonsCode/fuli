from .graph_projection import (
    coalesce_personal_project_identities,
    coalesce_personal_project_identity,
    management_projection,
    personal_project_projection,
)
from .graph_models import GraphEdge, GraphNode, GraphResult
from .models import (
    ConfirmationBasis,
    GraphEvidence,
)
from .knowledge_audit import read_knowledge_audits
from .knowledge_records import assignment_record, revision_record
from .personal_project_access import authorize_personal_project
from .provider_values import (
    json_object,
    native_datetime as _native_datetime,
    preference_qualifiers,
)
from .project_knowledge import (
    read_knowledge_conflicts,
    read_personal_project_relations,
    read_project_references,
)
from .search_projection import effective_confirmation_status


async def read_graph(
    store,
    actor: dict,
    space_id: str,
    limit: int | None = None,
    personal_project_id: str | None = None,
    offset: int | None = None,
) -> GraphResult:
    space = await store.authorize(actor, space_id, 'reader')
    project = None
    if personal_project_id:
        project = await authorize_personal_project(store, actor, space, personal_project_id)
    bounded_limit = min(limit or store.settings.graph_limit, store.settings.graph_limit)
    paginated = offset is not None
    page_offset = offset or 0
    node_records, _, _ = await store.runtime.driver.execute_query(
        _node_query(bool(project), paginated),
        space_id=space_id,
        group_id=space['group_id'],
        project_id=personal_project_id,
        limit=bounded_limit + 1,
        offset=page_offset,
        routing_='r',
    )
    nodes_truncated = len(node_records) > bounded_limit
    node_records = node_records[:bounded_limit]
    node_ids = [record['id'] for record in node_records]
    episode_ids = list({
        episode_id
        for record in node_records
        for episode_id in (record.get('episodes') or [])
    })
    edge_records, _, _ = await store.runtime.driver.execute_query(
        _edge_query(bool(project), paginated),
        space_id=space_id,
        group_id=space['group_id'],
        project_id=personal_project_id,
        node_ids=node_ids,
        episode_ids=episode_ids,
        limit=bounded_limit + 1 if paginated else bounded_limit,
        offset=page_offset,
        routing_='r',
    )
    edges_truncated = paginated and len(edge_records) > bounded_limit
    if paginated:
        edge_records = edge_records[:bounded_limit]
    truncated = nodes_truncated or edges_truncated
    all_episode_ids = list({
        *episode_ids,
        *(episode_id for record in edge_records for episode_id in (record.get('episodes') or [])),
    })
    evidence = await _read_evidence(store, all_episode_ids)
    item_ids = node_ids + [record['id'] for record in edge_records]
    revisions = await _read_revisions(store, space_id, item_ids)
    assignments = await _read_assignments(store, space_id, item_ids)
    references = await read_project_references(store, space_id, item_ids)
    conflicts = await read_knowledge_conflicts(store, space_id, item_ids)
    audits = await read_knowledge_audits(store, space_id, item_ids)
    knowledge_nodes = [
        _graph_node(
            record,
            evidence,
            revisions,
            assignments,
            references,
            conflicts,
            audits,
        )
        for record in node_records
    ]
    knowledge_edges = [
        _graph_edge(
            record,
            evidence,
            revisions,
            assignments,
            references,
            conflicts,
            audits,
        )
        for record in edge_records
    ]

    personal_relations = (
        await read_personal_project_relations(store, space_id)
        if space['kind'] == 'personal' else []
    )
    if project:
        management_nodes, management_edges = personal_project_projection(
            space, project, personal_relations
        )
        graph_nodes, graph_edges = coalesce_personal_project_identity(
            project,
            management_nodes,
            management_edges,
            knowledge_nodes,
            knowledge_edges,
        )
    else:
        personal_projects = await _personal_projects(store, space)
        management_nodes, management_edges = management_projection(
            space, personal_projects, personal_relations
        )
        graph_nodes, graph_edges = coalesce_personal_project_identities(
            personal_projects,
            management_nodes,
            management_edges,
            knowledge_nodes,
            knowledge_edges,
        )
    return GraphResult(
        space_id=space_id,
        nodes=graph_nodes,
        edges=graph_edges,
        truncated=truncated,
        next_offset=(page_offset + bounded_limit) if paginated and truncated else None,
    )


def _node_query(project_scoped: bool, paginated: bool = False) -> str:
    if project_scoped:
        match = '''
        MATCH (node:Entity {group_id: $group_id})
        OPTIONAL MATCH (episode:Episodic {group_id: $group_id})-[:MENTIONS]->(node)
        WITH node, collect(DISTINCT episode) AS knowledge_episodes
        OPTIONAL MATCH (assignment:FuliKnowledgeAssignment {
          space_id: $space_id,
          item_kind: 'entity',
          item_id: node.uuid
        })
        OPTIONAL MATCH (:FuliSpace {id: $space_id})-[:HAS_KNOWLEDGE_REFERENCE]->
              (reference:FuliKnowledgeProjectReference {
                item_kind: 'entity', item_id: node.uuid
              })
        WITH node, knowledge_episodes, assignment, collect(reference) AS references
        WHERE (
          (
            node.fuli_profile_aspect IS NOT NULL
            AND node.fuli_preference_scope = 'project'
            AND node.fuli_preference_project_id = $project_id
          )
          OR (
            node.fuli_profile_aspect IS NULL
            AND (
                 (assignment.project_id IS NOT NULL AND assignment.project_id = $project_id)
              OR (assignment.project_id IS NULL AND any(
                    episode IN knowledge_episodes
                    WHERE episode.fuli_personal_project_id = $project_id
                  ))
              OR any(reference IN references WHERE
                   reference.project_id = $project_id AND reference.status = 'active')
            )
          )
        )
          AND NOT EXISTS {
            MATCH (:FuliSpace {id: $space_id})-[:HAS_KNOWLEDGE_CONFLICT]->
                  (conflict:FuliKnowledgeConflict)
            WHERE conflict.target_project_id = $project_id
              AND conflict.target_item_id = node.uuid
              AND conflict.status = 'resolved'
              AND conflict.resolution = 'use_source'
          }
        WITH node, knowledge_episodes AS episodes
        '''
    else:
        match = '''
        MATCH (node:Entity {group_id: $group_id})
        OPTIONAL MATCH (episode:Episodic {group_id: $group_id})-[:MENTIONS]->(node)
        WITH node, collect(DISTINCT episode) AS episodes
        '''
    pagination = 'SKIP $offset LIMIT $limit' if paginated else 'LIMIT $limit'
    return match + '''
        RETURN node.uuid AS id, node.name AS name, node.group_id AS group_id,
               coalesce(node.fuli_type, 'Entity') AS type,
               coalesce(node.summary, '') AS summary,
               coalesce(node.fuli_origin_quadrant, 'known_known') AS origin_quadrant,
               coalesce(node.fuli_current_quadrant, 'known_known') AS current_quadrant,
               coalesce(node.fuli_epistemic_status, 'confirmed') AS epistemic_status,
               node.fuli_origin_quadrant IS NOT NULL AS epistemic_state_explicit,
               coalesce(node.fuli_confirmation_status, 'pending')
                 AS confirmation_status,
               node.fuli_confirmation_status IS NOT NULL
                 AND node.fuli_confirmation_basis_json IS NOT NULL
                 AS confirmation_state_explicit,
               node.fuli_confirmation_basis_json AS confirmation_basis_json,
               node.fuli_reasoning_summary AS reasoning_summary,
               node.fuli_profile_aspect AS profile_aspect,
               CASE WHEN node.fuli_profile_aspect IS NULL THEN NULL
                    ELSE coalesce(node.fuli_preference_scope, 'global') END
                    AS preference_scope,
               node.fuli_preference_project_id AS preference_project_id,
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
               coalesce(node.fuli_usage_generation, 1) AS usage_generation,
               coalesce(node.fuli_attributes_json, '{}') AS attributes_json,
               coalesce(node.fuli_key, node.uuid) AS key,
               [episode IN episodes WHERE episode IS NOT NULL | episode.uuid] AS episodes,
               node.created_at AS created_at,
               node.fuli_invalid_at AS invalid_at,
               node.fuli_replaced_by_item_id AS replaced_by_item_id,
               node.fuli_replaced_by_item_kind AS replaced_by_item_kind
        ORDER BY created_at DESC, id DESC
    ''' + pagination


def _edge_query(project_scoped: bool, paginated: bool = False) -> str:
    if paginated:
        match = '''
        MATCH (source:Entity)-[edge:RELATES_TO {group_id: $group_id}]->(target:Entity)
        '''
        project_filter = '''
        OPTIONAL MATCH (assignment:FuliKnowledgeAssignment {
          space_id: $space_id,
          item_kind: 'relationship',
          item_id: edge.uuid
        })
        OPTIONAL MATCH (episode:Episodic {group_id: $group_id})
        WHERE episode.uuid IN coalesce(edge.episodes, [])
        WITH source, edge, target, assignment,
             collect(DISTINCT episode) AS knowledge_episodes
        WHERE (
          edge.fuli_profile_aspect IS NOT NULL
          AND edge.fuli_preference_scope = 'project'
          AND edge.fuli_preference_project_id = $project_id
        ) OR (
          edge.fuli_profile_aspect IS NULL
          AND (
               (assignment.project_id IS NOT NULL AND assignment.project_id = $project_id)
            OR (assignment.project_id IS NULL AND any(
                 episode IN knowledge_episodes
                 WHERE episode.fuli_personal_project_id = $project_id
               ))
          )
        )
        ''' if project_scoped else ''
    else:
        match = '''
        MATCH (source:Entity)-[edge:RELATES_TO {group_id: $group_id}]->(target:Entity)
        WHERE source.uuid IN $node_ids AND target.uuid IN $node_ids
        '''
        project_filter = '''
        OPTIONAL MATCH (assignment:FuliKnowledgeAssignment {
          space_id: $space_id,
          item_kind: 'relationship',
          item_id: edge.uuid
        })
        WITH source, edge, target, assignment
        WHERE (
          edge.fuli_profile_aspect IS NOT NULL
          AND edge.fuli_preference_scope = 'project'
          AND edge.fuli_preference_project_id = $project_id
        ) OR (
          edge.fuli_profile_aspect IS NULL
          AND (
               (assignment.project_id IS NOT NULL AND assignment.project_id = $project_id)
            OR (assignment.project_id IS NULL AND any(
                 episode_id IN coalesce(edge.episodes, [])
                 WHERE episode_id IN $episode_ids
               ))
          )
        )
        ''' if project_scoped else ''
    pagination = 'SKIP $offset LIMIT $limit' if paginated else 'LIMIT $limit'
    return match + project_filter + '''
        RETURN edge.uuid AS id, source.uuid AS source, target.uuid AS target,
               source.name AS source_name, target.name AS target_name,
               edge.name AS type, edge.fact AS fact,
               coalesce(edge.fuli_origin_quadrant, 'known_known') AS origin_quadrant,
               coalesce(edge.fuli_current_quadrant, 'known_known') AS current_quadrant,
               coalesce(edge.fuli_epistemic_status, 'confirmed') AS epistemic_status,
               edge.fuli_origin_quadrant IS NOT NULL AS epistemic_state_explicit,
               coalesce(edge.fuli_confirmation_status, 'pending')
                 AS confirmation_status,
               edge.fuli_confirmation_status IS NOT NULL
                 AND edge.fuli_confirmation_basis_json IS NOT NULL
                 AS confirmation_state_explicit,
               edge.fuli_confirmation_basis_json AS confirmation_basis_json,
               edge.fuli_reasoning_summary AS reasoning_summary,
               edge.fuli_profile_aspect AS profile_aspect,
               CASE WHEN edge.fuli_profile_aspect IS NULL THEN NULL
                    ELSE coalesce(edge.fuli_preference_scope, 'global') END
                    AS preference_scope,
               edge.fuli_preference_project_id AS preference_project_id,
               coalesce(edge.fuli_inheritance_mode, 'local_only')
                 AS inheritance_mode,
               coalesce(edge.fuli_inherited_project_ids, [])
                 AS inherited_project_ids,
               coalesce(edge.fuli_human_edited, false) AS human_edited,
               coalesce(edge.fuli_human_change_status, 'none')
                 AS human_change_status,
               coalesce(edge.fuli_human_change_version, 0)
                 AS human_change_version,
               edge.fuli_last_human_changed_at AS last_human_changed_at,
               edge.fuli_last_agent_viewed_at AS last_agent_viewed_at,
               edge.fuli_last_agent_reviewed_at AS last_agent_reviewed_at,
               coalesce(edge.fuli_utility_score, 0.0) AS utility_score,
               coalesce(edge.fuli_confidence_score, 0.5) AS confidence_score,
               coalesce(edge.fuli_qualified_use_count, 0)
                 AS qualified_use_count,
               coalesce(edge.fuli_distinct_task_count, 0)
                 AS distinct_task_count,
               edge.fuli_last_used_at AS last_used_at,
               coalesce(edge.fuli_negative_evidence_count, 0)
                 AS negative_evidence_count,
               coalesce(edge.fuli_requires_attention, false)
                 AS requires_attention,
               edge.fuli_last_feedback_kind AS last_feedback_kind,
               edge.fuli_last_feedback_at AS last_feedback_at,
               coalesce(edge.fuli_usage_generation, 1) AS usage_generation,
               edge.valid_at AS valid_at, edge.invalid_at AS invalid_at,
               edge.fuli_replaced_by_item_id AS replaced_by_item_id,
               edge.fuli_replaced_by_item_kind AS replaced_by_item_kind,
               edge.created_at AS created_at,
               edge.fuli_confidence AS confidence,
               coalesce(edge.fuli_attributes_json, '{}') AS attributes_json,
               coalesce(edge.fuli_key, edge.uuid) AS key,
               coalesce(edge.episodes, []) AS episodes
        ORDER BY created_at DESC, id DESC
    ''' + pagination


async def _personal_projects(store, space: dict) -> list[dict]:
    if space['kind'] != 'personal':
        return []
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (:FuliSpace {id: $space_id, kind: 'personal'})-
              [:CONTAINS_PROJECT]->(project:FuliPersonalProject)
        RETURN project ORDER BY project.updated_at DESC
        ''',
        space_id=space['id'],
        routing_='r',
    )
    return [dict(record['project']) for record in records]


async def _read_evidence(store, episode_ids: list[str]) -> dict[str, GraphEvidence]:
    if not episode_ids:
        return {}
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (episode:Episodic) WHERE episode.uuid IN $episode_ids
        RETURN episode.uuid AS id, episode.name AS name,
               episode.source_description AS source_description,
               coalesce(episode.fuli_source_kind, 'unknown') AS source_kind,
               episode.fuli_source_uri AS source_uri,
               coalesce(episode.fuli_summary, '') AS summary,
               episode.fuli_session_id AS session_id,
               episode.fuli_source_application AS source_application,
               episode.fuli_source_turn_id AS source_turn_id,
               episode.fuli_source_excerpt AS source_excerpt,
               episode.fuli_personal_project_id AS personal_project_id,
               episode.valid_at AS reference_time,
               episode.created_at AS created_at
        ''',
        episode_ids=episode_ids,
        routing_='r',
    )
    return {
        record['id']: GraphEvidence(
            **{
                **dict(record),
                'reference_time': _native_datetime(record.get('reference_time')),
                'created_at': _native_datetime(record.get('created_at')),
            }
        )
        for record in records
    }


async def _read_revisions(store, space_id: str, item_ids: list[str]):
    if not item_ids:
        return {}
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (:FuliSpace {id: $space_id, kind: 'personal'})-
              [:HAS_KNOWLEDGE_REVISION]->(revision:FuliKnowledgeRevision)
        WHERE revision.item_id IN $item_ids
        RETURN revision ORDER BY revision.created_at DESC
        ''',
        space_id=space_id,
        item_ids=item_ids,
        routing_='r',
    )
    result = {}
    for record in records:
        value = dict(record['revision'])
        result.setdefault(value['item_id'], []).append(revision_record(value))
    return result


async def _read_assignments(store, space_id: str, item_ids: list[str]):
    if not item_ids:
        return {}
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (:FuliSpace {id: $space_id, kind: 'personal'})-
              [:HAS_KNOWLEDGE_ASSIGNMENT]->(assignment:FuliKnowledgeAssignment)
        WHERE assignment.item_id IN $item_ids
        RETURN assignment
        ''',
        space_id=space_id,
        item_ids=item_ids,
        routing_='r',
    )
    result = {}
    for record in records:
        value = dict(record['assignment'])
        result.setdefault(value['item_id'], []).append(assignment_record(value))
    return result


def _graph_node(
    record,
    evidence,
    revisions,
    assignments,
    references,
    conflicts,
    audits=None,
) -> GraphNode:
    episode_ids = record.get('episodes') or []
    status, basis, confidence, confirmation_explicit = _confirmation_projection(
        record
    )
    attributes = json_object(record.get('attributes_json'))
    return GraphNode(
        id=record['id'],
        name=record['name'],
        type=record['type'],
        group_id=record['group_id'],
        summary=record['summary'],
        key=record.get('key') or record['id'],
        preference_key=(
            attributes.get('preferenceKey')
            or attributes.get('preference_key')
            or record.get('key')
            or record['id']
        ),
        preference_qualifiers=preference_qualifiers(attributes),
        origin_quadrant=record.get('origin_quadrant') or 'known_known',
        current_quadrant=record.get('current_quadrant') or 'known_known',
        epistemic_status=record.get('epistemic_status') or 'confirmed',
        epistemic_state_explicit=record.get('epistemic_state_explicit') is True,
        confirmation_status=status,
        confirmation_state_explicit=confirmation_explicit,
        confirmation_basis=basis,
        reasoning_summary=record.get('reasoning_summary'),
        profile_aspect=record.get('profile_aspect'),
        preference_scope=record.get('preference_scope'),
        preference_project_id=record.get('preference_project_id'),
        inheritance_mode=record.get('inheritance_mode') or 'local_only',
        inherited_project_ids=record.get('inherited_project_ids') or [],
        human_edited=record.get('human_edited') is True,
        human_change_status=record.get('human_change_status') or 'none',
        human_change_version=int(record.get('human_change_version') or 0),
        last_human_changed_at=_native_datetime(
            record.get('last_human_changed_at')
        ),
        last_agent_viewed_at=_native_datetime(
            record.get('last_agent_viewed_at')
        ),
        last_agent_reviewed_at=_native_datetime(
            record.get('last_agent_reviewed_at')
        ),
        utility_score=float(record.get('utility_score') or 0),
        confidence_score=confidence,
        qualified_use_count=int(record.get('qualified_use_count') or 0),
        distinct_task_count=int(record.get('distinct_task_count') or 0),
        last_used_at=_native_datetime(record.get('last_used_at')),
        negative_evidence_count=int(
            record.get('negative_evidence_count') or 0
        ),
        requires_attention=record.get('requires_attention') is True,
        last_feedback_kind=record.get('last_feedback_kind'),
        last_feedback_at=_native_datetime(record.get('last_feedback_at')),
        usage_generation=int(record.get('usage_generation') or 1),
        attributes=attributes,
        evidence=[evidence[item] for item in episode_ids if item in evidence],
        created_at=_native_datetime(record.get('created_at')),
        invalid_at=_native_datetime(record.get('invalid_at')),
        replaced_by_item_id=record.get('replaced_by_item_id'),
        replaced_by_item_kind=record.get('replaced_by_item_kind'),
        revisions=revisions.get(record['id'], []),
        assignments=assignments.get(record['id'], []),
        project_references=references.get(record['id'], []),
        conflicts=conflicts.get(record['id'], []),
        audit_events=(audits or {}).get(record['id'], []),
    )


def _graph_edge(
    record,
    evidence,
    revisions,
    assignments,
    references,
    conflicts,
    audits=None,
) -> GraphEdge:
    episode_ids = record.get('episodes') or []
    status, basis, confidence, confirmation_explicit = _confirmation_projection(
        record
    )
    attributes = json_object(record.get('attributes_json'))
    return GraphEdge(
        id=record['id'],
        source=record['source'],
        target=record['target'],
        source_name=record.get('source_name'),
        target_name=record.get('target_name'),
        type=record['type'],
        fact=record['fact'],
        key=record.get('key') or record['id'],
        preference_key=(
            attributes.get('preferenceKey')
            or attributes.get('preference_key')
            or record.get('key')
            or record['id']
        ),
        preference_qualifiers=preference_qualifiers(attributes),
        origin_quadrant=record.get('origin_quadrant') or 'known_known',
        current_quadrant=record.get('current_quadrant') or 'known_known',
        epistemic_status=record.get('epistemic_status') or 'confirmed',
        epistemic_state_explicit=record.get('epistemic_state_explicit') is True,
        confirmation_status=status,
        confirmation_state_explicit=confirmation_explicit,
        confirmation_basis=basis,
        reasoning_summary=record.get('reasoning_summary'),
        profile_aspect=record.get('profile_aspect'),
        preference_scope=record.get('preference_scope'),
        preference_project_id=record.get('preference_project_id'),
        inheritance_mode=record.get('inheritance_mode') or 'local_only',
        inherited_project_ids=record.get('inherited_project_ids') or [],
        human_edited=record.get('human_edited') is True,
        human_change_status=record.get('human_change_status') or 'none',
        human_change_version=int(record.get('human_change_version') or 0),
        last_human_changed_at=_native_datetime(
            record.get('last_human_changed_at')
        ),
        last_agent_viewed_at=_native_datetime(
            record.get('last_agent_viewed_at')
        ),
        last_agent_reviewed_at=_native_datetime(
            record.get('last_agent_reviewed_at')
        ),
        utility_score=float(record.get('utility_score') or 0),
        confidence_score=confidence,
        qualified_use_count=int(record.get('qualified_use_count') or 0),
        distinct_task_count=int(record.get('distinct_task_count') or 0),
        last_used_at=_native_datetime(record.get('last_used_at')),
        negative_evidence_count=int(
            record.get('negative_evidence_count') or 0
        ),
        requires_attention=record.get('requires_attention') is True,
        last_feedback_kind=record.get('last_feedback_kind'),
        last_feedback_at=_native_datetime(record.get('last_feedback_at')),
        usage_generation=int(record.get('usage_generation') or 1),
        valid_at=_native_datetime(record.get('valid_at')),
        invalid_at=_native_datetime(record.get('invalid_at')),
        replaced_by_item_id=record.get('replaced_by_item_id'),
        replaced_by_item_kind=record.get('replaced_by_item_kind'),
        created_at=_native_datetime(record.get('created_at')),
        confidence=record.get('confidence'),
        attributes=attributes,
        episodes=episode_ids,
        evidence=[evidence[item] for item in episode_ids if item in evidence],
        revisions=revisions.get(record['id'], []),
        assignments=assignments.get(record['id'], []),
        project_references=references.get(record['id'], []),
        conflicts=conflicts.get(record['id'], []),
        audit_events=(audits or {}).get(record['id'], []),
    )


def _confirmation_basis(value) -> ConfirmationBasis | None:
    data = json_object(value)
    if not data:
        return None
    try:
        return ConfirmationBasis.model_validate(data)
    except ValueError:
        return None


def _confirmation_projection(record) -> tuple[
    str,
    ConfirmationBasis | None,
    float,
    bool,
]:
    raw_status = record.get('confirmation_status') or 'pending'
    status = effective_confirmation_status(record)
    confidence = float(
        record['confidence_score']
        if record.get('confidence_score') is not None else 0.5
    )
    if status != raw_status:
        confidence = min(confidence, 0.5)
    basis = _confirmation_basis(record.get('confirmation_basis_json'))
    explicit = (
        record.get('confirmation_state_explicit') is True
        and status == raw_status
        and basis is not None
    )
    return status, basis, confidence, explicit
