"""Unique Agent names against a disposable loopback Neo4j, on a space shaped
like a long-used one: a name three FLAs share, one shared with a dismissed
FLA, one by two without any work, one across two projects, one a person chose
in a rename, one an FLA shares with a built-in role, and one a lead FULI hired
for a conversation project shares with an FLA of a registered project.

The upgrade needs nobody: the graph stays writable and every FLA keeps its
name. Only when the person settles the shared names (the FLAs page) are the
FLAs they agreed to renamed, with the old name in their history; from then on
the graph itself refuses a second Agent with a name. Every name and record is
synthetic; like test_graph_format_neo4j.py these tests empty the database and
run only with FULI_TEST_NEO4J_RESETTABLE=1.
"""
import asyncio
import json

import pytest

from fuli_graph.graph_format_migrations import GRAPH_FORMAT_VERSION
from fuli_graph.name_identity import identity_key
from fuli_graph.project_agent_names import is_generated_nickname
from fuli_graph.provider_values import stable_uuid
from test_graph_format_neo4j import (  # noqa: F401 - graph is a fixture
    ACCESS_TOKEN,
    _rows,
    _seed_legacy_principal,
    _version,
    graph,
)
from test_project_agent_memory_neo4j import provider_client

SPACE = 'legacy-space'
CONVERSATION_PROJECT = 'conversation-' + 'c0' * 32


def _agent(agent_id, display_name, *, status='active', test_source=None, work=0, last_turn=None, turns=0,
           hiring=False, created='2026-10-01T00:00:00Z', history=None, project='p-saturn'):
    """One FLA as FULI 23 stored it: `work` tasks of its own, one turn at
    `last_turn` or `turns` turns, and the hiring task of a lead FULI hired."""
    profile = {'name': '开发', 'display_name': display_name, 'responsibility': 'Synthetic work.',
               'status': status, **({'test_source': test_source} if test_source else {})}
    return {'agent_id': agent_id, 'profile_json': json.dumps(profile, ensure_ascii=False), 'status': status,
            'test_source': test_source, 'created_at': created, 'work': work, 'hiring': hiring,
            'turns': [last_turn] if last_turn else ['2026-11-23T00:00:00Z'] * turns,
            'history': json.dumps(history) if history else None, 'project': project}


PERSON_RENAME = [{'name': 'Robin Gray', 'until': '2026-11-01T00:00:00+00:00', 'reason': 'renamed'}]
AGENTS = [
    # Three share a name: the one with the most work keeps it; a test FLA gives way first.
    _agent('emery-a', 'Emery Fox', work=3, last_turn='2026-11-20T00:00:00Z'),
    _agent('emery-b', 'Emery Fox', work=1, last_turn='2026-11-21T00:00:00Z', project='p-backup'),
    _agent('emery-c', 'Emery Fox', test_source='synthetic-suite', work=5),
    # Shared with a dismissed FLA, however much it worked.
    _agent('blair-a', 'Blair Lake'),
    _agent('blair-b', 'Blair Lake', status='archived', work=9),
    # Two without any work: the one hired first keeps it.
    _agent('casey-a', 'Casey Hayes', created='2026-10-01T00:00:00Z'),
    _agent('casey-b', 'Casey Hayes', created='2026-10-02T00:00:00Z'),
    # Two projects, as much work each: the one active more recently keeps it.
    _agent('morgan-a', 'Morgan Vale', work=1, last_turn='2026-11-22T00:00:00Z'),
    _agent('morgan-b', 'Morgan Vale', work=1, last_turn='2026-11-02T00:00:00Z', project='p-backup'),
    # A lead FULI hired for a conversation project: its hiring task and a long
    # session do not outweigh one task in a registered project.
    _agent('quinn-lead', 'Quinn Shaw', hiring=True, turns=6, project=CONVERSATION_PROJECT),
    _agent('quinn-a', 'Quinn Shaw', work=1),
    # A name a person gave in a rename wins over more work.
    _agent('lyra-a', 'Lyra Lane', history=PERSON_RENAME),
    _agent('lyra-b', 'Lyra Lane', work=4, last_turn='2026-11-22T00:00:00Z'),
    # A built-in role's name stays the role's.
    _agent('bole-fla', 'Bole', work=2),
    _agent('nova', 'Nova Reed', work=1),
]
GIVING_WAY = {'emery-b': ('emery-a', 'less_work'), 'emery-c': ('emery-a', 'test'),
              'blair-b': ('blair-a', 'dismissed'), 'casey-b': ('casey-a', 'later'),
              'morgan-b': ('morgan-a', 'less_recent'), 'quinn-lead': ('quinn-a', 'temporary_lead'),
              'lyra-b': ('lyra-a', 'person_named'), 'bole-fla': ('employee.bole', 'built_in_role')}


