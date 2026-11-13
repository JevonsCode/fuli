"""max_sensitivity='normal' against a disposable graph, with synthetic records only."""

from types import SimpleNamespace
from uuid import uuid4

from neo4j import AsyncGraphDatabase

from fuli_graph.knowledge_search import _edges_with_a_normal_source, _personal_entities
from fuli_graph.models import SearchRequest
from test_project_agent_memory_neo4j import fixture_settings

# Each case: the sensitivities of the item's source episodes (None: stored without one).
CASES = {
    'private': ['private'],
    'restricted-and-private': ['restricted', 'private'],
    'normal': ['normal'],
    'mixed': ['private', 'normal'],
    'unset': [None],
    'no-episode': [],
}
NORMAL_SAFE = {'normal', 'mixed', 'unset'}


async def test_only_items_with_a_normal_source_reach_a_visitor():
    settings = fixture_settings()
    group = f'synthetic-sensitivity-{uuid4()}'
    driver = AsyncGraphDatabase.driver(settings.neo4j_uri, auth=('neo4j', settings.neo4j_password))
    store = SimpleNamespace(runtime=SimpleNamespace(driver=driver), settings=SimpleNamespace(graph_limit=100))
    space = {'id': group, 'group_id': group}
    project = 'shared-project'
    try:
        await driver.execute_query('''
            CREATE (target:SensitivityTestTarget {group_id: $group})
            WITH target
            UNWIND $cases AS item
            CREATE (node:Entity {uuid: $group + '-' + item.kind, group_id: $group,
                name: 'Sensitivity fixture ' + item.kind, summary: 'Synthetic sensitivity evidence'})
            CREATE (node)-[edge:RELATES_TO {uuid: $group + '-edge-' + item.kind, group_id: $group,
                episodes: []}]->(target)
            CREATE (:FuliKnowledgeAssignment {space_id: $group, item_kind: 'entity', item_id: node.uuid,
                project_id: $project})
            WITH node, edge, item
            UNWIND range(0, size(item.sensitivities) - 1) AS index
            CREATE (episode:Episodic {uuid: $group + '-' + item.kind + '-' + toString(index),
                group_id: $group, fuli_personal_project_id: $project})
            SET episode.fuli_sensitivity = item.sensitivities[index]
            CREATE (episode)-[:MENTIONS]->(node)
            SET edge.episodes = edge.episodes + episode.uuid
        ''', group=group, project=project,
            cases=[{'kind': kind, 'sensitivities': values} for kind, values in CASES.items()])

        scopes = {project: {'scope_distance': 0, 'scope_path': [project], 'inherited': False}}
        found = {}
        for max_sensitivity in (None, 'normal'):
            request = SearchRequest(space_ids=[group], query='Sensitivity fixture', limit=20,
                                    personal_project_ids=[project], active_personal_project_id=project,
                                    include_pending=True, max_sensitivity=max_sensitivity)
            entities = await _personal_entities(store, space, request, scopes)
            found[max_sensitivity] = {item.id.removeprefix(f'{group}-') for item in entities}
        assert found[None] == set(CASES)
        assert found['normal'] == NORMAL_SAFE

        edges = await _edges_with_a_normal_source(store, [f'{group}-edge-{kind}' for kind in CASES])
        assert {item.removeprefix(f'{group}-edge-') for item in edges} == NORMAL_SAFE
    finally:
        # Delete only this test's unique fixture, even on assertion failure.
        await driver.execute_query('''
            MATCH (node) WHERE node.group_id = $group OR node.space_id = $group
            DETACH DELETE node
        ''', group=group)
        await driver.close()
