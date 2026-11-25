"""A sealed project retains its scoped records and global bindings through both role transitions."""
from contextlib import closing
from hashlib import sha256
from importlib.metadata import version
import sqlite3

import pytest

from fuli_graph.provider_values import graphiti_group_id
from fuli_graph.scope_export import read_space
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


def same_package(a, b):
    assert a['digest'] == b['digest'] and a['bindings'] == b['bindings']
    for field in ('ids', 'nodes', 'relationships', 'externalRefs'):
        assert a['envelope'][field] == b['envelope'][field]


async def stored_graph(driver, space, group):
    """Inspect the disposable database directly, including replica ownership markers."""
    async with driver.read_transaction() as tx:
        graph = (await read_space(tx, {'id': space, 'group_id': group})).classification
        return ({key: (node.labels, dict(node.properties)) for key, node in graph.nodes.items()},
                {edge.element_id: (edge.type, edge.start, edge.end, dict(edge.properties))
                 for edge in graph.relationships})


def permit(settings, phase, digest=None, baseline=None):
    with closing(sqlite3.connect(settings.project_move_control_path)) as db, db:
        db.execute('UPDATE move_participants SET allowed_action=?,graph_digest=?,baseline_digest=?', (phase, digest, baseline))


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
                denied = await phase(old, space, 'seal')
                assert denied.status_code == 409 and denied.json()['detail']['code'] == 'project_move_phase_unconfirmed'
                permit(source, 'seal')
                sealed = await checked(await phase(old, space, 'seal'))
                assert (await checked(await phase(old, space, 'seal')))['digest'] == sealed['digest']
                async def blocked_source(code):
                    before = await export(old, space, 'project:alpha')
                    response = await phase(old, space, 'seal')
                    assert response.status_code == 409 and response.json()['detail']['code'] == code
                    assert (await export(old, space, 'project:alpha'))['digest'] == before['digest']

                await driver.execute_query("""MATCH (s:FuliSpace {id:$space})-[:CONTAINS_PROJECT]->(a:FuliPersonalProject {project_id:'alpha'}),
                    (s)-[:CONTAINS_PROJECT]->(b:FuliPersonalProject {project_id:'beta'})
                    CREATE (a)-[:PERSONAL_PROJECT_RELATION {id:$id,relation_type:'PART_OF',status:'active'}]->(b)""",
                    space=space, id=space+'-hierarchy')
                await blocked_source('project_move_hierarchy_dependency')
                await driver.execute_query('MATCH ()-[r:PERSONAL_PROJECT_RELATION {id:$id}]->() DELETE r', id=space+'-hierarchy')
                await driver.execute_query("""CREATE (:Entity {uuid:$id,group_id:$group,name:'Shared synthetic habit',
                    fuli_profile_aspect:'taste',fuli_preference_scope:'project',fuli_preference_project_id:'alpha',
                    fuli_preference_project_ids:['alpha','beta']})""", id=space+'-shared', group=group)
                await blocked_source('project_move_shared_record')
                await driver.execute_query('MATCH (n:Entity {uuid:$id,group_id:$group}) DELETE n', id=space+'-shared', group=group)
                # A single foreign marker mixed into an otherwise owned project
                # cannot be sealed. Inspect raw graph state because export is owner-only.
                root = "MATCH (:FuliSpace {id:$space})-[:CONTAINS_PROJECT]->(p:FuliPersonalProject {project_id:'alpha'})"
                await driver.execute_query(root + " SET p.fuli_replica_owner=$peer,p.fuli_replica_scopes=['project:alpha']",
                                           space=space, peer=OTHER)
                mixed = await stored_graph(driver, space, group)
                denied = await phase(old, space, 'seal')
                assert denied.status_code == 409 and denied.json()['detail']['code'] == 'project_move_mixed_owners'
                assert await stored_graph(driver, space, group) == mixed
                await driver.execute_query(root + ' REMOVE p.fuli_replica_owner,p.fuli_replica_scopes', space=space)
                baseline = sealed
                # Add one scoped record after the old replica was captured.
                await driver.execute_query("""CREATE (:Entity {uuid:$id,group_id:$group,name:'New item',
                    fuli_profile_aspect:'taste',fuli_preference_scope:'project',fuli_preference_project_id:'alpha'})""",
                    id=space + '-later', group=group)
                sealed = await checked(await phase(old, space, 'seal'))
                assert sealed['digest'] != baseline['digest']
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
                # Changing a bound global record on the recipient must leave
                # that global content intact and the project absent.
                lead = next(row for row in global_image['nodes'] if 'FuliProjectAgent' in row['labels']
                            and row['properties'].get('agent_id') == 'scope-lead')
                key, original = lead['properties']['id'], lead['properties']['profile_json']
                change = 'MATCH (n:FuliProjectAgent {id:$id}) SET n.profile_json=$value'
                await driver.execute_query(change, id=key, value=original + ' ')
                changed_graph = await stored_graph(driver, space, group)
                permit(target, 'stage', sealed['digest'])
                refused = await phase(new, space, 'stage', sealed)
                assert refused.status_code == 409 and refused.json()['detail']['code'] == 'project_move_external_content_changed'
                assert await stored_graph(driver, space, group) == changed_graph
                permit(target, 'baseline')
                assert (await checked(await phase(new, space, 'baseline')))['empty']
                await driver.execute_query(change, id=key, value=original)
                permit(target, 'stage', sealed['digest'])
                for _ in range(2):
                    assert (await checked(await phase(new, space, 'stage', sealed)))['digest'] == sealed['digest']
                permit(target, 'discard', sealed['digest'])
                assert (await checked(await phase(new, space, 'discard')))['ok']
                permit(target, 'stage', sealed['digest'])
                await checked(await phase(new, space, 'stage', sealed))
                # A target which already held an older replica must restore it
                # exactly. Discarding would lose the previous valid contents.
                permit(target, 'discard', sealed['digest'])
                await checked(await phase(new, space, 'discard'))
                permit(target, 'stage', baseline['digest'])
                await checked(await phase(new, space, 'stage', baseline))
                permit(target, 'baseline')
                saved = await checked(await phase(new, space, 'baseline'))
                same_package(saved, baseline)
                permit(target, 'stage', sealed['digest'], saved['digest'])
                await checked(await phase(new, space, 'stage', sealed))
                permit(target, 'discard', sealed['digest'], saved['digest'])
                refused = await phase(new, space, 'discard')
                assert refused.status_code == 409 and refused.json()['detail']['code'] == 'project_move_baseline_required'
                # Baseline export only accepts the particular source in the receipt.
                with closing(sqlite3.connect(target.project_move_control_path)) as db, db:
                    db.execute("UPDATE move_participants SET source=?,allowed_action='baseline'", ('f' * 64,))
                before = await stored_graph(driver, space, group)
                refused = await phase(new, space, 'baseline')
                assert refused.status_code == 409 and refused.json()['detail']['code'] == 'project_move_wrong_owner'
                assert await stored_graph(driver, space, group) == before
                permit(target, 'promote', sealed['digest'])
                refused = await phase(new, space, 'promote')
                assert refused.status_code == 409 and refused.json()['detail']['code'] == 'project_move_wrong_owner'
                assert await stored_graph(driver, space, group) == before
                with closing(sqlite3.connect(target.project_move_control_path)) as db, db:
                    db.execute('UPDATE move_participants SET source=?', (OWNER,))
                permit(target, 'restore', sealed['digest'], saved['digest'])
                for _ in range(2):
                    assert (await checked(await phase(new, space, 'restore', saved)))['digest'] == saved['digest']
                permit(target, 'baseline')
                same_package(await checked(await phase(new, space, 'baseline')), saved)
                permit(target, 'stage', sealed['digest'], saved['digest'])
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
                # Open the installed owner's gate as the coordinator does.
                for file in (tmp_path / 'target' / sha256(space.encode()).hexdigest()).glob('*.sqlite'):
                    with closing(sqlite3.connect(file)) as db, db:
                        db.execute("UPDATE gates SET role='owner',state='open',generation=2")
                archived = 'fuli-task-scope-alpha-0001'
                new.headers['x-fuli-client-version'] = version('fuli-graph-provider')
                checkpoint = await new.put('/v1/task-contexts/' + archived + '/checkpoint', json={
                    'personal_space_id': space, 'source_application': 'codex', 'disposition': 'retain_nothing',
                    'reason': 'Synthetic retired context', 'fingerprint': 'd' * 64})
                assert (checkpoint.status_code, checkpoint.json()['detail']) == (404, 'Task context is unknown or superseded')
                entry = await new.put('/v1/task-contexts', json={'personal_space_id': space, 'personal_project_id': 'alpha',
                    'session_id': 'synthetic-new-session', 'source_application': 'codex', 'token': archived})
                assert (entry.status_code, entry.json()['detail']) == (409, 'Task context token is already in use')
                assert (await export(new, space, 'project:alpha', vectors=False))['digest'] == sealed['envelope']['digest']
                fresh = await checked(await new.put('/v1/task-contexts', json={'personal_space_id': space,
                    'personal_project_id': 'alpha', 'session_id': 'synthetic-fresh-session', 'source_application': 'codex',
                    'token': 'fuli-task-synthetic-fresh'}))
                assert fresh['token'] == 'fuli-task-synthetic-fresh'

        finally:
            await cleanup(driver, space, group)
