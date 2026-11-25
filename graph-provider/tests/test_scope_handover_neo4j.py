"""A sealed project retains its scoped records and global bindings through both role transitions."""
from contextlib import closing
import sqlite3

import pytest

from fuli_graph.provider_values import graphiti_group_id
from test_project_agent_memory_neo4j import fixture_settings, provider_client
from test_project_freeze_neo4j import make_gates
from test_scope_export_neo4j import checked, cleanup, export, seed_people_and_work
from test_scope_import_neo4j import OWNER, OTHER, clear, import_envelope


def participant(directory, settings, space, role, device):
    directory.mkdir()
    make_gates(directory, space, [('alpha', role, 1, 'closed', 'sample-move')])
    file = directory / 'participant.sqlite'
    with closing(sqlite3.connect(file)) as db, db:
        db.executescript("""PRAGMA user_version=1;
            CREATE TABLE move_participants(space,project,move_id,source,target,generation,allowed_action,
                                           graph_digest,baseline_digest,gate_role);""")
        db.execute("INSERT INTO move_participants VALUES(?,'alpha','sample-move',?,?,1,'',NULL,NULL,?)",
                   (space, OWNER, OTHER, role))
    return settings.model_copy(update={'project_move_control_path': str(file), 'project_gate_directory': str(directory),
                                       'project_gate_space': space, 'project_device_fingerprint': device})


def permit(settings, phase, digest=None):
    with closing(sqlite3.connect(settings.project_move_control_path)) as db, db:
        db.execute('UPDATE move_participants SET allowed_action=?,graph_digest=?', (phase, digest))


async def phase(client, space, name, bundle=None):
    return await client.post('/v1/scopes/handover', params={'personal_space_id': space, 'project_id': 'alpha',
        'move_id': 'sample-move', 'phase': name}, **({'json': bundle} if bundle else {}))


@pytest.mark.asyncio
async def test_project_graph_handover_retains_history_bindings_and_is_idempotent(tmp_path):
    settings = fixture_settings()
    async with provider_client(settings) as (client, token):
        space = (await checked(await client.post('/v1/spaces', json={'kind': 'personal', 'name': 'Synthetic move'})))['id']
        group = graphiti_group_id(settings.provider_id, 'personal', space)
        driver = client._transport.app.state.store.runtime.driver
        try:
            await seed_people_and_work(client, space)
            other = await export(client, space, 'project:beta')
            source = participant(tmp_path / 'source', settings, space, 'owner', OWNER)
            target = participant(tmp_path / 'target', settings, space, 'vacant', OTHER)
            async with provider_client(source, token) as (old, _):
                # Compare with the same Provider already initialized and serving,
                # excluding any bootstrap activity from the transfer itself.
                global_image = await export(old, space, 'global')
                assert (await phase(old, space, 'seal')).status_code == 409
                permit(source, 'seal')
                sealed = await checked(await phase(old, space, 'seal'))
                assert (await checked(await phase(old, space, 'seal')))['digest'] == sealed['digest']
                labels = {label for row in sealed['envelope']['nodes'] for label in row['labels']}
                assert {'FuliTaskContext', 'FuliProjectAgentMemory', 'FuliProjectAgentAssignment'} <= labels
                assert 'FuliProjectAgent' not in labels
                permit(source, 'demote', sealed['digest'])
                for _ in range(2):
                    assert (await checked(await phase(old, space, 'demote')))['digest'] == sealed['digest']
            assert (await export(client, space, 'project:beta'))['digest'] == other['digest']
            latest = await export(client, space, 'global')
            different = [k for k in global_image if k not in ('digest', 'localOnlyCount', 'exportedAt')
                         and global_image[k] != latest.get(k)]
            delta = {}
            for collection in ('nodes', 'relationships'):
                before = {row['id']: row for row in global_image[collection]}
                after = {row['id']: row for row in latest[collection]}
                for key in before.keys() | after.keys():
                    if before.get(key) == after.get(key):
                        continue
                    old_props = before.get(key, {}).get('properties', {})
                    new_props = after.get(key, {}).get('properties', {})
                    delta[key] = sorted(k for k in old_props.keys() | new_props.keys() if old_props.get(k) != new_props.get(k))
            assert latest['digest'] == global_image['digest'], (different, delta)
            # Reuse the disposable graph as the other participant. Bring
            # only its required global references before importing the project.
            await clear(driver, space, group)
            await import_envelope(client, global_image)
            async with provider_client(target, token) as (new, _):
                permit(target, 'baseline')
                assert (await checked(await phase(new, space, 'baseline')))['empty']
                permit(target, 'stage', sealed['digest'])
                for _ in range(2):
                    assert (await checked(await phase(new, space, 'stage', sealed)))['digest'] == sealed['digest']
                permit(target, 'discard', sealed['digest'])
                assert (await checked(await phase(new, space, 'discard')))['ok']
                permit(target, 'stage', sealed['digest'])
                await checked(await phase(new, space, 'stage', sealed))
                permit(target, 'promote', sealed['digest'])
                for _ in range(2):
                    assert (await checked(await phase(new, space, 'promote')))['digest'] == sealed['digest']
                assert (await export(new, space, 'project:alpha'))['ids'] == sealed['envelope']['ids']
                rows, _, _ = await driver.execute_query("""
                    MATCH (:FuliSpace {id:$space})-[:HAS_TASK_CONTEXT_SESSION]->(session)-[:HAS_CONTEXT]->(task)
                    WHERE task.personal_project_id='alpha'
                    RETURN count(task) AS total, count(session.current_token) AS active
                    """, space=space, routing_='r')
                assert rows[0]['total'] == 1 and rows[0]['active'] == 0
        finally:
            await cleanup(driver, space, group)
