"""The graph format check against a disposable loopback Neo4j (rec#17 D-09).

These tests own the whole graph: the format version, the ledger and the
schema are global, so each test starts from an empty database and leaves one
behind. They run only when the launcher also sets FULI_TEST_NEO4J_RESETTABLE=1
on top of the disposable-graph flags; every graph here is synthetic.
"""

import os

import pytest
from neo4j import AsyncGraphDatabase

from fuli_graph.auth import token_hash
from fuli_graph.graph_format_migrations import GRAPH_FORMAT_VERSION, GRAPH_MIGRATIONS
from test_project_agent_memory_neo4j import fixture_settings, provider_client, seed_agent
from test_system_hr_identity_neo4j import _create_space

ACCESS_TOKEN = 'synthetic-format-access-token'
ALL_RULES = [rule for migration in GRAPH_MIGRATIONS for rule in migration.rules]


@pytest.fixture
async def graph():
    settings = fixture_settings()
    if os.getenv('FULI_TEST_NEO4J_RESETTABLE') != '1':
        pytest.skip('requires FULI_TEST_NEO4J_RESETTABLE=1: these tests empty the graph')
    driver = AsyncGraphDatabase.driver(
        settings.neo4j_uri, auth=('neo4j', settings.neo4j_password)
    )
    await _reset(driver)
    try:
        yield settings, driver
    finally:
        await _reset(driver)
        await driver.close()


async def _reset(driver):
    await driver.execute_query('MATCH (n) DETACH DELETE n')
    for record in await _rows(driver, 'SHOW CONSTRAINTS YIELD name'):
        await driver.execute_query(f'DROP CONSTRAINT {record["name"]} IF EXISTS')
    # Neo4j's own label and type lookup indexes stay.
    for record in await _rows(driver, "SHOW INDEXES YIELD name, type WHERE type <> 'LOOKUP'"):
        await driver.execute_query(f'DROP INDEX {record["name"]} IF EXISTS')


async def _rows(driver, query, **parameters):
    records, _, _ = await driver.execute_query(query, **parameters)
    return [dict(record) for record in records]


async def _schema_names(driver):
    """The declared rules that exist now."""
    names = set()
    for query in ('SHOW CONSTRAINTS YIELD name', 'SHOW INDEXES YIELD name'):
        names.update(row['name'] for row in await _rows(driver, query))
    return names & {rule.name for rule in ALL_RULES}


async def _events(driver):
    return await _rows(driver, '''
        MATCH (:FuliDataFormat {store: 'graph'})-[:HAS_FORMAT_EVENT]->(event)
        RETURN event.migration_id AS id, event.status AS status, event.detail AS detail
        ORDER BY event.seq
    ''')


async def _version(driver):
    rows = await _rows(driver, "MATCH (f:FuliDataFormat {store: 'graph'}) RETURN f.version AS v")
    return rows[0]['v'] if rows else None


async def _seed_legacy_principal(driver):
    """A principal written by a FULI version without the format registry."""
    await driver.execute_query(
        '''
        CREATE (p:FuliPrincipal {id: 'legacy-principal', name: 'Synthetic legacy owner',
                                 token_hash: $token_hash, active: true, provider_admin: true})
        CREATE (p)-[:OWNS]->(:FuliSpace {id: 'legacy-space', kind: 'personal',
                                         name: 'Synthetic legacy space', visibility: 'private',
                                         group_id: 'legacy-personal-legacy-space',
                                         created_at: datetime('2026-01-01T00:00:00Z')})
        ''',
        token_hash=token_hash(ACCESS_TOKEN),
    )


async def _create_rules(driver, migration_ids):
    for migration in GRAPH_MIGRATIONS:
        if migration.id in migration_ids:
            for rule in migration.rules:
                await driver.execute_query(rule.cypher)


@pytest.mark.asyncio
async def test_fresh_graph_is_created_at_the_current_version_and_writable(graph):
    settings, driver = graph
    async with provider_client(settings) as (client, _):
        health = (await client.get('/health')).json()['data_format']
        space = await _create_space(client, 'Synthetic fresh graph')

    assert health['access'] == 'write' and health['state'] == 'current'
    assert health['version'] == GRAPH_FORMAT_VERSION
    assert await _version(driver) == GRAPH_FORMAT_VERSION
    assert [event['status'] for event in await _events(driver)] == ['created']
    assert await _schema_names(driver) == {rule.name for rule in ALL_RULES}
    assert space


