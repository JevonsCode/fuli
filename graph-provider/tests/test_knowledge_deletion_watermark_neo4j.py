"""The watermark counts only actual delete traces in its own disposable space."""
import pytest

from test_knowledge_tags_neo4j import run_in_world

PATH = '/v1/knowledge/hard-deletions/watermark'


async def watermark_scenario(world):
    request = {'personal_space_id': world.space}
    empty = await world.client.post(PATH, json=request)
    assert empty.status_code == 200, empty.text
    assert empty.json() == {'count': 0, 'latest_deleted_at': None}
    foreign_id = f'{world.space}-foreign-delete'
    try:
        await world.driver.execute_query('''
            UNWIND $traces AS row
            CREATE (trace:FuliKnowledgeAudit {id: row.id, space_id: row.space,
                action: row.action, created_at: datetime(row.at)})
        ''', traces=[
            {'id': f'{world.space}-delete-1', 'space': world.space, 'action': 'hard_delete', 'at': '2026-10-20T00:00:00Z'},
            {'id': f'{world.space}-delete-2', 'space': world.space, 'action': 'hard_delete', 'at': '2026-10-21T00:00:00Z'},
            {'id': f'{world.space}-other-action', 'space': world.space, 'action': 'update', 'at': '2026-10-23T00:00:00Z'},
            {'id': foreign_id, 'space': f'{world.space}-foreign', 'action': 'hard_delete', 'at': '2026-10-24T00:00:00Z'},
        ])
        response = await world.client.post(PATH, json=request)
        assert response.status_code == 200, response.text
        assert response.json() == {'count': 2, 'latest_deleted_at': '2026-10-21T00:00:00Z'}
        assert set(response.json()) == {'count', 'latest_deleted_at'}
    finally:
        # run_in_world removes our own space; remove only this scenario's
        # uniquely named foreign trace, which deliberately sits outside it.
        await world.driver.execute_query('MATCH (trace:FuliKnowledgeAudit {id: $id}) DELETE trace', id=foreign_id)


@pytest.mark.asyncio
async def test_hard_deletion_watermark_aggregates_real_graph_traces():
    await run_in_world(watermark_scenario)
