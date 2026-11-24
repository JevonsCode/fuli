"""Scope import on a disposable Neo4j through the full Provider app
(docs/runner-roles-design.md, "Scopes in the graph", "Import").

Requires FULI_TEST_NEO4J_URI and FULI_TEST_NEO4J_EPHEMERAL=1. One Neo4j holds
one copy of a space, so each scenario exports its synthetic space, keeps the
envelopes, clears the space's records (not the space) and imports them back
as a copy owned by a synthetic computer. Only the scenario's space is removed.
"""
import copy
import json
from uuid import uuid4

import pytest

from fuli_graph import scope_import
from fuli_graph.scope_export import envelope_digest
from test_project_agent_memory_neo4j import fixture_settings, provider_client, write_payload
from test_scope_export_neo4j import checked, cleanup, export, seed_knowledge, seed_people_and_work

OWNER, OTHER = 'a' * 64, 'b' * 64
SCOPES = ('global', 'project:alpha', 'project:beta', 'project:gamma')


async def import_envelope(client, envelope, owner=OWNER, status=200):
    response = await client.post('/v1/scopes/import', json={'owner': owner, 'envelope': envelope})
    assert response.status_code == status, response.text
    return response.json() if status == 200 else response.json()['detail']


async def exports(client, space, **options):
    return {scope: await export(client, space, scope, **options) for scope in SCOPES}


async def clear(driver, space, group):
    """Every record of the space but the space itself and its owner."""
    await driver.execute_query('''
        MATCH (:FuliSpace {id: $space})-[*1..5]->(below) WHERE NOT below:FuliSpace DETACH DELETE below
    ''', space=space)
    await driver.execute_query('''
        MATCH (node) WHERE NOT node:FuliSpace AND (node.group_id = $group OR node.space_id = $space
            OR node.personal_space_id = $space OR node.space = $space)
        DETACH DELETE node
    ''', space=space, group=group)


async def state(client, driver, space):
    """What a refused or failed import must leave as it was: every scope's
    export digest (or why there is none) and every copied record."""
    digests = {}
    for scope in SCOPES:
        response = await client.post('/v1/scopes/export', json={'personal_space_id': space, 'scope': scope})
        digests[scope] = response.json()['digest'] if response.status_code == 200 else response.status_code
    records, _, _ = await driver.execute_query('''
        CALL { MATCH (n) WHERE n.fuli_replica_owner IN $owners RETURN count(n) AS nodes }
        CALL { MATCH ()-[r]->() WHERE r.fuli_replica_owner IN $owners RETURN count(r) AS links }
        RETURN nodes, links''', owners=[OWNER, OTHER])
    return digests, records[0]['nodes'], records[0]['links']


def redigested(envelope, **changes):
    changed = {**copy.deepcopy(envelope), **changes}
    return {**changed, 'digest': envelope_digest(changed)}


async def scenario(client):
    space = (await checked(await client.post('/v1/spaces', json={
        'name': f'Synthetic scope import {uuid4().hex[:8]}', 'kind': 'personal'})))['id']
    driver = client._transport.app.state.store.runtime.driver
    records, _, _ = await driver.execute_query('MATCH (s:FuliSpace {id: $id}) RETURN s.group_id AS g', id=space)
    group = records[0]['g']
    await seed_people_and_work(client, space)
    await seed_knowledge(driver, space, group)
    # Two habits as task entry and search read them: confirmed by the person, with a summary.
    await driver.execute_query('''
        UNWIND $items AS item
        CREATE (:Entity {uuid: $space + item.suffix, group_id: $group, name: item.name, summary: item.name,
                fuli_type: 'PersonalPreference', fuli_profile_aspect: 'taste',
                fuli_confirmation_status: 'confirmed', fuli_confirmation_basis_json: $basis,
                fuli_qualified_use_count: 3, fuli_utility_score: 0.4, fuli_preference_scope: item.scope,
                fuli_preference_project_id: item.project})
    ''', space=space, group=group, basis=json.dumps({
        'existence_reason': 'Synthetic', 'quadrant_reason': 'Synthetic', 'proposed_by': {'kind': 'user'},
        'confirmed_by': {'kind': 'user'}, 'confirmed_at': '2026-11-01T00:00:00+00:00'}), items=[
        {'suffix': '-pref-global', 'name': 'Synthetic tables over prose', 'scope': 'global', 'project': None},
        {'suffix': '-pref-alpha', 'name': 'Synthetic short commits', 'scope': 'project', 'project': 'alpha'}])
    return driver, space, group


async def node(driver, export_id):
    label, key = export_id.split(':', 1)
    records, _, _ = await driver.execute_query(
        f'MATCH (n:{label}) WHERE n.uuid = $key OR n.id = $key RETURN properties(n) AS p', key=key)
    return records[0]['p'] if records else None


