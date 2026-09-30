"""Scope regression against a disposable graph, with synthetic records only."""

from types import SimpleNamespace
from uuid import uuid4

import pytest
from neo4j import AsyncGraphDatabase

from fuli_graph.knowledge_search import _personal_entities, personal_edge_scopes
from fuli_graph.models import SearchRequest
from test_project_agent_memory_neo4j import fixture_settings


@pytest.mark.asyncio
async def test_historical_global_episode_does_not_reopen_project_owned_knowledge():
    settings = fixture_settings()
    group = f'synthetic-scope-{uuid4()}'
    driver = AsyncGraphDatabase.driver(
        settings.neo4j_uri, auth=('neo4j', settings.neo4j_password),
    )
    store = SimpleNamespace(
        runtime=SimpleNamespace(driver=driver),
        settings=SimpleNamespace(graph_limit=100),
    )
    space = {'id': group, 'group_id': group}
    cases = ['global', 'assigned', 'origin']
    try:
        await driver.execute_query('''
            CREATE (global:Episodic {uuid: $group + '-global', group_id: $group})
            CREATE (origin:Episodic {uuid: $group + '-origin', group_id: $group,
                fuli_personal_project_id: 'owner-project'})
            CREATE (target:ScopeTestTarget {group_id: $group})
            WITH global, origin, target
            UNWIND $cases AS kind
            CREATE (node:Entity {uuid: $group + '-' + kind, group_id: $group,
                name: 'Scope fixture ' + kind, summary: 'Synthetic scope evidence'})
            CREATE (global)-[:MENTIONS]->(node)
            CREATE (node)-[edge:RELATES_TO {uuid: $group + '-edge-' + kind,
                group_id: $group,
                episodes: CASE WHEN kind = 'origin'
                    THEN [global.uuid, origin.uuid] ELSE [global.uuid] END}]->(target)
            FOREACH (_ IN CASE WHEN kind = 'origin' THEN [1] ELSE [] END |
                CREATE (origin)-[:MENTIONS]->(node))
            FOREACH (_ IN CASE WHEN kind = 'assigned' THEN [1] ELSE [] END |
                CREATE (:FuliKnowledgeAssignment {space_id: $group,
                    item_kind: 'entity', item_id: node.uuid, project_id: 'owner-project'})
                CREATE (:FuliKnowledgeAssignment {space_id: $group,
                    item_kind: 'relationship', item_id: edge.uuid, project_id: 'owner-project'}))
        ''', group=group, cases=cases)

        for project, expected in (
            ('unrelated-project', {'global'}),
            ('owner-project', set(cases)),
        ):
            request = SearchRequest(
                space_ids=[group], query='Scope fixture',
                personal_project_ids=[project], active_personal_project_id=project,
                include_personal_global=True, include_pending=True,
            )
            scopes = {project: {
                'scope_distance': 0, 'scope_path': [project], 'inherited': False,
            }}
            entities = await _personal_entities(store, space, request, scopes)
            assert {item.id for item in entities} == {
                f'{group}-{kind}' for kind in expected
            }
            edges = await personal_edge_scopes(
                store, space, request, scopes, True,
                [f'{group}-edge-{kind}' for kind in cases],
            )
            assert set(edges) == {f'{group}-edge-{kind}' for kind in expected}
    finally:
        # Delete only this test's unique fixture, even on assertion failure.
        await driver.execute_query('''
            MATCH (node) WHERE node.group_id = $group OR node.space_id = $group
            DETACH DELETE node
        ''', group=group)
        await driver.close()
