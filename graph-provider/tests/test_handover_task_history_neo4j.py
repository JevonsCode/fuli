import pytest

from test_project_agent_memory_neo4j import fixture_settings, provider_client
from test_scope_export_neo4j import checked, cleanup, seed_people_and_work
from test_scope_handover_neo4j import participant, permit, phase
from test_scope_import_neo4j import OWNER
from fuli_graph.provider_values import graphiti_group_id


@pytest.mark.asyncio
async def test_active_token_blocks_seal_then_closed_history_never_becomes_current(tmp_path):
    settings = fixture_settings()
    async with provider_client(settings) as (client, token):
        space = (await checked(await client.post('/v1/spaces', json={'kind': 'personal', 'name': 'Synthetic history'})))['id']
        group = graphiti_group_id(settings.provider_id, 'personal', space)
        driver = client._transport.app.state.store.runtime.driver
        try:
            await seed_people_and_work(client, space)
            await checked(await client.put('/v1/task-contexts', json={'personal_space_id': space,
                'personal_project_id': 'alpha', 'source_application': 'codex', 'session_id': 'other-session',
                'token': 'fuli-task-test-current', 'turn_id': 'another-turn'}))
            source = participant(tmp_path / 'history', settings, space, 'owner', OWNER)
            permit(source, 'seal')
            async with provider_client(source, token) as (old, _):
                blocked = await phase(old, space, 'seal')
                assert blocked.status_code == 409 and blocked.json()['detail']['code'] == 'project_tasks_still_active'
                await driver.execute_query("MATCH (t:FuliTaskContext {personal_space_id:$space, token:$token}) SET t.completed=true",
                                           space=space, token='fuli-task-test-current')
                bundle = await checked(await phase(old, space, 'seal'))
                permit(source, 'demote', bundle['digest'])
                await checked(await phase(old, space, 'demote'))
            rows, _, _ = await driver.execute_query("""
                MATCH (:FuliSpace {id:$space})-[:HAS_TASK_CONTEXT_SESSION]->(s)-[:HAS_CONTEXT]->(t)
                RETURN t.personal_project_id AS project, count(t) AS records,
                       sum(CASE WHEN s.current_token=t.token THEN 1 ELSE 0 END) AS active
                """, space=space, routing_='r')
            counts = {r['project']: (r['records'], r['active']) for r in rows}
            assert counts == {'alpha': (2, 0), 'beta': (1, 1)}
        finally:
            await cleanup(driver, space, group)
