"""A follower's graph under the host's personal space, with `global` a copy
(docs/runner-roles-design.md §12, "A follower adopts the host's space ID"), on a
disposable Neo4j through the full Provider app.

Requires FULI_TEST_NEO4J_URI and FULI_TEST_NEO4J_EPHEMERAL=1. A space ID is taken
only by a graph without a personal space, so each test sets the personal spaces
other tests left in the shared graph aside for its length (`alone`) and puts
them back after. Two
computers cannot share one Neo4j under one space ID, so the host is played
first (its space exported, then removed) and the follower after it, in the same
graph, under the same space ID. Synthetic data only; each test removes its space.
"""
import json
from uuid import uuid4

import pytest
from neo4j import AsyncGraphDatabase

from fuli_graph.provider_values import graphiti_group_id, stable_uuid
from fuli_graph.system_agents import ensure_system_agents
from test_project_agent_memory_neo4j import fixture_settings, provider_client
from test_scope_export_neo4j import checked, cleanup, export
from test_scope_import_neo4j import OWNER, held, import_envelope, retouched, scenario

HABIT = 'Synthetic tables over prose'
# The recruitment policy a start makes (runtime._ensure_personal_space_defaults).
POLICY = '''
    MATCH (space:FuliSpace {id: $space})
    MERGE (policy:FuliProjectAgentRecruitmentPolicy {personal_space_id: $space})
    ON CREATE SET policy.confirmation_mode = 'automatic', policy.updated_at = datetime()
    MERGE (space)-[:HAS_PROJECT_AGENT_RECRUITMENT_POLICY]->(policy)'''


@pytest.fixture
async def alone():
    """The personal spaces other tests left in this graph, set aside while one test runs and put back
    after: their kind only, nothing else of them changes."""
    settings = fixture_settings()
    driver = AsyncGraphDatabase.driver(settings.neo4j_uri, auth=(settings.neo4j_user, settings.neo4j_password))
    records, _, _ = await driver.execute_query(
        "MATCH (s:FuliSpace {kind: 'personal'}) SET s.kind = 'personal-set-aside-by-test' RETURN s.id AS id")
    try:
        yield
    finally:
        await driver.execute_query("MATCH (s:FuliSpace) WHERE s.id IN $ids SET s.kind = 'personal'",
                                   ids=[row['id'] for row in records])
        await driver.close()


def follower_settings():
    return fixture_settings().model_copy(update={'global_replica': True})


async def no_personal_space(client):
    driver = client._transport.app.state.store.runtime.driver
    records, _, _ = await driver.execute_query("MATCH (s:FuliSpace {kind: 'personal'}) RETURN count(s) AS n")
    assert records[0]['n'] == 0, 'this test needs a graph without a personal space of its own'
    return driver


async def take_space(client, space_id, provider_id, status=200):
    response = await client.post('/v1/spaces', json={'name': 'Synthetic follower', 'kind': 'personal',
                                                     'id': space_id, 'provider_id': provider_id})
    assert response.status_code == status, response.text
    return response.json() if status == 200 else response.json()['detail']


async def snapshot(driver, space):
    """Every record of the space and every relationship among them, as text: what a
    start or a call must leave as it was."""
    records, _, _ = await driver.execute_query('''
        MATCH (space:FuliSpace {id: $space})
        OPTIONAL MATCH (space)-[*1..3]-(near) WHERE NOT near:FuliPrincipal
        WITH space, collect(DISTINCT near) AS near
        OPTIONAL MATCH (owned) WHERE owned.personal_space_id = $space OR owned.space_id = $space
            OR owned.group_id = space.group_id OR owned.display_name_space_id = $space
        WITH space, near, collect(DISTINCT owned) AS owned
        WITH [space] + near + owned AS nodes
        UNWIND nodes AS node
        WITH DISTINCT node
        OPTIONAL MATCH (node)-[link]->(other)
        RETURN labels(node) AS labels, properties(node) AS properties,
               collect([type(link), properties(link), properties(other)]) AS links''', space=space)
    return sorted(json.dumps(dict(row), sort_keys=True, default=str) for row in records)