async def _seed(settings, driver, agents=AGENTS):
    """The space with each FLA under the node ID the Provider writes it to."""
    await _seed_legacy_principal(driver)
    agents = [{**row, 'node_id': stable_uuid(settings.provider_id, SPACE, 'project-agent', row['agent_id'])}
              for row in agents]
    await driver.execute_query(
        '''
        MATCH (space:FuliSpace {id: $space})
        CREATE (space)-[:CONTAINS_PROJECT]->(:FuliPersonalProject {id: 'p-saturn', project_id: 'p-saturn',
                                                                   name: 'Saturn'})
        CREATE (space)-[:CONTAINS_PROJECT]->(:FuliPersonalProject {id: 'p-backup', project_id: 'p-backup',
                                                                   name: 'Station Backup'})
        CREATE (space)-[:CONTAINS_PROJECT]->(:FuliPersonalProject {id: $conversation, project_id: $conversation,
                                                                   scope_type: 'temporary'})
        CREATE (space)-[:HAS_PROJECT_AGENT_IDENTITY]->(:FuliProjectAgent {id: $bole,
                 agent_id: 'employee.bole', name: 'Bole', status: 'active', agent_type: 'hr',
                 profile_json: '{"name":"Bole","responsibility":"Synthetic hiring."}',
                 created_at: datetime('2026-09-01T00:00:00Z'), updated_at: datetime('2026-09-01T00:00:00Z')})
        CREATE (space)-[:HAS_TASK_CONTEXT_SESSION]->(:FuliTaskContextSession {id: 'session'})
        WITH space
        UNWIND $agents AS row
        MATCH (project:FuliPersonalProject {project_id: row.project})
        CREATE (space)-[:HAS_PROJECT_AGENT_IDENTITY]->(agent:FuliProjectAgent {id: row.node_id,
                 agent_id: row.agent_id, name: '开发', status: row.status, agent_type: 'durable',
                 profile_json: row.profile_json, test_source: row.test_source,
                 name_history_json: row.history,
                 created_at: datetime(row.created_at), updated_at: datetime('2026-10-15T00:00:00Z')})
        CREATE (project)-[:HAS_PROJECT_AGENT_ASSIGNMENT]->(:FuliProjectAgentAssignment {
                 id: 'assignment-' + row.agent_id, status: 'active', responsibility: 'Synthetic work.',
                 assigned_at: datetime(row.created_at)})-[:ASSIGNED_AGENT]->(agent)
        FOREACH (index IN CASE WHEN row.work > 0 THEN range(1, row.work) ELSE [] END |
          CREATE (space)-[:HAS_PROJECT_AGENT_TASK]->(:FuliProjectAgentTask {
                   id: row.agent_id + '-task-' + index, title: 'Synthetic task'})-[:HAS_PARTICIPANT]->(agent))
        FOREACH (_ IN CASE WHEN row.hiring THEN [1] ELSE [] END |
          CREATE (space)-[:HAS_PROJECT_AGENT_TASK]->(:FuliProjectAgentTask {
                   id: row.agent_id + '-hiring', title: '接任项目负责人', staffing_intent: 'default_lead'})
                 -[:HAS_PARTICIPANT]->(agent))
        WITH space, row
        MATCH (space)-[:HAS_TASK_CONTEXT_SESSION]->(session)
        FOREACH (index IN range(0, size(row.turns) - 1) |
          CREATE (session)-[:HAS_CONTEXT]->(:FuliTaskContext {id: row.agent_id + '-turn-' + index,
                   project_agent_id: row.agent_id, created_at: datetime(row.turns[index])}))
        ''',
        space=SPACE, agents=agents, conversation=CONVERSATION_PROJECT,
        bole=stable_uuid(settings.provider_id, SPACE, 'project-agent', 'employee.bole'),
    )
    await driver.execute_query("MERGE (f:FuliDataFormat {store: 'graph'}) SET f.version = 23")


