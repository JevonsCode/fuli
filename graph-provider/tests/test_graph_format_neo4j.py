"""The graph format check against a disposable loopback Neo4j (rec#17 D-09).

These tests own the whole graph: the format version, the ledger and the
schema are global, so each test starts from an empty database and leaves one
behind. They run only when the launcher also sets FULI_TEST_NEO4J_RESETTABLE=1
on top of the disposable-graph flags; every graph here is synthetic.
"""

import os
from datetime import timedelta

import httpx
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


async def _graph_bytes(driver):
    """Everything a format report could change: schema, ledger, nodes, edges."""
    schema = await _rows(driver, 'SHOW CONSTRAINTS YIELD name RETURN name ORDER BY name')
    indexes = await _rows(driver, 'SHOW INDEXES YIELD name RETURN name ORDER BY name')
    nodes = await _rows(driver, '''
        MATCH (n) RETURN labels(n) AS labels, properties(n) AS properties
        ORDER BY elementId(n)
    ''')
    edges = await _rows(driver, 'MATCH ()-[r]->() RETURN type(r) AS type, count(*) AS n ORDER BY type')
    return repr((schema, indexes, nodes, edges))


async def _report(settings):
    from fuli_graph.app import create_app

    # No lifespan: the report needs no format check and must not run one.
    app = create_app(settings)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url='http://fixture'
    ) as client:
        response = await client.get('/health/data-format')
    assert response.status_code == 200, response.text
    return response.json()


@pytest.mark.asyncio
async def test_the_format_report_reads_an_unversioned_graph_without_changing_it(graph):
    settings, driver = graph
    await _seed_legacy_principal(driver)
    await _create_rules(driver, {'graph/1-baseline-schema'})
    await driver.execute_query(
        "MATCH (s:FuliSpace {id: 'legacy-space'}) SET s.group_id = 'legacy:personal:legacy-space'"
    )
    before = await _graph_bytes(driver)

    report = await _report(settings)

    assert await _graph_bytes(driver) == before
    assert report['state'] == 'pending_confirmation' and report['version'] is None
    steps = {step['id']: step['state'] for step in report['steps']}
    assert steps['graph/1-baseline-schema'] == 'detected'
    assert steps['graph/3-control-plane-schema'] == 'automatic'
    assert steps['graph/9-group-id-separators'] == 'pending_confirmation'
    assert report['ledger'] == []


@pytest.mark.asyncio
async def test_the_format_report_names_newer_and_half_applied_graphs_without_changing_them(graph):
    settings, driver = graph
    await _seed_legacy_principal(driver)
    await _seed_started(driver, 'graph/9-group-id-separators', 8)
    before = await _graph_bytes(driver)
    half = await _report(settings)
    assert await _graph_bytes(driver) == before
    assert half['state'] == 'half_applied'
    assert half['steps'] == [{'id': 'graph/9-group-id-separators', 'state': 'half_applied',
                              'detail': 'started and did not finish'}]
    assert [event['status'] for event in half['ledger']] == ['started']

    await driver.execute_query(
        "MATCH (f:FuliDataFormat {store: 'graph'}) SET f.version = $version",
        version=GRAPH_FORMAT_VERSION + 1,
    )
    before = await _graph_bytes(driver)
    newer = await _report(settings)
    assert await _graph_bytes(driver) == before
    assert newer['state'] == 'newer_format' and newer['version'] == GRAPH_FORMAT_VERSION + 1


@pytest.mark.asyncio
async def test_a_refused_write_names_the_store_and_steps(graph):
    settings, driver = graph
    await _seed_legacy_principal(driver)
    await _seed_started(driver, 'graph/9-group-id-separators', 8)

    async with provider_client(settings, ACCESS_TOKEN) as (client, _):
        health = (await client.get('/health')).json()['data_format']
        write = await client.post('/v1/spaces', json={'name': 'Refused', 'kind': 'personal'})

    assert health['store'] == 'graph' and health['pending'] == ['graph/9-group-id-separators']
    assert write.json()['detail']['store'] == 'graph'
    assert write.json()['detail']['steps'] == ['graph/9-group-id-separators']