async def host_global(settings):
    """The host: a space of its own with people, work and habits; started again, as a host's
    Provider is at every start of FULI, so its defaults are all there (fixed roles, recruitment
    policy); its global export; then removed from this graph."""
    async with provider_client(settings) as (client, _):
        await no_personal_space(client)
        driver, space, group = await scenario(client)
    async with provider_client(settings) as (client, _):
        try:
            envelope = await export(client, space, 'global')
        finally:
            await cleanup(driver_of(client), space, group)
    assert f'FuliProjectAgentRecruitmentPolicy:{space}' in envelope['ids']['nodes']
    return space, envelope


def driver_of(client):
    return client._transport.app.state.store.runtime.driver


def without_policy(envelope, space):
    """What a host whose Provider was not started again since its space was made exports: no policy."""
    policy = f'FuliProjectAgentRecruitmentPolicy:{space}'

    def drop(changed):
        changed['nodes'] = [node for node in changed['nodes'] if node['id'] != policy]
        changed['relationships'] = [link for link in changed['relationships'] if link['end'] != policy]
        changed['ids'] = {'nodes': [item for item in changed['ids']['nodes'] if item != policy],
                          'relationships': [item for item in changed['ids']['relationships'] if policy not in item]}
    return retouched(envelope, drop)


@pytest.mark.asyncio
async def test_a_space_id_is_taken_only_by_a_graph_without_a_personal_space_and_under_the_same_provider_id(alone):
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        driver = await no_personal_space(client)
        space_id = str(uuid4())
        try:
            refused = await take_space(client, space_id, 'another-provider', status=409)
            assert refused['code'] == 'space_provider_mismatch'
            made = await take_space(client, space_id, settings.provider_id)
            assert made['id'] == space_id
            assert made['group_id'] == graphiti_group_id(settings.provider_id, 'personal', space_id)
            assert (await take_space(client, space_id, settings.provider_id))['id'] == space_id, 'the same again: as it is'
            before = await snapshot(driver, space_id)
            other = await take_space(client, str(uuid4()), settings.provider_id, status=409)
            assert other['code'] == 'personal_space_exists'
            assert await snapshot(driver, space_id) == before
            records, _, _ = await driver.execute_query("MATCH (s:FuliSpace {kind: 'personal'}) RETURN s.id AS id")
            assert [row['id'] for row in records] == [space_id], 'nothing changed'
        finally:
            await cleanup(driver, space_id, graphiti_group_id(settings.provider_id, 'personal', space_id))


@pytest.mark.asyncio
async def test_while_global_is_a_copy_no_start_or_call_writes_a_default_of_it(alone):
    settings = follower_settings()
    space_id = str(uuid4())
    group = graphiti_group_id(settings.provider_id, 'personal', space_id)
    async with provider_client(settings) as (client, _):
        driver = await no_personal_space(client)
        try:
            await take_space(client, space_id, settings.provider_id)
            before = await snapshot(driver, space_id)
            digest = (await held(client, space_id, 'global'))['digest']
            for path in ('/v1/project-agents/system-hr', '/v1/project-agents/system-coordinator'):
                response = await client.post(path, params={'personal_space_id': space_id})
                assert response.status_code == 409, response.text
                assert response.json()['detail']['code'] == 'global_not_synced'
            listed = await checked(await client.get('/v1/project-agents', params={'personal_space_id': space_id}))
            assert listed == [] or not listed.get('agents'), listed
            assert await snapshot(driver, space_id) == before
            assert (await held(client, space_id, 'global'))['digest'] == digest
        except BaseException:
            await cleanup(driver, space_id, group)
            raise
    # Started again, as a follower's Provider is at every preparation.
    async with provider_client(settings) as (client, _):
        driver = client._transport.app.state.store.runtime.driver
        try:
            assert await snapshot(driver, space_id) == before
        finally:
            await cleanup(driver, space_id, group)


@pytest.mark.asyncio
async def test_a_graph_whose_global_is_its_own_still_makes_its_defaults(alone):
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        driver = await no_personal_space(client)
        space_id = str(uuid4())
        try:
            await take_space(client, space_id, settings.provider_id)
            bole = await checked(await client.post('/v1/project-agents/system-hr', params={'personal_space_id': space_id}))
            assert bole['agent_id'] == 'employee.bole'
            records, _, _ = await driver.execute_query('''
                MATCH (:FuliSpace {id: $space})-[:HAS_PROJECT_AGENT_IDENTITY]->(agent:FuliProjectAgent)
                RETURN count(agent) AS n''', space=space_id)
            assert records[0]['n'] == 4
        finally:
            await cleanup(driver, space_id, graphiti_group_id(settings.provider_id, 'personal', space_id))