async def _names(driver):
    rows = await _rows(driver, '''
        MATCH (a:FuliProjectAgent) RETURN a.agent_id AS agent_id, a.profile_json AS profile,
               a.name_history_json AS history, a.display_name_key AS key''')
    return {row['agent_id']: {'name': json.loads(row['profile']).get('display_name') or json.loads(row['profile'])['name'],
                              'history': json.loads(row['history'] or '[]'), 'key': row['key']} for row in rows}


def _settled(plan):
    keepers = {group['name']: next(item['agent_id'] for item in group['members'] if item['keeps'])
               for group in plan['groups']}
    return {item['agent_id']: (keepers[group['name']], item['gave_way'])
            for group in plan['groups'] for item in group['members'] if not item['keeps']}


def _renames(plan, *, leave_out=()):
    return {item['agent_id']: item['new_name'] for group in plan['groups'] for item in group['members']
            if not item['keeps'] and item['agent_id'] not in leave_out}


def _profile(agent_id, display_name, responsibility):
    return {'personal_space_id': SPACE, 'agent_id': agent_id, 'occupation': {'role': 'engineering'},
            'profile': {'name': '开发', 'display_name': display_name, 'responsibility': responsibility}}


@pytest.mark.asyncio
async def test_the_upgrade_needs_nobody_and_the_person_settles_shared_names_in_one_apply(graph):
    settings, driver = graph
    await _seed(settings, driver)
    before = await _names(driver)

    async with provider_client(settings, ACCESS_TOKEN) as (client, _):
        health = (await client.get('/health')).json()['data_format']
        assert health['state'] == 'current' and health['access'] == 'write' and health['pending'] == []
        assert await _version(driver) == GRAPH_FORMAT_VERSION
        # Nobody was renamed, and the built-in role holds its name.
        assert {agent_id: item['name'] for agent_id, item in (await _names(driver)).items() if agent_id in before} \
            == {agent_id: item['name'] for agent_id, item in before.items()}
        assert (await _names(driver))['employee.bole']['key'] == 'bole'

        # Ordinary writes keep working for FLAs that share a name: the first
        # holds the name, the next writes without it instead of failing.
        for agent_id in ('emery-a', 'emery-b'):
            updated = await client.put('/v1/project-agents', json=_profile(agent_id, 'Emery Fox', 'Updated work.'))
            assert updated.status_code == 200, updated.text
        keys = await _names(driver)
        assert (keys['emery-a']['key'], keys['emery-b']['key']) == ('emery fox', None)

        plan = (await client.get('/v1/project-agent-name-fixes', params={'personal_space_id': SPACE})).json()
        assert _settled(plan) == GIVING_WAY and plan['renames'] == len(GIVING_WAY)
        quinn = next(group for group in plan['groups'] if group['name'] == 'Quinn Shaw')
        # A temporary project stores no name: the console words it by its number.
        assert [item['projects'] for item in quinn['members']] == [
            [{'project_id': 'p-saturn', 'name': 'Saturn', 'scope_type': None}],
            [{'project_id': CONVERSATION_PROJECT, 'name': '', 'scope_type': 'temporary'}]]

        # The person keeps Emery Fox for emery-b and leaves casey-b's rename out.
        chosen = (await client.get('/v1/project-agent-name-fixes', params={
            'personal_space_id': SPACE, 'keep': ['emery-b']})).json()
        assert _settled(chosen)['emery-a'] == ('emery-b', 'person_chose')
        renames = _renames(chosen, leave_out={'casey-b'})
        applied = await client.post('/v1/project-agent-name-fixes/apply', json={
            'personal_space_id': SPACE, 'keep': ['emery-b'], 'renames': renames})
        assert applied.status_code == 200, applied.text
        # Only the rename left out is still listed.
        assert [group['name'] for group in applied.json()['groups']] == ['Casey Hayes']

        after = await _names(driver)
        for agent_id, new_name in renames.items():
            assert after[agent_id]['name'] == new_name and is_generated_nickname(new_name), agent_id
            assert after[agent_id]['key'] == identity_key(new_name), agent_id
            change = after[agent_id]['history'][-1]
            assert (change['name'], change['reason']) == (before[agent_id]['name'], 'duplicate_name'), agent_id
        assert after['emery-a']['history'][-1]['gave_way'] == 'person_chose'
        assert after['emery-b']['key'] == 'emery fox' and after['casey-b']['name'] == 'Casey Hayes'
        # The two the person left alike are not keyed by the apply, and each
        # still saves its own edits afterwards.
        assert (after['casey-a']['key'], after['casey-b']['key']) == (None, None)
        for agent_id in ('casey-b', 'casey-a'):
            edited = await client.put('/v1/project-agents', json={
                **_profile(agent_id, 'Casey Hayes', 'Edited work.'), 'occupation': {'role': 'design'}})
            assert edited.status_code == 200, edited.text
        record = (await client.get('/v1/project-agents/morgan-b', params={'personal_space_id': SPACE})).json()
        assert record['agent_id'] == 'morgan-b' and record['former_name'] == 'Morgan Vale'

        # The same apply again names renames that no longer exist: refused whole.
        again = await client.post('/v1/project-agent-name-fixes/apply', json={
            'personal_space_id': SPACE, 'keep': ['emery-b'], 'renames': renames})
        assert again.status_code == 409 and again.json()['detail']['code'] == 'agent_name_fixes_changed'
        # The name the keeper holds is refused to anyone else, with who has it.
        taken = await client.put('/v1/project-agents/morgan-b/name', json={
            'personal_space_id': SPACE, 'display_name': 'morgan  VALE'})
        assert taken.status_code == 409 and taken.json()['detail']['used_by'][0]['agent_id'] == 'morgan-a'

        # Every rename is listed, newest first; the person's 知道了 is kept with the space.
        changes = (await client.get('/v1/project-agent-name-changes', params={'personal_space_id': SPACE})).json()
        listed = {item['agent_id']: item for item in changes['items']}
        assert {*renames} <= {*listed} and changes['seen_until'] is None
        assert listed['morgan-b']['kept_by_name'] == 'Morgan Vale'
        assert listed['lyra-a']['change']['reason'] == 'renamed'
        newest = changes['items'][0]['change']['until']
        seen = await client.put('/v1/project-agent-name-changes/seen', json={'personal_space_id': SPACE,
                                                                             'until': newest})
        assert seen.status_code == 200 and seen.json()['seen_until'] is not None, seen.text


