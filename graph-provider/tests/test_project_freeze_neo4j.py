from contextlib import closing
from hashlib import sha256
import sqlite3

import pytest
from fastapi import HTTPException

from test_project_agent_memory_neo4j import fixture_settings, provider_client
from test_scope_export_neo4j import checked, cleanup
from fuli_graph.provider_values import graphiti_group_id


def make_gates(root, space, records):
    directory = root / sha256(space.encode()).hexdigest()
    directory.mkdir()
    for file, rows in [('index.sqlite', records), *[
        (sha256(row[0].encode()).hexdigest() + '.sqlite', [row]) for row in records]]:
        with closing(sqlite3.connect(directory / file)) as db, db:
            db.execute('PRAGMA user_version=1')
            db.execute('CREATE TABLE gates(project TEXT PRIMARY KEY,role TEXT,generation INTEGER,state TEXT,move_id TEXT)')
            db.executemany('INSERT INTO gates VALUES(?,?,?,?,?)', rows)


@pytest.mark.asyncio
async def test_frozen_project_refuses_normal_and_unresolved_writes_after_restart(tmp_path):
    settings = fixture_settings()
    async with provider_client(settings) as (client, token):
        space = (await checked(await client.post('/v1/spaces', json={'kind': 'personal', 'name': 'Synthetic freeze'})))['id']
        await checked(await client.put('/v1/personal-projects', json={'personal_space_id': space, 'project_id': 'one',
            'profile': {'name': 'Frozen one', 'purpose': 'Synthetic project before the move'}}))
        group = graphiti_group_id(settings.provider_id, 'personal', space)
        await client._transport.app.state.store.runtime.driver.execute_query(
            '''UNWIND ['one','two'] AS project
               CREATE (:Entity {uuid: $space + '-' + project, group_id: $group, name: project,
                 fuli_profile_aspect: 'judgment_preference', fuli_preference_scope: 'project',
                 fuli_preference_project_id: project})''', space=space, group=group)
    make_gates(tmp_path, space, [('one', 'owner', 1, 'closed', 'move-one'), ('two', 'owner', 1, 'open', None)])
    gated = settings.model_copy(update={'project_gate_directory': str(tmp_path), 'project_gate_space': space})
    try:
        async with provider_client(gated, token) as (client, _):
            async def change(project):
                return await client.put('/v1/personal-projects', json={'personal_space_id': space, 'project_id': project,
                    'profile': {'name': project, 'lifecycle': 'active', 'purpose': 'Synthetic freeze acceptance'}})
            assert (await change('one')).status_code == 409
            await checked(await change('two'))
            from test_replica_write_guard_neo4j import episode
            capture = {'space_id': space, 'personal_project_id': 'two', 'episode': episode('still-open')}
            await checked(await client.post('/v1/knowledge/commits', json=capture))
            stopped = await client.post('/v1/knowledge/commits', json={**capture, 'personal_project_id': 'one',
                'episode': episode('on-hold')})
            assert stopped.status_code == 409
            entry = {'personal_space_id': space, 'personal_project_id': 'two', 'source_application': 'codex',
                     'token': 'fuli-task-synthetic-open', 'session_id': 'synthetic-open'}
            assert (await client.put('/v1/task-contexts', json={**entry, 'personal_project_id': 'one'})).status_code == 409
            await checked(await client.put('/v1/task-contexts', json=entry))
            base = '/v1/task-contexts/' + entry['token']
            claim = {'personal_space_id': space, 'source_application': 'codex'}
            await checked(await client.post(base + '/turn-receipt/claim', json=claim))
            await checked(await client.post(base + '/session-hints/claim', json={**claim, 'operation': 'board_match'}))
            url = base + '/checkpoint'
            checkpoint = {'personal_space_id': space, 'source_application': 'codex', 'disposition': 'retain_nothing',
                          'reason': 'Synthetic completion', 'fingerprint': 'a' * 64}
            used = {'item_id': space + '-one', 'item_kind': 'entity', 'use_kind': 'applied'}
            assert (await client.put(url, json={**checkpoint, 'knowledge_usage': [used]})).status_code == 409
            await checked(await client.put(url, json=checkpoint))
            def item(project):
                return {'item_id': space + '-' + project, 'item_kind': 'entity', 'feedback_kind': 'contradicted',
                        'reason': 'Synthetic change', 'evidence_summary': 'Synthetic evidence', 'reported_by_kind': 'user'}
            feedback = {'personal_space_id': space, 'task_id': 'sample', 'items': [item('two'), item('one')]}
            assert (await client.post('/v1/knowledge/feedback', json=feedback)).status_code == 409
            response = await checked(await client.post('/v1/knowledge/feedback', json={**feedback, 'items': [item('two')]}))
            assert response['recorded_count'] == 1
            driver = client._transport.app.state.store.runtime.driver
            with pytest.raises(HTTPException) as error:
                async with driver.transaction() as tx:
                    await tx.run('MATCH (p:FuliPersonalProject {project_id:$project}) SET p.name=$name',
                                 project='two', name='should never run')
            assert error.value.detail['code'] == 'project_scope_unknown'
            rows, _, _ = await driver.execute_query(
                'MATCH (:FuliSpace {id:$space})-[:CONTAINS_PROJECT]->(p:FuliPersonalProject) RETURN p.name AS name',
                space=space, routing_='r')
            assert sorted(row['name'] for row in rows) == ['Frozen one', 'two']
    finally:
        async with provider_client(settings, token) as (client, _):
            await cleanup(client._transport.app.state.store.runtime.driver, space, group)