@pytest.mark.asyncio
async def test_a_same_named_plain_index_never_passes_for_a_uniqueness_constraint(graph):
    settings, driver = graph
    await _seed_legacy_principal(driver)
    await _create_rules(driver, {'graph/1-baseline-schema'})
    await driver.execute_query(
        'CREATE INDEX fuli_project_agent_task_id IF NOT EXISTS FOR (n:FuliProjectAgentTask) ON (n.id)'
    )
    await driver.execute_query(
        "CREATE (:FuliProjectAgentTask {id: 'same'}), (:FuliProjectAgentTask {id: 'same'})"
    )

    report = await _report(settings)
    async with provider_client(settings, ACCESS_TOKEN) as (client, _):
        health = (await client.get('/health')).json()['data_format']

    step = next(s for s in report['steps'] if s['id'] == 'graph/3-control-plane-schema')
    assert step['state'] == 'pending_confirmation'
    assert 'schema mismatch: fuli_project_agent_task_id is a index RANGE' in step['detail']
    assert health['state'] == 'pending_confirmation'
    assert health['pending'] == ['graph/3-control-plane-schema']
    assert await _version(driver) == 2
    rows = await _rows(driver, "SHOW CONSTRAINTS YIELD name WHERE name = 'fuli_project_agent_task_id'")
    assert rows == []


@pytest.mark.asyncio
async def test_the_graph_version_only_moves_forward_and_only_under_the_lock(graph):
    from fuli_graph.graph_format_ledger import (
        GraphFormatLockLost,
        acquire_graph_migration_lock,
        ensure_graph_ledger_identity,
        stamp_graph_version,
    )
    from fuli_graph.provider_values import now_utc

    settings, driver = graph
    await ensure_graph_ledger_identity(driver)
    until = now_utc() + timedelta(seconds=60)
    assert await acquire_graph_migration_lock(driver, 'newer-start', until=until)
    assert not await acquire_graph_migration_lock(driver, 'older-start', until=until)
    await stamp_graph_version(driver, 99, owner='newer-start', now=now_utc, until=until)
    # An older start that read "unversioned" before cannot stamp at all
    # without the lock, nor lower the version while holding it.
    with pytest.raises(GraphFormatLockLost):
        await stamp_graph_version(driver, 1, owner='older-start', now=now_utc, until=until)
    with pytest.raises(GraphFormatLockLost):
        await stamp_graph_version(driver, 1, owner='newer-start', now=now_utc, until=until)
    assert await _version(driver) == 99
    rows = await _rows(driver, "MATCH (f:FuliDataFormat) RETURN count(f) AS n")
    assert rows == [{'n': 1}]


@pytest.mark.asyncio
async def test_a_start_waits_for_the_lock_and_reads_the_ledger_again_under_it(graph):
    import asyncio

    from fuli_graph.graph_format import prepare_graph_format
    from fuli_graph.graph_format_ledger import ensure_graph_ledger_identity
    from fuli_graph.runtime import GraphitiRuntime

    settings, driver = graph
    await _seed_legacy_principal(driver)
    await ensure_graph_ledger_identity(driver)
    # Another start holds the lock; this start reads "unversioned" first.
    await driver.execute_query(
        "MATCH (f:FuliDataFormat {store: 'graph'}) "
        "SET f.lock_owner = 'other-start', f.lock_until = datetime() + duration('PT60S')"
    )
    runtime = GraphitiRuntime(settings)
    try:
        waiting = asyncio.create_task(prepare_graph_format(
            runtime.driver.maintenance(), settings, lock_wait_seconds=20,
            sleep=lambda _: asyncio.sleep(0.2),
        ))
        await asyncio.sleep(1)
        assert not waiting.done()
        # The other start moves the graph to a newer format and lets go.
        await driver.execute_query(
            "MATCH (f:FuliDataFormat {store: 'graph'}) "
            "SET f.version = $version REMOVE f.lock_owner, f.lock_until",
            version=GRAPH_FORMAT_VERSION + 1,
        )
        state = await waiting
    finally:
        await runtime.close()

    assert state.state == 'newer' and state.access == 'none'
    assert await _version(driver) == GRAPH_FORMAT_VERSION + 1
    assert await _schema_names(driver) == set()
    assert await _events(driver) == []
    rows = await _rows(driver, "MATCH (f:FuliDataFormat) RETURN f.lock_owner AS owner")
    assert rows == [{'owner': None}]