@pytest.mark.asyncio
async def test_two_agents_racing_for_one_name_cannot_both_have_it(graph):
    settings, driver = graph
    await _seed(settings, driver, [_agent('nova', 'Nova Reed')])
    async with provider_client(settings, ACCESS_TOKEN) as (client, _):
        assert (await client.get('/health')).json()['data_format']['state'] == 'current'

        def hire(agent_id):
            return client.put('/v1/project-agents', json={
                'personal_space_id': SPACE, 'agent_id': agent_id,
                'occupation': {'role': 'engineering'},
                'profile': {'name': '开发', 'display_name': 'Quinn Shaw', 'responsibility': 'Synthetic work.'}})

        answers = await asyncio.gather(*(hire(f'racer-{index}') for index in range(4)))
        assert sorted(answer.status_code for answer in answers) == [200, 409, 409, 409], [a.text for a in answers]
        refused = next(answer for answer in answers if answer.status_code == 409).json()['detail']
        assert 'agent_name_taken' in json.dumps(refused)
        # Renaming another Agent to it is refused with who has it.
        rename = await client.put('/v1/project-agents/nova/name', json={
            'personal_space_id': SPACE, 'display_name': 'quinn  SHAW'})
        assert rename.status_code == 409 and rename.json()['detail']['used_by'][0]['name'] == 'Quinn Shaw'

    keys = await _rows(driver, '''MATCH (a:FuliProjectAgent) WHERE a.display_name_key = 'quinn shaw'
                                  RETURN count(a) AS count''')
    assert keys == [{'count': 1}]