@pytest.mark.asyncio
async def test_unversioned_graph_detects_its_baseline_without_changing_records(graph):
    settings, driver = graph
    await _seed_legacy_principal(driver)
    # An earlier FULI created every rule but graph/3's lookup indexes.
    await _create_rules(driver, {'graph/1-baseline-schema'})
    snapshot = "MATCH (n) WHERE n.id STARTS WITH 'legacy-' RETURN n.id AS id, properties(n) AS p"
    before = {row['id']: row['p'] for row in await _rows(driver, snapshot)}

    async with provider_client(settings, ACCESS_TOKEN) as (client, _):
        health = (await client.get('/health')).json()['data_format']
        spaces = await client.get('/v1/spaces')

    assert health['state'] == 'current' and health['access'] == 'write'
    assert spaces.status_code == 200, spaces.text
    events = {event['id']: event['status'] for event in await _events(driver)}
    assert events['graph/1-baseline-schema'] == 'baseline_detected'
    assert events['graph/3-control-plane-schema'] == 'applied'
    for migration in GRAPH_MIGRATIONS:
        if not migration.automatic:
            assert events[migration.id] == 'baseline_detected', migration.id
    applied = next(e for e in await _events(driver) if e['id'] == 'graph/3-control-plane-schema')
    assert 'no in-process backup' in applied['detail']
    # No stored value was rewritten; the space defaults FULI always ensures
    # (system Agents, their numbering) may only add to the space.
    after = {row['id']: row['p'] for row in await _rows(driver, snapshot)}
    assert after.keys() == before.keys()
    for node_id, properties in before.items():
        assert {key: after[node_id].get(key) for key in properties} == properties


@pytest.mark.asyncio
async def test_records_that_still_need_a_step_wait_for_a_person_and_keep_the_graph_read_only(graph):
    settings, driver = graph
    await _seed_legacy_principal(driver)
    await driver.execute_query(
        "MATCH (s:FuliSpace {id: 'legacy-space'}) SET s.group_id = 'legacy:personal:legacy-space'"
    )

    async with provider_client(settings, ACCESS_TOKEN) as (client, _):
        health = (await client.get('/health')).json()['data_format']
        read = await client.get('/v1/spaces')
        write = await client.post('/v1/spaces', json={'name': 'Refused', 'kind': 'personal'})

    assert health['state'] == 'pending_confirmation' and health['access'] == 'read'
    assert health['pending'] == ['graph/9-group-id-separators']
    assert read.status_code == 200, read.text
    assert write.status_code == 503
    assert write.json()['detail']['code'] == 'data_format_read_only'
    assert 'graph/9-group-id-separators' in write.json()['detail']['message']
    assert await _version(driver) == 8
    assert (await _events(driver))[-1]['status'] == 'pending_confirmation'
    rows = await _rows(driver, "MATCH (s:FuliSpace) RETURN s.group_id AS group_id")
    assert rows == [{'group_id': 'legacy:personal:legacy-space'}]


@pytest.mark.asyncio
async def test_a_unique_constraint_that_existing_records_violate_is_not_created(graph):
    settings, driver = graph
    await _seed_legacy_principal(driver)
    await _create_rules(driver, {'graph/1-baseline-schema'})
    await driver.execute_query(
        "CREATE (:FuliProjectAgentTask {id: 'duplicate-task'}), "
        "(:FuliProjectAgentTask {id: 'duplicate-task'})"
    )

    async with provider_client(settings, ACCESS_TOKEN) as (client, _):
        health = (await client.get('/health')).json()['data_format']

    assert health['state'] == 'pending_confirmation'
    assert health['pending'] == ['graph/3-control-plane-schema']
    assert 'fuli_project_agent_task_id (1 duplicate values)' in health['message']
    assert 'fuli_project_agent_task_id' not in await _schema_names(driver)
    assert await _version(driver) == 2