BLOCKED_WAIT_SECONDS = 20


async def _until_blocked_on_a_lock(driver, racing):
    """Wait until Neo4j lists a transaction blocked on a lock, never by time
    alone; fail if the racing transaction finishes first or none blocks."""
    import asyncio

    loop = asyncio.get_running_loop()
    deadline = loop.time() + BLOCKED_WAIT_SECONDS
    while loop.time() < deadline:
        assert not racing.done(), 'the second transaction finished without waiting for the lock'
        rows = await _rows(driver, '''
            SHOW TRANSACTIONS YIELD status, currentQuery
            WHERE status STARTS WITH 'Blocked' AND currentQuery CONTAINS '_format_lock'
            RETURN count(*) AS blocked
        ''')
        if rows and rows[0]['blocked']:
            return
        await asyncio.sleep(0.05)
    raise AssertionError('no transaction was blocked on the ledger lock')


class _InTransaction:
    """Runs ledger queries inside one open transaction, to hold its locks."""

    def __init__(self, transaction):
        self.transaction = transaction

    async def execute_query(self, query, **parameters):
        parameters.pop('routing_', None)
        result = await self.transaction.run(query, **parameters)
        return [record async for record in result], None, None


@pytest.mark.asyncio
async def test_two_starts_racing_for_a_free_lock_only_one_takes_it(graph):
    import asyncio

    from fuli_graph.graph_format_ledger import (
        acquire_graph_migration_lock,
        ensure_graph_ledger_identity,
    )
    from fuli_graph.provider_values import now_utc

    settings, driver = graph
    await ensure_graph_ledger_identity(driver)
    until = now_utc() + timedelta(seconds=60)
    async with driver.session() as first_session, driver.session() as second_session:
        first = await first_session.begin_transaction()
        second = await second_session.begin_transaction()
        try:
            took_first = await acquire_graph_migration_lock(_InTransaction(first), 'start-a', until=until)
            racing = asyncio.create_task(
                acquire_graph_migration_lock(_InTransaction(second), 'start-b', until=until)
            )
            # Barrier: the second start waits on the identity node's write lock
            # before it reads who holds the lease, as Neo4j itself reports.
            await _until_blocked_on_a_lock(driver, racing)
            await first.commit()
            took_second = await racing
            await second.commit()
        finally:
            for transaction in (first, second):
                if not transaction.closed():
                    await transaction.rollback()

    assert (took_first, took_second) == (True, False)
    rows = await _rows(driver, "MATCH (f:FuliDataFormat {store: 'graph'}) RETURN f.lock_owner AS owner")
    assert rows == [{'owner': 'start-a'}]


@pytest.mark.asyncio
async def test_racing_stamps_never_move_the_version_back(graph):
    import asyncio

    from fuli_graph.graph_format_ledger import (
        GraphFormatLockLost,
        acquire_graph_migration_lock,
        ensure_graph_ledger_identity,
        stamp_graph_version,
    )
    from fuli_graph.provider_values import now_utc

    settings, driver = graph
    await ensure_graph_ledger_identity(driver)
    until = now_utc() + timedelta(seconds=60)
    assert await acquire_graph_migration_lock(driver, 'start-a', until=until)
    await stamp_graph_version(driver, 5, owner='start-a', now=now_utc, until=until)
    async with driver.session() as first_session, driver.session() as second_session:
        first = await first_session.begin_transaction()
        second = await second_session.begin_transaction()
        try:
            await stamp_graph_version(_InTransaction(first), 7, owner='start-a', now=now_utc, until=until)
            racing = asyncio.create_task(stamp_graph_version(
                _InTransaction(second), 6, owner='start-a', now=now_utc, until=until
            ))
            await _until_blocked_on_a_lock(driver, racing)
            await first.commit()
            with pytest.raises(GraphFormatLockLost):
                await racing
        finally:
            for transaction in (first, second):
                if not transaction.closed():
                    await transaction.rollback()

    assert await _version(driver) == 7