@pytest.mark.asyncio
async def test_the_name_rule_waits_behind_a_confirmed_step_and_stays_when_that_step_is_undone(graph):
    """graph/24 runs by itself, but never ahead of graph/23 while that step
    waits for the person: the graph stays at 22, read-only, without the rule.
    Once the person confirms 23 the rule follows at once. Undoing 23 takes the
    graph back to 22 and leaves the rule: it changed no record, a graph-22 FULI
    never writes the fields it covers, and the next confirmation finds it in place."""
    from test_graph_format_confirm_neo4j import REVIEW, TEMPORARY_NAME_SEED, _reviewed

    settings, driver = graph
    await _seed_legacy_principal(driver)
    await driver.execute_query(TEMPORARY_NAME_SEED)
    await driver.execute_query("MERGE (f:FuliDataFormat {store: 'graph'}) SET f.version = 22")
    rule = "SHOW CONSTRAINTS YIELD name WHERE name = 'fuli_project_agent_display_name' RETURN name"
    step = {'migration_id': 'graph/23-temporary-project-names', 'entrypoint': 'cli'}

    async with provider_client(_reviewed(settings), ACCESS_TOKEN) as (client, _):
        health = (await client.get('/health')).json()['data_format']
        assert (health['state'], health['version'], health['pending']) == (
            'pending_confirmation', 22, ['graph/23-temporary-project-names'])
        plan = (await client.post('/v1/data-format/preview')).json()['plan']
        assert plan['step']['id'] == 'graph/23-temporary-project-names' and plan['automatic'] == []
        assert await _rows(driver, rule) == []

        applied = await client.post('/v1/data-format/apply', headers=REVIEW,
                                    json={'digest': plan['digest'], 'entrypoint': 'cli'})
        assert applied.status_code == 200, applied.text
        assert applied.json()['data_format']['state'] == 'current'
        assert await _version(driver) == GRAPH_FORMAT_VERSION and len(await _rows(driver, rule)) == 1

        undone = await client.post('/v1/data-format/rollback', headers=REVIEW, json=step)
        assert undone.status_code == 200, undone.text
        assert await _version(driver) == 22 and len(await _rows(driver, rule)) == 1
        # The generated names are back, so 23 waits for the person again; the
        # rule is already there when they confirm.
        again = (await client.post('/v1/data-format/preview')).json()['plan']
        assert again['step']['id'] == 'graph/23-temporary-project-names'
        reapplied = await client.post('/v1/data-format/apply', headers=REVIEW,
                                      json={'digest': again['digest'], 'entrypoint': 'cli'})
        assert reapplied.status_code == 200, reapplied.text
        assert await _version(driver) == GRAPH_FORMAT_VERSION


