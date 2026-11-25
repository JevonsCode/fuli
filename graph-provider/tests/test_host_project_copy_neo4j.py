from contextlib import closing
import sqlite3

import pytest

from test_project_freeze_neo4j import make_gates
from test_replica_write_guard_neo4j import episode
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
        db.execute("INSERT INTO project_owners VALUES(?,'local',?,1,'owned')", (space, OTHER))
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
            # This project already belongs to the host before the peer is inventoried.
            await checked(await client.put('/v1/personal-projects', json={
                'project_id': 'local', 'personal_space_id': space, 'profile': {'name': 'Local project', 'purpose': 'Preserve local writes during replication.'}}))
            file = tmp_path / 'authority.sqlite'
            registry(file, space)
            make_gates(tmp_path, space, [('alpha', 'replica', 1, 'open', None), ('local', 'owner', 1, 'open', None)])
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
                local_fact = {'space_id': space, 'episode': episode('host-global-fact')}
                basis = await checked(await host.post('/v1/knowledge/commits', json=local_fact))
                await checked(await host.post('/v1/knowledge/commits', json=local_fact))

                async def capture(payload):
                    return await host.post('/v1/knowledge/commits', json={
                        'space_id': space, 'personal_project_id': 'local', 'episode': payload})

                derived = episode('conclusion')
                derived['entities'][0]['derived_from'] = basis['entity_ids']
                await checked(await capture(derived))
                foreign = episode('foreign-conclusion')
                foreign['entities'][0]['derived_from'] = [space + '-fact']
                denied = await capture(foreign)
                assert denied.status_code == 409 and denied.json()['detail']['code'] == 'replica_read_only'

                def connection(key, **fields):
                    payload = episode(key)
                    payload['entities'] = [episode(i)['entities'][0] for i in ['service', 'port']]
                    payload['relationships'] = [{'key': key, 'source': 'service', 'target': 'port',
                        'type': 'LISTENS_ON', 'fact': key, **fields}]
                    return payload

                old = await checked(await capture(connection('port-before')))
                await checked(await capture(connection('port-after', supersedes=['port-before'])))
                edges, _, _ = await driver.execute_query(
                    'MATCH ()-[r:RELATES_TO {uuid:$id}]->() RETURN r.fuli_replaced_by_item_id AS replacement',
                    id=old['relationship_ids'][0], routing_='r')
                assert edges[0]['replacement']
                policy = {'personal_space_id': space, 'agent_id': 'employee.assistant', 'policy': {'enabled': True}}
                await checked(await host.put('/v1/agent-conversations/policy', json=policy))
                catalog = await checked(await host.get('/v1/occupations', params={'personal_space_id': space}))
                assert any(row['key'] == 'engineering' for row in catalog)
                role = await checked(await host.post('/v1/occupations', json={'personal_space_id': space,
                    'name_zh': '测试岗位', 'description_zh': '测试项目维护'}))
                assert role['key'].startswith('custom_')
                # One management transaction can span several inferred scopes.
                # Its local change rolls back too if the copied fact would change.
                from fuli_graph.project_maintenance_gate import maintenance_transaction
                from fastapi import HTTPException
                store = host._transport.app.state.store
                with pytest.raises(HTTPException) as rejected:
                    async with maintenance_transaction(store, {'id': space, 'group_id': group}) as scoped:
                        await scoped.runtime.driver.execute_query(
                            'MATCH (e:Entity) WHERE e.uuid IN $ids SET e.summary=$text',
                            ids=[*basis['entity_ids'], space + '-fact'], text='synthetic cross-scope edit')
                assert rejected.value.detail['code'] == 'replica_read_only'
                records, _, _ = await driver.execute_query(
                    'MATCH (e:Entity) WHERE e.uuid IN $ids RETURN collect(e.summary) AS summaries',
                    ids=[*basis['entity_ids'], space + '-fact'], routing_='r')
                assert 'synthetic cross-scope edit' not in records[0]['summaries']
                copied = await host.post('/v1/knowledge/commits', json={
                    'space_id': space, 'personal_project_id': 'alpha', 'episode': episode('replica-edit')})
                assert copied.status_code == 409
                assert await checked(await host.get('/v1/scopes/replica-summary', params=summary)) == before
                with closing(sqlite3.connect(file)) as db, db:
                    db.execute("UPDATE runners SET revoked_at='revoked'")
                revoked = await host.post('/v1/scopes/import', params=params, json=image)
                assert revoked.status_code == 409
                assert await checked(await host.get('/v1/scopes/replica-summary', params=summary)) == before
        finally:
            await cleanup(driver, space, group)