@pytest.mark.asyncio
async def test_the_hosts_global_lands_under_the_same_space_and_task_entry_reads_its_habits(alone):
    settings = fixture_settings()
    space_id, envelope = await host_global(settings)
    group = graphiti_group_id(settings.provider_id, 'personal', space_id)
    async with provider_client(follower_settings()) as (client, _):
        driver = await no_personal_space(client)
        try:
            made = await take_space(client, space_id, settings.provider_id)
            assert made['group_id'] == envelope['groupId']
            result = await import_envelope(client, envelope)
            assert result['adoptedDefaults'] == 0, 'this graph made none of its own'
            assert result['dangling']['count'] == 0
            # Every record as the host has it. Only the scopes differ where a record is also in a host project
            # (an episode that is evidence in global and alpha): no project was copied here.
            mine = await held(client, space_id, 'global')
            for kind in ('nodes', 'relationships'):
                assert ([{**item, 'scopes': None} for item in mine[kind]]
                        == [{**item, 'scopes': None} for item in envelope[kind]]), kind
            # The fixed roles came with the copy: read here, never written.
            before = await snapshot(driver, space_id)
            bole = await checked(await client.post('/v1/project-agents/system-hr', params={'personal_space_id': space_id}))
            assert bole['agent_id'] == 'employee.bole'
            assert await snapshot(driver, space_id) == before
            # A project of this computer's own, whose task entry merges the host's global habits first (D2).
            await checked(await client.put('/v1/personal-projects', json={
                'personal_space_id': space_id, 'project_id': 'synthetic-local',
                'profile': {'name': 'Synthetic local', 'lifecycle': 'active', 'purpose': 'A project of the follower.'}}))
            entry = await checked(await client.get('/v1/collaboration-preferences', params={
                'personal_space_id': space_id, 'personal_project_id': 'synthetic-local'}))
            assert HABIT in json.dumps(entry, ensure_ascii=False)
            again = await import_envelope(client, envelope)
            assert again['nodes']['created'] == again['nodes']['updated'] == again['nodes']['deleted'] == 0
            assert again['relationships']['created'] == again['relationships']['updated'] == 0
        finally:
            await cleanup(driver, space_id, group)