async def _add_agent(driver, settings, agent_id, display_name, key=None):
    """One more FLA, holding ``key`` as its stored name identity."""
    await driver.execute_query(
        '''
        MATCH (space:FuliSpace {id: $space})
        CREATE (space)-[:HAS_PROJECT_AGENT_IDENTITY]->(:FuliProjectAgent {id: $node_id, agent_id: $agent_id,
                 name: '开发', status: 'active', agent_type: 'durable', profile_json: $profile_json,
                 display_name_space_id: CASE WHEN $key IS NULL THEN null ELSE $space END, display_name_key: $key,
                 created_at: datetime('2026-10-01T00:00:00Z'), updated_at: datetime('2026-10-15T00:00:00Z')})
        ''',
        space=SPACE, agent_id=agent_id, key=key,
        node_id=stable_uuid(settings.provider_id, SPACE, 'project-agent', agent_id),
        profile_json=json.dumps({'name': '开发', 'display_name': display_name,
                                 'responsibility': 'Synthetic work.'}, ensure_ascii=False),
    )


@pytest.mark.asyncio
async def test_a_settled_name_avoids_every_name_in_the_space_not_only_the_shared_ones(graph):
    """Another FLA, sharing nothing, is called exactly what the list would
    first give: the list gives another name and the apply goes through."""
    settings, driver = graph
    await _seed(settings, driver, [_agent('sky-a', 'Sky Cole', work=2), _agent('sky-b', 'Sky Cole')])
    async with provider_client(settings, ACCESS_TOKEN) as (client, _):
        params = {'personal_space_id': SPACE}
        first = _renames((await client.get('/v1/project-agent-name-fixes', params=params)).json())['sky-b']
        await _add_agent(driver, settings, 'bystander', first, key=identity_key(first))

        plan = (await client.get('/v1/project-agent-name-fixes', params=params)).json()
        renames = _renames(plan)
        assert identity_key(renames['sky-b']) != identity_key(first) and is_generated_nickname(renames['sky-b'])
        applied = await client.post('/v1/project-agent-name-fixes/apply', json={
            **params, 'keep': [], 'renames': renames})
        assert applied.status_code == 200, applied.text
        assert applied.json()['groups'] == []

    names = await _names(driver)
    assert names['sky-b']['name'] == renames['sky-b'] and names['bystander']['name'] == first
    shown = [identity_key(item['name']) for item in names.values()]
    assert len(shown) == len(set(shown)), shown


@pytest.mark.asyncio
async def test_a_name_key_an_older_fuli_left_on_a_renamed_fla_never_blocks_that_name(graph):
    """FULI 22 renamed an FLA without updating its key. The Provider clears
    such a key when it starts; one that appears later is cleared when it blocks
    a rename or a new FLA. Only the key changes, never a name."""
    settings, driver = graph
    await _seed(settings, driver, [_agent('nova', 'Nova Reed')])
    await _add_agent(driver, settings, 'renamed-in-22', 'Wren Hill', key='morgan vale')
    async with provider_client(settings, ACCESS_TOKEN) as (client, _):
        assert (await client.get('/health')).json()['data_format']['state'] == 'current'
        assert (await _names(driver))['renamed-in-22'] == {'name': 'Wren Hill', 'history': [], 'key': None}

        await driver.execute_query(
            "MATCH (a:FuliProjectAgent {agent_id: 'renamed-in-22'}) "
            "SET a.display_name_space_id = $space, a.display_name_key = 'morgan vale'", space=SPACE)
        renamed = await client.put('/v1/project-agents/nova/name', json={
            'personal_space_id': SPACE, 'display_name': 'Morgan Vale'})
        assert renamed.status_code == 200, renamed.text

        await driver.execute_query(
            "MATCH (a:FuliProjectAgent {agent_id: 'renamed-in-22'}) "
            "SET a.display_name_space_id = $space, a.display_name_key = 'quinn shaw'", space=SPACE)
        hired = await client.put('/v1/project-agents', json=_profile('quinn', 'Quinn Shaw', 'Synthetic work.'))
        assert hired.status_code == 200, hired.text

    names = await _names(driver)
    assert (names['nova']['key'], names['quinn']['key']) == ('morgan vale', 'quinn shaw')
    assert names['renamed-in-22'] == {'name': 'Wren Hill', 'history': [], 'key': None}
