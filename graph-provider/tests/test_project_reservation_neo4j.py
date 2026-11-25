"""Normal and session-temporary HTTP writes consult the same local registry."""
from contextlib import closing
import sqlite3

import pytest

from test_project_agent_memory_neo4j import fixture_settings, provider_client


@pytest.mark.asyncio
@pytest.mark.parametrize('follower', [False, True])
async def test_project_writes_need_the_installations_reservation(tmp_path, follower):
    authority, device = 'a' * 64, ('b' if follower else 'a') * 64
    path = tmp_path / 'host.sqlite'
    settings = fixture_settings().model_copy(update={
        'project_registry_path': str(path), 'project_registry_version': 11,
        'project_device_fingerprint': device, 'project_authority_fingerprint': authority,
    })
    with closing(sqlite3.connect(path)) as db:
        db.executescript("""
            PRAGMA user_version=11;
            CREATE TABLE project_owners(space,project,owner,generation,state,operation,verified_at);
            CREATE TABLE project_permits(authority,space,project,owner,generation,operation,state);
        """)
        async with provider_client(settings) as (client, _):
            space = (await client.post('/v1/spaces', json={'name': 'Registry test', 'kind': 'personal'})).json()['id']
            for project, method, route, body in [
                ('sample', client.put, '/v1/personal-projects', {'project_id': 'sample', 'profile': {'name': 'Sample', 'purpose': 'Verify project reservation'}}),
                ('temporary-' + 'c' * 64, client.post, '/v1/temporary-projects/ensure',
                 {'scope_key': 'c' * 64, 'source_application': 'codex', 'lifetime': 'session'}),
            ]:
                payload = {**body, 'personal_space_id': space}
                refused = await method(route, json=payload)
                assert refused.status_code == 409
                assert 'project_reservation_required' in refused.text
                if follower:
                    db.execute('INSERT INTO project_permits VALUES(?,?,?,?,?,?,?)',
                               (authority, space, project, device, 1, 'fixture', 'reserved'))
                else:
                    db.execute('INSERT INTO project_owners VALUES(?,?,?,?,?,?,?)',
                               (space, project, device, 1, 'reserved', 'fixture', None))
                db.commit()
                saved = await method(route, json=payload)
                assert saved.status_code == 200
                assert saved.json()['project_id'] == project