@pytest.mark.asyncio
async def test_the_first_copy_of_global_takes_over_the_defaults_made_here_and_nothing_else(alone):
    settings = fixture_settings()
    space_id, envelope = await host_global(settings)
    group = graphiti_group_id(settings.provider_id, 'personal', space_id)
    habit = next(node for node in envelope['nodes'] if node['properties'].get('name') == HABIT)
    async with provider_client(follower_settings()) as (client, _):
        driver = await no_personal_space(client)
        try:
            await take_space(client, space_id, settings.provider_id)
            # Defaults this graph made before it knew (a start of a Provider that was not yet a follower's),
            # and an edge of this computer's own on one of them.
            await ensure_system_agents(driver, settings.provider_id, space_id)
            await driver.execute_query(POLICY, space=space_id)
            jefa = stable_uuid(settings.provider_id, space_id, 'project-agent', 'employee.jefa')
            await checked(await client.put('/v1/personal-projects', json={
                'personal_space_id': space_id, 'project_id': 'synthetic-local',
                'profile': {'name': 'Synthetic local', 'lifecycle': 'active', 'purpose': 'Local edge on a default.'}}))
            await driver.execute_query('''
                MATCH (:FuliSpace {id: $space})-[:CONTAINS_PROJECT]->(project:FuliPersonalProject {project_id: 'synthetic-local'})
                MATCH (agent:FuliProjectAgent {id: $jefa})
                CREATE (project)-[:HAS_PROJECT_AGENT_ASSIGNMENT]->(:FuliProjectAgentAssignment {
                  id: $space + '-local-jefa', assignment_id: $space + '-local-jefa', status: 'active', revision: 0,
                  legacy_assignment: false, reason: 'Synthetic', responsibility: 'Synthetic', work_kinds: ['planning'],
                  capabilities: ['planning'], assigned_at: datetime(), updated_at: datetime()})-[:ASSIGNED_AGENT]->(agent)
            ''', space=space_id, jefa=jefa)

            # Another record of this computer's under an ID the envelope names: still refused, nothing written.
            await driver.execute_query('''
                CREATE (:Entity {uuid: $uuid, group_id: $group, name: 'Synthetic local namesake'})''',
                uuid=habit['properties']['uuid'], group=group)
            before = await snapshot(driver, space_id)
            refused = await import_envelope(client, envelope, status=409)
            assert refused['code'] == 'replica_scope_owned_here'
            assert await snapshot(driver, space_id) == before
            await driver.execute_query('MATCH (n:Entity {uuid: $uuid}) DETACH DELETE n', uuid=habit['properties']['uuid'])

            result = await import_envelope(client, envelope)
            assert result['adoptedDefaults'] == 5, 'the four fixed roles and the recruitment policy'
            records, _, _ = await driver.execute_query('''
                MATCH (space:FuliSpace {id: $space})-[link:HAS_PROJECT_AGENT_IDENTITY]->(agent:FuliProjectAgent)
                WHERE agent.system_managed
                RETURN agent.id AS id, agent.fuli_replica_owner AS owner, agent.fuli_replica_scopes AS scopes,
                       link.fuli_replica_owner AS link_owner, count(link) AS links''', space=space_id)
            assert len(records) == 4
            assert all(row['owner'] == OWNER and row['scopes'] == ['global'] for row in records)
            assert all(row['link_owner'] == OWNER and row['links'] == 1 for row in records), 'taken over, not doubled'
            host_jefa = next(node for node in envelope['nodes'] if node['properties'].get('id') == jefa)
            records, _, _ = await driver.execute_query('MATCH (a:FuliProjectAgent {id: $jefa}) RETURN a.profile_json AS p',
                                                       jefa=jefa)
            assert records[0]['p'] == host_jefa['properties']['profile_json'], 'the owner\'s properties'
            records, _, _ = await driver.execute_query('''
                MATCH (:FuliProjectAgentAssignment {id: $id})-[link:ASSIGNED_AGENT]->(:FuliProjectAgent {id: $jefa})
                RETURN link.fuli_replica_owner AS owner''', id=f'{space_id}-local-jefa', jefa=jefa)
            assert [row['owner'] for row in records] == [None], 'this computer\'s own edge on it stays its own'
            again = await import_envelope(client, envelope)
            assert again['adoptedDefaults'] == 0
            assert again['nodes']['created'] == again['nodes']['updated'] == again['nodes']['deleted'] == 0
            assert again['relationships']['created'] == again['relationships']['updated'] == 0
        finally:
            await cleanup(driver, space_id, group)


@pytest.mark.asyncio
async def test_a_graph_whose_global_is_its_own_never_hands_its_defaults_to_an_import(alone):
    settings = fixture_settings()
    space_id, envelope = await host_global(settings)
    group = graphiti_group_id(settings.provider_id, 'personal', space_id)
    async with provider_client(settings) as (client, _):
        driver = await no_personal_space(client)
        try:
            await take_space(client, space_id, settings.provider_id)
            await checked(await client.post('/v1/project-agents/system-hr', params={'personal_space_id': space_id}))
            refused = await import_envelope(client, envelope, status=409)
            assert refused['code'] == 'replica_scope_owned_here'
        finally:
            await cleanup(driver, space_id, group)


@pytest.mark.asyncio
async def test_a_default_made_here_that_the_owner_does_not_have_goes_as_any_copy_the_owner_no_longer_has(alone):
    settings = fixture_settings()
    space_id, envelope = await host_global(settings)
    group = graphiti_group_id(settings.provider_id, 'personal', space_id)
    async with provider_client(follower_settings()) as (client, _):
        driver = await no_personal_space(client)
        try:
            await take_space(client, space_id, settings.provider_id)
            await ensure_system_agents(driver, settings.provider_id, space_id)
            await driver.execute_query(POLICY, space=space_id)
            result = await import_envelope(client, without_policy(envelope, space_id))
            assert result['adoptedDefaults'] == 5
            assert result['nodes']['deleted'] == 1
            records, _, _ = await driver.execute_query(
                'MATCH (p:FuliProjectAgentRecruitmentPolicy {personal_space_id: $space}) RETURN count(p) AS n', space=space_id)
            assert records[0]['n'] == 0
        finally:
            await cleanup(driver, space_id, group)
