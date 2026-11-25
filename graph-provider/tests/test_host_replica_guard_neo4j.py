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


@pytest.mark.asyncio
@pytest.mark.parametrize('strict', [False, True])
async def test_host_project_copy_write_is_observed_after_commit_or_refused_before_commit(strict, monkeypatch):
    from fastapi import HTTPException
    from fuli_graph import replica_write_guard

    settings = fixture_settings().model_copy(update={'replica_write_observation': True})
    async with provider_client(settings) as (client, _):
        driver, space, group = await scenario(client)
        try:
            exported = await export(client, space, 'project:alpha')
            await clear(driver, space, group)
            await import_envelope(client, exported)
            root = next(node for node in exported['nodes'] if 'FuliPersonalProject' in node['labels']
                        and node['properties'].get('project_id') == 'alpha')
            select = 'MATCH (p:FuliPersonalProject {id: $id, fuli_replica_owner: $owner}) '

            async def read_name():
                rows, _, _ = await driver.execute_query(select + 'RETURN p.name AS name',
                                                        id=root['properties']['id'], owner=OWNER, routing_='r')
                return rows[0]['name']

            initial = await read_name()
            changed = 'Synthetic observation check'
            assert initial != changed
            async def change():
                return await driver.execute_query(select + 'SET p.name=$name RETURN p.name',
                                                  id=root['properties']['id'], owner=OWNER, name=changed)

            with monkeypatch.context() as flags:
                flags.setattr(replica_write_guard, 'STRICT', strict)
                if strict:
                    with pytest.raises(HTTPException) as caught:
                        await change()
                    assert caught.value.status_code == 409 and caught.value.detail['code'] == 'replica_read_only'
                    assert await read_name() == initial
                    await checked(await client.put('/v1/personal-projects', json={
                        'personal_space_id': space, 'project_id': 'synthetic-local',
                        'profile': {'name': 'Local', 'purpose': 'Verify a host can still write locally.'}}))
                    await checked(await client.put('/v1/project-agents', json={
                        'personal_space_id': space, 'personal_project_id': 'synthetic-local', 'agent_id': 'local-engineer',
                        'occupation': {'role': 'engineering'}, 'profile': {'name': 'Local engineer',
                        'responsibility': 'Verify the local roster.', 'allowed_clients': ['codex'],
                        'work_kinds': ['implementation'], 'capabilities': ['coding']}}))
                else:
                    await change()
                    assert await read_name() == changed
                    stats = (await checked(await client.get('/health')))['replicaWriteGuard']['observation']
                    assert stats['changedByScope']['project'] >= 1
                    assert 'alpha' not in str(stats) and changed not in str(stats)
        finally:
            await cleanup(driver, space, group)
