"""graph/23 and graph/24 against a disposable loopback Neo4j: Agents of a space
that share a name, shaped like a long-used space (a name three Agents share,
one shared with a dismissed Agent, one shared by two without any work, one
across two projects, one a person chose in a rename, one an FLA shares with a
built-in role). One confirmation renames every Agent that gives way, keeps
the old name in its history, and can be undone; then the graph itself
refuses a second Agent with a name. Every name and record is synthetic; like
test_graph_format_neo4j.py these tests empty the database and run only with
FULI_TEST_NEO4J_RESETTABLE=1.
"""
import asyncio
import json

import pytest

from fuli_graph.name_identity import identity_key
from fuli_graph.project_agent_names import FIRST_NAMES, LAST_NAMES
from test_graph_format_confirm_neo4j import REVIEW, _reviewed
from test_graph_format_neo4j import (  # noqa: F401 - graph is a fixture
    ACCESS_TOKEN,
    _rows,
    _seed_legacy_principal,
    _version,
    graph,
)
from test_project_agent_memory_neo4j import provider_client

STEP = 'graph/23-unique-agent-names'
SPACE = 'legacy-space'


def _agent(agent_id, display_name, *, status='active', test_source=None, work=0, last_turn=None,
           created='2026-10-01T00:00:00Z', history=None, project='p-saturn'):
    """One Agent as FULI 22 stored it, with `work` tasks and turns of its own."""
    profile = {'name': '开发', 'display_name': display_name, 'responsibility': 'Synthetic work.',
               'status': status, **({'test_source': test_source} if test_source else {})}
    return {'agent_id': agent_id, 'profile_json': json.dumps(profile, ensure_ascii=False), 'status': status,
            'test_source': test_source, 'created_at': created, 'work': work, 'last_turn': last_turn,
            'history': json.dumps(history) if history else None, 'project': project}


PERSON_RENAME = [{'name': 'Robin Gray', 'until': '2026-11-01T00:00:00+00:00', 'reason': 'renamed'}]
AGENTS = [
    # Three share a name: the one with the most work keeps it; a test Agent gives way first.
    _agent('emery-a', 'Emery Fox', work=3, last_turn='2026-11-20T00:00:00Z'),
    _agent('emery-b', 'Emery Fox', work=1, last_turn='2026-11-21T00:00:00Z', project='p-backup'),
    _agent('emery-c', 'Emery Fox', test_source='synthetic-suite', work=5),
    # Shared with a dismissed Agent, however much it worked.
    _agent('blair-a', 'Blair Lake'),
    _agent('blair-b', 'Blair Lake', status='archived', work=9),
    # Two without any work: the one hired first keeps it.
    _agent('casey-a', 'Casey Hayes', created='2026-10-01T00:00:00Z'),
    _agent('casey-b', 'Casey Hayes', created='2026-10-02T00:00:00Z'),
    # Two projects, as much work each: the one active more recently keeps it.
    _agent('morgan-a', 'Morgan Vale', work=1, last_turn='2026-11-22T00:00:00Z'),
    _agent('morgan-b', 'Morgan Vale', work=1, last_turn='2026-11-02T00:00:00Z', project='p-backup'),
    # A name a person gave in a rename wins over more work.
    _agent('lyra-a', 'Lyra Lane', history=PERSON_RENAME),
    _agent('lyra-b', 'Lyra Lane', work=4, last_turn='2026-11-22T00:00:00Z'),
    # A built-in role's name stays the role's.
    _agent('bole-fla', 'Bole', work=2),
    _agent('nova', 'Nova Reed', work=1),
]
GIVING_WAY = {'emery-b': ('emery-a', 'less_work'), 'emery-c': ('emery-a', 'test'),
              'blair-b': ('blair-a', 'dismissed'), 'casey-b': ('casey-a', 'later'),
              'morgan-b': ('morgan-a', 'less_recent'), 'lyra-b': ('lyra-a', 'person_named'),
              'bole-fla': ('employee.bole', 'built_in_role')}