@pytest.mark.asyncio
async def test_a_copied_space_exports_the_same_envelopes_and_a_second_import_changes_nothing():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        driver, space, group = await scenario(client)
        try:
            original = await exports(client, space)
            answered = await reads(client, space)
            await clear(driver, space, group)
            assert (await export(client, space, 'global'))['nodes'] == []
            for scope in SCOPES:
                result = await import_envelope(client, original[scope])
                # A record an earlier scope brought (the episode is evidence in global and alpha) gains this scope.
                written = {kind: result[kind]['created'] + result[kind]['updated']
                           for kind in ('nodes', 'relationships')}
                assert written == {'nodes': len(original[scope]['nodes']),
                                   'relationships': len(original[scope]['relationships'])}, scope
                assert result['dangling']['count'] == 0 and result['undeclaredProperties'] == {}, scope
            again = await exports(client, space)
            for scope in SCOPES:
                assert again[scope]['digest'] == original[scope]['digest'], scope
                assert again[scope]['nodes'] == original[scope]['nodes'], scope
            # Reads see a copy as they see any record, answer without its marker, and write nothing to it.
            copied = await reads(client, space)
            assert copied == answered and 'fuli_replica' not in str(copied)
            assert 'Synthetic tables over prose' in str(copied[0]) and 'Synthetic short commits' in str(copied[0])
            assert 'scope-lead' in str(copied[1]) and 'Synthetic short commits' in str(copied[2])
            for scope in SCOPES:
                assert (await export(client, space, scope))['digest'] == original[scope]['digest'], scope
            for scope in SCOPES:
                result = await import_envelope(client, original[scope])
                assert result['nodes'] == {'created': 0, 'updated': 0, 'unchanged': len(original[scope]['nodes']),
                                           'deleted': 0, 'ownerDeleted': 0}, scope
                assert result['relationships'] == {'created': 0, 'updated': 0, 'deleted': 0,
                                                   'unchanged': len(original[scope]['relationships'])}, scope
            # Each record names every scope it was copied for, and its owner.
            both = await node(driver, f'Entity:{space}-habit-both')
            assert (both['fuli_replica_scopes'], both['fuli_replica_owner']) == (['project:alpha', 'project:beta'],
                                                                                OWNER)
            episode = await node(driver, f'Episodic:{space}-episode')
            assert episode['fuli_replica_scopes'] == ['global', 'project:alpha', 'project:beta']
            # Task contexts read as finished history: under one session with no current task.
            records, _, _ = await driver.execute_query('''
                MATCH (:FuliSpace {id: $space})-[:HAS_TASK_CONTEXT_SESSION]->(session)-[:HAS_CONTEXT]->(task)
                RETURN session.current_token AS current, session.fuli_replica_owner AS owner,
                       collect(task.token) AS tokens''', space=space)
            assert [(row['current'], row['owner'], sorted(row['tokens'])) for row in records] == [
                (None, OWNER, ['fuli-task-scope-alpha-0001', 'fuli-task-scope-beta-0001'])]
            resumed = await client.get('/v1/task-contexts/fuli-task-scope-alpha-0001', params={
                'personal_space_id': space, 'source_application': 'codex'})
            assert resumed.status_code == 404, resumed.text
        finally:
            await cleanup(driver, space, group)


async def reads(client, space):
    """What task entry, the FLA list and search answer for project alpha."""
    entry = await checked(await client.get('/v1/collaboration-preferences', params={
        'personal_space_id': space, 'personal_project_id': 'alpha'}))
    agents = await checked(await client.get('/v1/project-agents', params={
        'personal_space_id': space, 'personal_project_id': 'alpha'}))
    found = await checked(await client.post('/v1/search', json={
        'space_ids': [space], 'query': 'Synthetic short commits', 'personal_project_ids': ['alpha'],
        'active_personal_project_id': 'alpha'}))
    return entry, agents, found


async def local_work(client, driver, space, agent_ids):
    """This computer's own project, its FLAs' assignments in it (one to an FLA
    the owner will delete) and a project memory written by the Provider."""
    await checked(await client.put('/v1/personal-projects', json={
        'personal_space_id': space, 'project_id': 'local',
        'profile': {'name': 'Synthetic local', 'lifecycle': 'active', 'purpose': 'Local edges on copied FLAs.'}}))
    await driver.execute_query('''
        MATCH (:FuliSpace {id: $space})-[:CONTAINS_PROJECT]->(project:FuliPersonalProject {project_id: 'local'})
        UNWIND $agents AS agent_node
        MATCH (agent:FuliProjectAgent {id: agent_node})
        CREATE (project)-[:HAS_PROJECT_AGENT_ASSIGNMENT]->(:FuliProjectAgentAssignment {
                  id: $space + '-local-' + agent_node, assignment_id: $space + '-local-' + agent_node,
                  status: 'active', revision: 0, legacy_assignment: false, reason: 'Synthetic local',
                  responsibility: 'Synthetic', work_kinds: ['implementation'], capabilities: ['coding'],
                  assigned_at: datetime(), updated_at: datetime()})-[:ASSIGNED_AGENT]->(agent)
    ''', space=space, agents=agent_ids)
    await checked(await client.put('/v1/project-agents/scope-lead/memory', json=write_payload(
        space, personal_project_id='local', agent_id='scope-lead', idempotency_key='memory-local')))


