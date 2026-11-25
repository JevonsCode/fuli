"""A host can rediscover its imported project even though it owns global."""
import pytest

from test_project_agent_memory_neo4j import fixture_settings, provider_client
from test_scope_export_neo4j import checked, cleanup, export
from test_scope_import_neo4j import OWNER, clear, import_envelope, scenario


@pytest.mark.asyncio
async def test_host_restart_reports_owners_and_count_and_permits_an_observed_local_write():
    settings = fixture_settings().model_copy(update={'replica_write_observation': True})
    async with provider_client(settings) as (client, principal):
        driver, space, group = await scenario(client)
        try:
            project = await export(client, space, 'project:alpha')
            await clear(driver, space, group)
            await import_envelope(client, project)
            before = (await checked(await client.get('/health')))['replicaWriteGuard']
            assert before['checks'] == 'report' and OWNER in before['owners']
            assert before['copiedRecords'] > 0
        except BaseException:
            await cleanup(driver, space, group)
            raise
    async with provider_client(settings, principal) as (client, _):
        driver = client._transport.app.state.store.runtime.driver
        try:
            restored = (await checked(await client.get('/health')))['replicaWriteGuard']
            assert restored['holdsCopies'] and restored['copiedRecords'] == before['copiedRecords']
            assert restored['owners'] == before['owners']
            original = restored['observation']['checked']
            await checked(await client.put('/v1/personal-projects', json={
                'personal_space_id': space, 'project_id': 'local-feedback',
                'profile': {'name': 'Synthetic local project', 'purpose': 'Check local writes.', 'lifecycle': 'active'}}))
            after = (await checked(await client.get('/health')))['replicaWriteGuard']
            assert after['observation']['checked'] > original
            assert after['observation']['changedByScope'] == {}
        finally:
            await cleanup(driver, space, group)
