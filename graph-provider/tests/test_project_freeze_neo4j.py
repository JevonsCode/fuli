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
            db.execute('CREATE TABLE gates(project TEXT PRIMARY KEY,role TEXT,generation INTEGER,state TEXT,move_id TEXT)')
            db.executemany('INSERT INTO gates VALUES(?,?,?,?,?)', rows)


@pytest.mark.asyncio
async def test_frozen_project_refuses_normal_and_unresolved_writes_after_restart(tmp_path):
    settings = fixture_settings()
    async with provider_client(settings) as (client, token):
        space = (await checked(await client.post('/v1/spaces', json={'kind': 'personal', 'name': 'Synthetic freeze'})))['id']
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
            assert [row['name'] for row in rows] == ['two']
    finally:
        async with provider_client(settings, token) as (client, _):
            await cleanup(client._transport.app.state.store.runtime.driver, space, group)