@pytest.mark.asyncio
async def test_a_refresh_follows_the_owner_and_keeps_what_this_computer_points_at():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        driver, space, group = await scenario(client)
        try:
            await driver.execute_query('''
                MATCH (space:FuliSpace {id: $space})
                CREATE (:Entity {uuid: $space + '-habit-temp', group_id: $group, name: 'Temporary habit',
                        fuli_profile_aspect: 'taste', fuli_preference_scope: 'global'})
                CREATE (space)-[:HAS_PROJECT_AGENT_IDENTITY]->(:FuliProjectAgent {id: $space + '-agent-temp',
                        agent_id: 'scope-temp', status: 'active', profile_json: '{}'})
            ''', space=space, group=group)
            before = await exports(client, space)
            await driver.execute_query('''
                MATCH (gone) WHERE gone.uuid = $space + '-habit-temp' OR gone.id = $space + '-agent-temp'
                DETACH DELETE gone''', space=space)
            await driver.execute_query('''
                MATCH (habit:Entity {uuid: $space + '-habit'}) SET habit.name = 'Shorter answers'
                CREATE (:Entity {uuid: $space + '-habit-new', group_id: $group, name: 'New habit',
                        fuli_profile_aspect: 'taste', fuli_preference_scope: 'global'})
            ''', space=space, group=group)
            after = await export(client, space, 'global')
            await clear(driver, space, group)
            for scope in SCOPES:
                await import_envelope(client, before[scope])
            lead = next(n['id'] for n in before['global']['nodes'] if n['properties'].get('agent_id') == 'scope-lead')
            await local_work(client, driver, space, [lead.split(':', 1)[1], f'{space}-agent-temp'])
            # Writing this computer's project memory of a copied FLA leaves the copy as the owner has it.
            assert (await export(client, space, 'global'))['digest'] == before['global']['digest']

            result = await import_envelope(client, after)
            assert result['nodes']['created'] == 1 and result['nodes']['updated'] == 1
            assert result['nodes']['deleted'] == 1 and result['nodes']['ownerDeleted'] == 1
            assert (await node(driver, f'Entity:{space}-habit'))['name'] == 'Shorter answers'
            assert await node(driver, f'Entity:{space}-habit-temp') is None
            kept = await node(driver, f'FuliProjectAgent:{space}-agent-temp')
            assert kept['fuli_replica_owner_deleted_at'] is not None
            records, _, _ = await driver.execute_query('''
                MATCH (project:FuliPersonalProject {project_id: 'local'})-[:HAS_PROJECT_AGENT_ASSIGNMENT]->
                      (assignment)-[:ASSIGNED_AGENT]->(agent)
                OPTIONAL MATCH (agent)-[:HAS_WORKING_MEMORY]->(memory {personal_project_id: 'local'})
                RETURN agent.agent_id AS agent, project.fuli_replica_owner AS marked, count(memory) AS memories
                ORDER BY agent''')
            assert [tuple(row.values()) for row in records] == [('scope-lead', None, 1), ('scope-temp', None, 0)]
            refreshed = await export(client, space, 'global')
            assert refreshed['digest'] == after['digest']
            again = await import_envelope(client, after)
            assert again['nodes'] == {'created': 0, 'updated': 0, 'unchanged': len(after['nodes']), 'deleted': 0,
                                      'ownerDeleted': 0}
            assert again['relationships']['unchanged'] == len(after['relationships'])
        finally:
            await driver.execute_query('''
                MATCH (:FuliSpace {id: $space})-[:CONTAINS_PROJECT]->(:FuliPersonalProject {project_id: 'local'})
                      -[*1..2]->(below) DETACH DELETE below''', space=space)
            await cleanup(driver, space, group)