async def _seed(driver, agents=AGENTS):
    await _seed_legacy_principal(driver)
    await driver.execute_query(
        '''
        MATCH (space:FuliSpace {id: $space})
        CREATE (space)-[:CONTAINS_PROJECT]->(:FuliPersonalProject {id: 'p-saturn', project_id: 'p-saturn',
                                                                   name: 'Saturn'})
        CREATE (space)-[:CONTAINS_PROJECT]->(:FuliPersonalProject {id: 'p-backup', project_id: 'p-backup',
                                                                   name: 'Station Backup'})
        CREATE (space)-[:HAS_PROJECT_AGENT_IDENTITY]->(:FuliProjectAgent {id: 'node-bole',
                 agent_id: 'employee.bole', name: 'Bole', status: 'active', agent_type: 'hr',
                 profile_json: '{"name":"Bole","responsibility":"Synthetic hiring."}',
                 created_at: datetime('2026-09-01T00:00:00Z'), updated_at: datetime('2026-09-01T00:00:00Z')})
        CREATE (space)-[:HAS_TASK_CONTEXT_SESSION]->(:FuliTaskContextSession {id: 'session'})
        WITH space
        UNWIND $agents AS row
        MATCH (project:FuliPersonalProject {project_id: row.project})
        CREATE (space)-[:HAS_PROJECT_AGENT_IDENTITY]->(agent:FuliProjectAgent {id: 'node-' + row.agent_id,
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
        WITH space, row
        MATCH (space)-[:HAS_TASK_CONTEXT_SESSION]->(session)
        FOREACH (_ IN CASE WHEN row.last_turn IS NULL THEN [] ELSE [1] END |
          CREATE (session)-[:HAS_CONTEXT]->(:FuliTaskContext {id: row.agent_id + '-turn',
                   project_agent_id: row.agent_id, created_at: datetime(row.last_turn)}))
        ''',
        space=SPACE, agents=agents,
    )
    await driver.execute_query("MERGE (f:FuliDataFormat {store: 'graph'}) SET f.version = 22")


async def _names(driver):
    rows = await _rows(driver, '''
        MATCH (a:FuliProjectAgent) RETURN a.agent_id AS agent_id, a.profile_json AS profile,
               a.name_history_json AS history, a.display_name_key AS key''')
    return {row['agent_id']: {'name': json.loads(row['profile']).get('display_name') or json.loads(row['profile'])['name'],
                              'history': json.loads(row['history'] or '[]'), 'key': row['key']} for row in rows}


def _generated(name):
    first, _, last = name.partition(' ')
    return first in FIRST_NAMES and all(part in LAST_NAMES for part in last.split('-'))