@pytest.mark.asyncio
async def test_former_owner_refreshes_the_moved_project_only_while_the_original_pair_is_live(tmp_path):
    settings = fixture_settings()
    async with provider_client(settings) as (client, token):
        driver, space, group = await scenario(client)
        try:
            original = await export(client, space, 'project:alpha')
            profile = await checked(await client.get('/v1/personal-projects/alpha', params={'personal_space_id': space}))
            await checked(await client.put('/v1/personal-projects', json={'personal_space_id': space, 'project_id': 'alpha',
                'profile': {**profile['profile'], 'name': 'Changed on the new owner'}, 'expected_updated_at': profile['updated_at']}))
            changed = await export(client, space, 'project:alpha')
            assert original['digest'] != changed['digest']
            await clear(driver, space, group)
            registry_file, runner_file = tmp_path / 'host.sqlite', tmp_path / 'runner.sqlite'
            with closing(sqlite3.connect(registry_file)) as db, db:
                db.executescript('PRAGMA user_version=12; CREATE TABLE project_permits(authority,space,project,owner,generation,operation,state);')
                db.execute("INSERT INTO project_permits VALUES(?,?,'alpha',?,2,'move','revoked')", (OWNER, space, OTHER))
            with closing(sqlite3.connect(tmp_path / 'project-moves.sqlite')) as db, db:
                db.executescript('PRAGMA user_version=2; CREATE TABLE move_participants(space,project,move_id,source,target,generation,step,gate_role,pairing);')
                db.execute("INSERT INTO move_participants VALUES(?,'alpha','move',?,?,1,'forwarded','owner','pair')", (space, OTHER, OWNER))
            with closing(sqlite3.connect(runner_file)) as db, db:
                db.executescript('PRAGMA user_version=6; CREATE TABLE host(id,fingerprint,revoked_at,project_pairing);')
                db.execute("INSERT INTO host VALUES(1,?,NULL,'pair')", (OWNER,))
            make_gates(tmp_path, space, [('alpha', 'replica', 2, 'open', 'move')])
            retired = settings.model_copy(update={'project_registry_path': str(registry_file), 'project_registry_version': 12,
                'project_gate_directory': str(tmp_path), 'project_gate_space': space,
                'project_authority_fingerprint': OWNER, 'project_device_fingerprint': OTHER})
            async with provider_client(retired, token) as (follower, _):
                params = {'owner': OWNER, 'generation': 2, 'pairing': 'pair'}
                for image in (original, changed):
                    saved = await checked(await follower.post('/v1/scopes/import', params=params, json=image))
                    assert saved['digest'] == image['digest']
                local = await checked(await follower.get('/v1/personal-projects/alpha', params={'personal_space_id': space}))
                assert local['profile']['name'] == 'Changed on the new owner'
                query = {'scope': 'project:alpha', 'personal_space_id': space}
                current = await checked(await follower.get('/v1/scopes/replica-summary', params=query))
                with closing(sqlite3.connect(runner_file)) as db, db:
                    db.execute("UPDATE host SET project_pairing='replacement'")
                response = await follower.post('/v1/scopes/import', params=params, json=original)
                assert response.status_code == 409
                assert await checked(await follower.get('/v1/scopes/replica-summary', params=query)) == current
        finally:
            await cleanup(driver, space, group)