@pytest.mark.asyncio
async def test_a_failure_midway_writes_nothing_and_running_again_converges(monkeypatch):
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        driver, space, group = await scenario(client)
        try:
            before = await exports(client, space)
            await driver.execute_query('''
                MATCH (habit:Entity {uuid: $space + '-habit'}) SET habit.name = 'Shorter answers'
                WITH habit MATCH (old:Entity {uuid: $space + '-habit-old'}) DETACH DELETE old
                CREATE (:Entity {uuid: $space + '-habit-new', group_id: $group, name: 'New habit',
                        fuli_profile_aspect: 'taste', fuli_preference_scope: 'global'})
            ''', space=space, group=group)
            after = await export(client, space, 'global')
            await clear(driver, space, group)
            for scope in SCOPES:
                await import_envelope(client, before[scope])
            untouched = await state(client, driver, space)
            run = scope_import._run

            async def failing(transaction, query, **parameters):
                # New nodes are written; the changed ones, relationships and every removal are still to come.
                if 'MATCH (node) WHERE elementId(node) = row.element' in query:
                    raise RuntimeError('synthetic failure midway')
                return await run(transaction, query, **parameters)

            monkeypatch.setattr(scope_import, '_run', failing)
            with pytest.raises(RuntimeError, match='synthetic failure midway'):
                await client.post('/v1/scopes/import', json={'owner': OWNER, 'envelope': after})
            assert await state(client, driver, space) == untouched
            monkeypatch.setattr(scope_import, '_run', run)
            result = await import_envelope(client, after)
            assert result['nodes']['deleted'] == 1
            assert (await export(client, space, 'global'))['digest'] == after['digest']
        finally:
            await cleanup(driver, space, group)


@pytest.mark.asyncio
async def test_each_refused_envelope_writes_nothing():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        driver, space, group = await scenario(client)
        try:
            original = await exports(client, space)
            envelope = original['global']
            # This computer writes the scope itself: a copy never lands on its records.
            untouched = await state(client, driver, space)
            owned = await import_envelope(client, envelope, status=409)
            assert owned['code'] == 'replica_scope_owned_here' and owned['count'] > 0
            assert await state(client, driver, space) == untouched
            await clear(driver, space, group)
            empty = await state(client, driver, space)
            tampered = copy.deepcopy(envelope)
            tampered['nodes'][0]['properties']['name'] = 'Changed in transit'
            refusals = [
                (tampered, 422, 'replica_digest_mismatch'),
                (redigested(envelope, complete=False, unidentifiedNodes={'FuliKnowledgeAssignment': 1}), 422,
                 'replica_envelope_incomplete'),
                (redigested(envelope, graphFormat=envelope['graphFormat'] - 1), 409, 'replica_format_mismatch'),
                (redigested(envelope, replicaProtocol=2), 422, 'replica_protocol_unknown'),
                (redigested(envelope, groupId='another-provider-personal-' + space), 409, 'replica_space_mismatch'),
                (redigested(envelope, spaceId=str(uuid4())), 409, 'replica_space_mismatch'),
            ]
            for refused, status, code in refusals:
                detail = await import_envelope(client, refused, status=status)
                assert detail['code'] == code, detail
                assert await state(client, driver, space) == empty, code
            incomplete = await import_envelope(client, refusals[1][0], status=422)
            assert incomplete['leftOut'] == {'unidentifiedNodes': {'FuliKnowledgeAssignment': 1}}
            # A habit in alpha and beta: one owner writes both, or neither is copied with it.
            await import_envelope(client, original['project:alpha'], owner=OWNER)
            copied = await state(client, driver, space)
            crossed = await import_envelope(client, original['project:beta'], owner=OTHER, status=409)
            assert crossed['code'] == 'replica_cross_owner_record' and crossed['scope'] == 'project:alpha'
            assert await state(client, driver, space) == copied
        finally:
            await cleanup(driver, space, group)


@pytest.mark.asyncio
async def test_references_wait_for_their_scope_and_vectors_of_no_use_are_computed_here():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        driver, space, group = await scenario(client)
        try:
            original = await exports(client, space)
            light = await export(client, space, 'global', vectors=False)
            await clear(driver, space, group)
            # alpha before global: its FLAs and global habits are not here yet, so no empty node stands in.
            early = await import_envelope(client, original['project:alpha'])
            missing = {ref for item in early['dangling']['relationships'] for ref in item['missing']}
            assert early['dangling']['count'] > 0 and missing <= {ref['id'] for ref in original['project:alpha']
                                                                   ['externalRefs']}
            for ref in missing:
                assert await node(driver, ref) is None
            result = await import_envelope(client, light)
            assert result['nodes']['created'] + result['nodes']['updated'] == len(light['nodes'])
            habit = await node(driver, f'Entity:{space}-habit')
            embedder = client._transport.app.state.store.runtime.embedder
            assert habit['name_embedding'] == (await embedder.create_batch(['Short answers']))[0]
            assert 'fuli_semantic_vector' not in habit
            later = await import_envelope(client, original['project:alpha'])
            assert later['dangling']['count'] == 0
            # One of them came with global already (its MENTIONS is in both): alpha's import adds its scope.
            assert later['relationships']['created'] + later['relationships']['updated'] == early['dangling']['count']
            assert (await export(client, space, 'project:alpha'))['digest'] == original['project:alpha']['digest']
        finally:
            await cleanup(driver, space, group)
