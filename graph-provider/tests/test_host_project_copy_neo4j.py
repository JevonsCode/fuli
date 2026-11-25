from contextlib import closing
import sqlite3

import pytest

from test_project_freeze_neo4j import make_gates
from test_project_agent_memory_neo4j import fixture_settings, provider_client
from test_scope_export_neo4j import checked, cleanup, export
from test_scope_import_neo4j import OWNER, OTHER, clear, scenario


def registry(file, space):
    with closing(sqlite3.connect(file)) as db, db:
        db.executescript("""
            PRAGMA user_version=11;
            CREATE TABLE project_owners(space,project,owner,generation,state);
            CREATE TABLE runners(fingerprint,grant_space,grant_pairing,revoked_at);
            CREATE TABLE owner_inventory(fingerprint,space,checked_at);
        """)
        db.execute("INSERT INTO project_owners VALUES(?,'alpha',?,1,'owned')", (space, OWNER))
        db.execute("INSERT INTO runners VALUES(?,?,'pair',NULL)", (OWNER, space))
        db.execute("INSERT INTO owner_inventory VALUES(?,?,'checked')", (OWNER, space))


@pytest.mark.asyncio
async def test_owner_revision_and_revoked_project_import_leave_the_previous_graph_intact(tmp_path):
    settings = fixture_settings()
    async with provider_client(settings) as (client, token):
        driver, space, group = await scenario(client)
        try:
            profile = await checked(await client.get('/v1/personal-projects/alpha', params={'personal_space_id': space}))
            write = {'project_id': 'alpha', 'personal_space_id': space, 'profile': profile['profile'],
                     'expected_updated_at': profile['updated_at']}
            first = await checked(await client.put('/v1/personal-projects', json=write))
            assert first['updated_at'] != write['expected_updated_at']
            rejected = await client.put('/v1/personal-projects', json=write)
            assert rejected.status_code == 409 and rejected.json()['detail']['code'] == 'project_revision_changed'
            image = await export(client, space, 'project:alpha')
            await clear(driver, space, group)
            file = tmp_path / 'authority.sqlite'
            registry(file, space)
            make_gates(tmp_path, space, [('alpha', 'replica', 1, 'open', None)])
            trusted = settings.model_copy(update={'project_registry_path': str(file), 'project_registry_version': 11,
                'project_gate_directory': str(tmp_path), 'project_gate_space': space,
                'project_authority_fingerprint': OTHER, 'project_device_fingerprint': OTHER})
            async with provider_client(trusted, token) as (host, _):
                params = {'owner': OWNER, 'generation': 1, 'pairing': 'pair'}
                bad = await host.post('/v1/scopes/import', params={**params, 'generation': 2}, json=image)
                assert bad.status_code == 409
                summary = {'scope': 'project:alpha', 'personal_space_id': space}
                assert (await checked(await host.get('/v1/scopes/replica-summary', params=summary)))['copiedRecords'] == 0
                saved = await checked(await host.post('/v1/scopes/import', params=params, json=image))
                assert saved['digest'] == image['digest'] and saved['owner'] == OWNER
                local_write = await host.put('/v1/personal-projects', json=write)
                assert local_write.status_code == 409 and local_write.json()['detail']['code'] == 'project_write_blocked'
                before = await checked(await host.get('/v1/scopes/replica-summary', params=summary))
                with closing(sqlite3.connect(file)) as db, db:
                    db.execute("UPDATE runners SET revoked_at='revoked'")
                revoked = await host.post('/v1/scopes/import', params=params, json=image)
                assert revoked.status_code == 409
                assert await checked(await host.get('/v1/scopes/replica-summary', params=summary)) == before
        finally:
            await cleanup(driver, space, group)