@pytest.mark.asyncio
async def test_one_confirmation_renames_every_agent_that_gives_way_and_can_be_undone(graph):
    settings, driver = graph
    await _seed(driver)
    before = await _names(driver)

    async with provider_client(_reviewed(settings), ACCESS_TOKEN) as (client, _):
        health = (await client.get('/health')).json()['data_format']
        assert health['pending'] == [STEP] and health['access'] == 'read'
        plan = (await client.post('/v1/data-format/preview')).json()['plan']
        assert plan['step']['id'] == STEP and plan['undo'] == 'available'
        assert plan['step']['count'] == len(GIVING_WAY)
        assert 'Emery' not in json.dumps(plan), 'the preview names records by ID only'
        applied = await client.post('/v1/data-format/apply', headers=REVIEW,
                                    json={'digest': plan['digest'], 'entrypoint': 'http'})
        assert applied.status_code == 200, applied.text
        # graph/24 follows by itself: the graph is current and writable.
        assert applied.json()['data_format']['state'] == 'current'

        after = await _names(driver)
        for agent_id, (kept_by, rule) in GIVING_WAY.items():
            renamed = after[agent_id]
            assert _generated(renamed['name']) and renamed['key'] == identity_key(renamed['name']), agent_id
            change = renamed['history'][-1]
            assert (change['name'], change['reason'], change['kept_by_agent_id'], change['gave_way']) == (
                before[agent_id]['name'], 'duplicate_name', kept_by, rule), agent_id
        for agent_id in {*before} - {*GIVING_WAY}:
            assert after[agent_id]['name'] == before[agent_id]['name'], agent_id
        shown = [identity_key(item['name']) for item in after.values()]
        assert len(shown) == len(set(shown)), 'every Agent has a name of its own'
        # The renamed record says 「原名」 for a while; its identity and work stay.
        record = (await client.get('/v1/project-agents/morgan-b', params={'personal_space_id': SPACE})).json()
        assert record['agent_id'] == 'morgan-b' and record['former_name'] == 'Morgan Vale'
        assert record['name_history'][-1]['gave_way'] == 'less_recent'
        assert (await client.get('/v1/project-agents/morgan-a', params={'personal_space_id': SPACE})
                ).json()['former_name'] is None

        # One place lists every rename, newest first, with who kept the name and why.
        listed = (await client.get('/v1/project-agent-name-changes', params={'personal_space_id': SPACE})).json()
        assert {item['agent_id']: (item['change']['name'], item['kept_by_name'], item['change']['gave_way'])
                for item in listed} == {agent_id: (before[agent_id]['name'], before[kept_by]['name']
                                                   if kept_by in before else 'Bole', rule)
                                        for agent_id, (kept_by, rule) in GIVING_WAY.items()}
        assert all(item['display_name'] == after[item['agent_id']]['name'] for item in listed)

        undone = await client.post('/v1/data-format/rollback', headers=REVIEW,
                                   json={'migration_id': STEP, 'entrypoint': 'http'})
        assert undone.status_code == 200, undone.text

    # FULI's own roles a writable provider adds meanwhile stay; everything else is as before.
    restored = await _names(driver)
    assert {agent_id: restored[agent_id] for agent_id in before} == before
    assert await _version(driver) == 22


@pytest.mark.asyncio
async def test_a_space_without_shared_names_needs_no_confirmation(graph):
    settings, driver = graph
    await _seed(driver, [_agent('nova', 'Nova Reed'), _agent('iris', 'Iris Vale')])
    async with provider_client(_reviewed(settings), ACCESS_TOKEN) as (client, _):
        assert (await client.get('/health')).json()['data_format']['state'] == 'current'
    assert await _version(driver) == 24


@pytest.mark.asyncio
async def test_after_the_step_two_agents_racing_for_one_name_cannot_both_have_it(graph):
    settings, driver = graph
    await _seed(driver, [_agent('nova', 'Nova Reed')])
    async with provider_client(_reviewed(settings), ACCESS_TOKEN) as (client, _):
        assert (await client.get('/health')).json()['data_format']['state'] == 'current'

        def hire(agent_id):
            return client.put('/v1/project-agents', json={
                'personal_space_id': SPACE, 'agent_id': agent_id,
                'occupation': {'role': 'engineering'},
                'profile': {'name': '开发', 'display_name': 'Quinn Shaw', 'responsibility': 'Synthetic work.'}})

        answers = await asyncio.gather(*(hire(f'racer-{index}') for index in range(4)))
        assert sorted(answer.status_code for answer in answers) == [200, 409, 409, 409], [a.text for a in answers]
        refused = next(answer for answer in answers if answer.status_code == 409).json()['detail']
        assert 'agent_name_taken' in refused
        # Renaming another Agent to it is refused with who has it.
        rename = await client.put('/v1/project-agents/nova/name', json={
            'personal_space_id': SPACE, 'display_name': 'quinn  SHAW'})
        assert rename.status_code == 409 and 'used by: Quinn Shaw (racer-' in rename.json()['detail']

    keys = await _rows(driver, '''MATCH (a:FuliProjectAgent) WHERE a.display_name_key = 'quinn shaw'
                                  RETURN count(a) AS count''')
    assert keys == [{'count': 1}]
