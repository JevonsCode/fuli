"""Host feedback with a local item and an imported project, on a disposable graph."""
import pytest

from test_project_agent_memory_neo4j import fixture_settings, provider_client
from test_scope_export_neo4j import checked, cleanup, export
from test_scope_import_neo4j import OWNER, clear, import_envelope, scenario


@pytest.mark.asyncio
async def test_host_feedback_checks_all_items_before_writing_and_keeps_local_feedback():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        driver, space, group = await scenario(client)
        try:
            project = await export(client, space, 'project:alpha')
            await clear(driver, space, group)
            await import_envelope(client, project)
            own = f'{space}-own'
            await driver.execute_query(
                'CREATE (:Entity {group_id: $group, uuid: $id, name: "Synthetic local fact"})',
                group=group, id=own)

            def item(id_):
                return {'item_id': id_, 'item_kind': 'entity', 'feedback_kind': 'contradicted',
                        'reason': 'Synthetic correction.', 'evidence_summary': 'Synthetic source.',
                        'reported_by_kind': 'user'}

            request = {'personal_space_id': space, 'task_id': 'fixture-feedback',
                       'items': [item(own), item(f'{space}-pref-alpha')]}
            response = await client.post('/v1/knowledge/feedback', json=request)
            assert response.status_code == 409
            detail = response.json()['detail']
            assert detail['code'] == 'replica_read_only' and detail['owner'] == OWNER
            assert 'project:alpha' in detail['scopes']
            rows, _, _ = await driver.execute_query(
                'MATCH (audit:FuliKnowledgeAudit {space_id: $space, task_id: $task}) RETURN count(audit) AS n',
                space=space, task=request['task_id'], routing_='r')
            assert rows[0]['n'] == 0
            result = await checked(await client.post('/v1/knowledge/feedback', json={**request, 'items': [item(own)]}))
            assert result['recorded_count'] == 1
        finally:
            await cleanup(driver, space, group)
