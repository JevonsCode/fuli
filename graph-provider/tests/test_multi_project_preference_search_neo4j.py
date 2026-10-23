"""rec#34 E3: real /v1/search and scope Cypher, with a synthetic candidate generator."""
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from test_knowledge_tags_neo4j import run_in_world


async def multi_project_search(world):
    projects = ['synthetic-project-a', 'synthetic-project-b', 'synthetic-unrelated']
    for project in projects:
        await world.project(project)
    item = await world.item(projects[0], 'Synthetic button preference')
    item_id, group = item['item_id'], await world.group_id()
    edge_id = f'{item_id}-edge'
    await world.driver.execute_query('''
        MATCH (item:Entity {uuid: $id})
        SET item.fuli_preference_scope = 'project', item.fuli_preference_project_id = $primary,
            item.fuli_preference_project_ids = $projects
        CREATE (source:Entity {uuid: $id + '-source', group_id: $group, name: 'Synthetic buttons'})
            -[edge:RELATES_TO {uuid: $edge, group_id: $group, name: 'PREFERS',
                fact: 'Synthetic button preference', episodes: [], fuli_profile_aspect: 'taste',
                fuli_preference_scope: 'project', fuli_preference_project_id: $primary,
                fuli_preference_project_ids: $projects}]->
            (:Entity {uuid: $id + '-target', group_id: $group, name: 'Synthetic consistency'})
    ''', id=item_id, group=group, edge=edge_id, primary=projects[0], projects=projects[:2])
    edge = SimpleNamespace(uuid=edge_id, group_id=group, name='PREFERS', fact='Synthetic button preference',
                           source_node_uuid=f'{item_id}-source', target_node_uuid=f'{item_id}-target',
                           episodes=[], valid_at=None, invalid_at=None, created_at=datetime.now(timezone.utc))

    async def search(project, selected=None):
        response = await world.client.post('/v1/search', json={
            'space_ids': [world.space], 'query': 'Synthetic button preference', 'limit': 10,
            'personal_project_ids': selected or [project], 'active_personal_project_id': project,
            'include_personal_global': False, 'include_pending': True,
        })
        assert response.status_code == 200, response.text
        return response.json()

    # Only candidate generation is replaced: authorization, Cypher reads,
    # projection, scope filtering and HTTP serialization all run for real.
    with patch.object(world.store.runtime.graphiti, 'search', new=AsyncMock(return_value=[edge])):
        for project in projects:
            result = await search(project)
            allowed = project in projects[:2]
            assert {row['id'] for row in result['entities']} == ({item_id} if allowed else set())
            assert {row['id'] for row in result['facts']} == ({edge_id} if allowed else set())
            for row in result['entities'] + result['facts']:
                assert row['defined_project_id'] == project
        both = await search(projects[1], projects[:2])
        assert all(row['defined_project_id'] == projects[1] for row in both['entities'] + both['facts'])

        # A person's later narrowing and old singleton records both exclude B.
        await world.driver.execute_query('''
            MATCH (item:Entity {uuid: $id}) SET item.fuli_preference_project_ids = null
            WITH item
            MATCH ()-[edge:RELATES_TO {uuid: $edge}]->() SET edge.fuli_preference_project_ids = null
        ''', id=item_id, edge=edge_id)
        narrowed = await search(projects[1])
        assert narrowed['entities'] == narrowed['facts'] == []
        legacy = await search(projects[0])
        assert {row['id'] for row in legacy['entities']} == {item_id}
        assert {row['id'] for row in legacy['facts']} == {edge_id}


@pytest.mark.asyncio
async def test_multi_project_preference_search_on_neo4j():
    await run_in_world(multi_project_search)