@pytest.mark.asyncio
async def test_a_newer_graph_is_refused_before_any_schema_change_or_write(graph):
    settings, driver = graph
    await _seed_legacy_principal(driver)
    await driver.execute_query(
        "MERGE (f:FuliDataFormat {store: 'graph'}) SET f.version = $version",
        version=GRAPH_FORMAT_VERSION + 1,
    )

    async with provider_client(settings, ACCESS_TOKEN) as (client, _):
        health = (await client.get('/health')).json()
        read = await client.get('/v1/spaces')

    assert health['data_format']['state'] == 'newer'
    assert health['data_format']['access'] == 'none'
    assert read.status_code == 503
    assert read.json()['detail']['code'] == 'data_format_blocked'
    assert 'Upgrade FULI' in read.json()['detail']['message']
    assert await _schema_names(driver) == set()
    assert await _events(driver) == []
    assert await _version(driver) == GRAPH_FORMAT_VERSION + 1


async def _seed_started(driver, migration_id, version):
    await driver.execute_query(
        '''
        MERGE (f:FuliDataFormat {store: 'graph'})
        SET f.version = $version, f.event_count = 1
        CREATE (f)-[:HAS_FORMAT_EVENT]->(:FuliDataFormatEvent {
          store: 'graph', seq: 1, migration_id: $migration_id, status: 'started'})
        ''',
        migration_id=migration_id,
        version=version,
    )


@pytest.mark.asyncio
async def test_an_interrupted_schema_step_runs_again(graph):
    settings, driver = graph
    await _seed_legacy_principal(driver)
    await _create_rules(driver, {'graph/1-baseline-schema'})
    await _seed_started(driver, 'graph/3-control-plane-schema', 2)

    async with provider_client(settings, ACCESS_TOKEN) as (client, _):
        health = (await client.get('/health')).json()['data_format']

    assert health['state'] == 'current'
    statuses = [e['status'] for e in await _events(driver) if e['id'] == 'graph/3-control-plane-schema']
    assert statuses == ['started', 'started', 'applied']


@pytest.mark.asyncio
async def test_a_half_applied_record_step_blocks_writes_until_resolved(graph):
    settings, driver = graph
    await _seed_legacy_principal(driver)
    await _seed_started(driver, 'graph/9-group-id-separators', 8)

    async with provider_client(settings, ACCESS_TOKEN) as (client, _):
        health = (await client.get('/health')).json()['data_format']
        read = await client.get('/v1/spaces')
        write = await client.post('/v1/spaces', json={'name': 'Refused', 'kind': 'personal'})

    assert health['state'] == 'interrupted' and health['access'] == 'read'
    assert read.status_code == 200
    assert write.status_code == 503
    assert write.json()['detail']['code'] == 'data_format_read_only'
    assert await _schema_names(driver) == set()


@pytest.mark.asyncio
async def test_current_write_paths_leave_nothing_for_a_record_step(graph):
    """Records written today must never need a legacy step again; otherwise a
    later restart would wrongly ask a person to confirm it."""
    settings, driver = graph
    async with provider_client(settings) as (client, _):
        space = await _create_space(client, 'Synthetic current writes')
        await seed_agent(client, space)
        commit = await client.post('/v1/knowledge/commits', json={
            'space_id': space,
            'personal_project_id': 'sample-project',
            'episode': {
                'idempotency_key': 'format-drift-episode',
                'session_id': 'format-drift-session',
                'name': 'Synthetic format drift evidence',
                'source_kind': 'conversation',
                'source_description': 'Synthetic evidence for the format drift check.',
                'source_application': 'codex',
                'reference_time': '2026-10-21T00:00:00Z',
                'summary': 'Synthetic knowledge written by the current code.',
                'entities': [
                    {'key': 'format-drift-a', 'name': 'Synthetic fact A', 'type': 'Fact',
                     'summary': 'A synthetic fact.'},
                    {'key': 'format-drift-b', 'name': 'Synthetic fact B', 'type': 'Fact',
                     'summary': 'Another synthetic fact.'},
                ],
                'relationships': [{
                    'key': 'format-drift-ab', 'source': 'format-drift-a',
                    'target': 'format-drift-b', 'type': 'SUPPORTS',
                    'fact': 'Synthetic fact A relates to synthetic fact B.',
                }],
            },
        })
        assert commit.status_code == 200, commit.text

    maintenance = _Maintenance(driver)
    for migration in GRAPH_MIGRATIONS:
        if not migration.automatic:
            assert await migration.pending(maintenance, settings) == 0, migration.id


class _Maintenance:
    def __init__(self, driver):
        self.driver = driver

    async def execute_query(self, query, **parameters):
        records, summary, keys = await self.driver.execute_query(query, **parameters)
        return records, summary, keys
