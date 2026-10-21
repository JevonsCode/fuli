"""The graph format registry without a database: its declarations, its
fingerprint, the record-changing steps' bodies and the driver's format guard.
Behavior against a real graph lives in test_graph_format_neo4j.py."""

import ast
import json
import os
import re
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from neo4j import READ_ACCESS, WRITE_ACCESS, RoutingControl
from neo4j.exceptions import Neo4jError

os.environ.setdefault('FULI_BOOTSTRAP_TOKEN', 'synthetic-bootstrap-token-1234')
os.environ.setdefault('FULI_NEO4J_PASSWORD', 'synthetic-password')

from fuli_graph.app import create_app
from fuli_graph.config import Settings
from fuli_graph.graph_format import GraphFormatState, GraphFormatUnavailable
from fuli_graph.graph_format_backfills import (
    apply_group_id_separators,
    apply_learning_bucket_ids,
)
from fuli_graph.graph_format_journal import CREATED_TAG
from fuli_graph.graph_format_ledger import LEDGER_LABELS
from fuli_graph.graph_format_migrations import GRAPH_FORMAT_VERSION, GRAPH_MIGRATIONS
from fuli_graph.graph_format_schema import schema_fingerprint
from fuli_graph.runtime import ManagedNeo4jDriver
from fuli_graph.store_project_agent_executor_learning import (
    project_agent_executor_outcome_bucket_id,
)

PACKAGE = Path(__file__).resolve().parents[1] / 'fuli_graph'
FINGERPRINTS = Path(__file__).with_name('graph_format_fingerprints.json')
# The declared schema, the ledger's own identity constraint, and the parser
# that reads declared statements back.
SCHEMA_OWNERS = {'graph_format_schema.py', 'graph_format_ledger.py', 'graph_schema_state.py'}
DDL = re.compile(r'\b(?:CREATE|DROP)\s+(?:FULLTEXT\s+|RANGE\s+|VECTOR\s+)?(?:CONSTRAINT|INDEX)\b')
LABEL = re.compile(r':(Fuli[A-Za-z]+)\b')


def provider_sources():
    return sorted(PACKAGE.glob('*.py'))


def test_versions_are_contiguous_and_only_schema_steps_are_automatic():
    assert [m.to_version for m in GRAPH_MIGRATIONS] == list(range(1, GRAPH_FORMAT_VERSION + 1))
    for migration in GRAPH_MIGRATIONS:
        assert migration.automatic == (migration.kind == 'schema'), migration.id
        if not migration.automatic:
            assert migration.pending and migration.apply, migration.id
            assert not migration.rules, migration.id


def test_learning_ids_are_unique_only_after_legacy_duplicates_are_collapsed():
    versions = {m.id: m.to_version for m in GRAPH_MIGRATIONS}
    constrained = next(
        m for m in GRAPH_MIGRATIONS
        if any(rule.name == 'fuli_project_agent_executor_outcome_aggregate_id' for rule in m.rules)
    )
    assert versions['graph/2-learning-bucket-ids'] < constrained.to_version
    assert any(
        rule.name == 'fuli_project_agent_executor_outcome_reset_id' for rule in constrained.rules
    )


def test_no_schema_statement_lives_outside_the_registry():
    offenders = [
        f'{path.name}: {match.group(0)}'
        for path in provider_sources() if path.name not in SCHEMA_OWNERS
        for match in DDL.finditer(path.read_text(encoding='utf-8'))
    ]
    assert offenders == [], 'Declare constraints and indexes in graph_format_schema.py'


def test_every_fuli_label_in_the_code_is_declared_by_a_migration():
    used = {
        label
        for path in provider_sources()
        for label in LABEL.findall(path.read_text(encoding='utf-8'))
    } - LEDGER_LABELS
    declared = set().union(*(m.labels for m in GRAPH_MIGRATIONS))
    assert sorted(used - declared) == [], (
        'A new label is a format change: declare it in a new graph migration'
    )
    assert sorted(declared - used) == []


def test_shipped_migration_declarations_never_change():
    expected = json.loads(FINGERPRINTS.read_text(encoding='utf-8'))
    actual = {m.id: schema_fingerprint(m.rules, m.labels) for m in GRAPH_MIGRATIONS}
    assert actual == expected, (
        'A shipped migration keeps its declaration. Add a migration with the next '
        'version for a schema or label change, then record only its new fingerprint '
        f'in {FINGERPRINTS.name}.'
    )


class GroupIdDriver:
    def __init__(self, records, fail_on_transaction_call=None):
        self.records = records
        self.fail_on_transaction_call = fail_on_transaction_call
        self.direct_calls = []
        self.transaction_calls = []
        self.committed = 0
        self.rolled_back = 0

    async def execute_query(self, query, **parameters):
        self.direct_calls.append((query, parameters))
        return self.records, None, None

    @asynccontextmanager
    async def transaction(self):
        try:
            yield self
        except BaseException:
            self.rolled_back += 1
            raise
        else:
            self.committed += 1

    async def run(self, query, **parameters):
        self.transaction_calls.append((query, parameters))
        if len(self.transaction_calls) == self.fail_on_transaction_call:
            raise RuntimeError('forced migration failure')


@pytest.mark.asyncio
async def test_group_id_step_renames_one_space_per_transaction():
    driver = GroupIdDriver([{'id': 'space-1', 'group_id': 'personal:space-1'}])

    await apply_group_id_separators(driver, None)

    assert driver.committed == 1 and driver.rolled_back == 0
    assert len(driver.transaction_calls) == 3
    assert driver.transaction_calls[0][1] == {'space_id': 'space-1', 'current': 'personal-space-1'}
    assert all(
        parameters == {'previous': 'personal:space-1', 'current': 'personal-space-1'}
        for _, parameters in driver.transaction_calls[1:]
    )


@pytest.mark.asyncio
async def test_group_id_step_rolls_back_a_space_when_one_update_fails():
    driver = GroupIdDriver(
        [{'id': 'space-1', 'group_id': 'personal:space-1'}], fail_on_transaction_call=2
    )

    with pytest.raises(RuntimeError, match='forced migration failure'):
        await apply_group_id_separators(driver, None)

    assert driver.committed == 0 and driver.rolled_back == 1


def learning_bucket(space_id, strategy_key):
    return {
        'personal_space_id': space_id,
        'personal_project_id': 'project-1',
        'work_kind': 'review',
        'agent_id': 'agent-1',
        'executor_id': 'executor-1',
        'model_strategy_key': strategy_key,
    }


class LearningDriver:
    def __init__(self, aggregate_buckets, reset_buckets):
        self.buckets = {'OutcomeAggregate': aggregate_buckets, 'OutcomeReset': reset_buckets}
        self.mutation_calls = []

    async def execute_query(self, query, **parameters):
        if 'collect(bucket.id) AS ids' in query:
            label = 'OutcomeAggregate' if 'OutcomeAggregate' in query else 'OutcomeReset'
            return self.buckets[label], None, None
        self.mutation_calls.append((query, parameters))
        return [{'removed_count': 1}], None, None


@pytest.mark.asyncio
async def test_learning_bucket_step_is_space_scoped_deterministic_and_keeps_evidence():
    strategy_key = 'a' * 64
    driver = LearningDriver(
        [learning_bucket('space-a', strategy_key), learning_bucket('space-b', strategy_key)],
        [learning_bucket('space-a', strategy_key)],
    )
    settings = SimpleNamespace(provider_id='provider-1')

    await apply_learning_bucket_ids(driver, settings)
    await apply_learning_bucket_ids(driver, settings)

    aggregate_calls = [call for call in driver.mutation_calls if 'OutcomeAggregate' in call[0]]
    reset_calls = [call for call in driver.mutation_calls if 'OutcomeReset' in call[0]]
    assert len(aggregate_calls) == 4 and len(reset_calls) == 2
    assert aggregate_calls[0][1]['bucket_id'] == aggregate_calls[2][1]['bucket_id']
    assert aggregate_calls[0][1]['bucket_id'] != aggregate_calls[1][1]['bucket_id']
    assert aggregate_calls[0][1]['bucket_id'] == project_agent_executor_outcome_bucket_id(
        'provider-1', 'space-a', 'project-1', 'review', 'agent-1', 'executor-1',
        strategy_key, bucket_kind='aggregate',
    )
    assert 'bucket.as_of' in aggregate_calls[0][0]
    assert 'bucket.reset_at' in reset_calls[0][0]
    assert 'DETACH DELETE duplicate' in aggregate_calls[0][0]
    assert 'OutcomeEvidence' not in ''.join(query for query, _ in driver.mutation_calls)


class RecordingClient:
    """Stands in for the Neo4j client under ManagedNeo4jDriver; the writer
    fence reads graph_version."""

    def __init__(self, error=None, graph_version=GRAPH_FORMAT_VERSION):
        self.error = error
        self.graph_version = graph_version
        self.queries = []
        self.sessions = []
        self.transaction_queries = []

    async def execute_query(self, query, **kwargs):
        self.queries.append((query, kwargs))
        if self.error:
            raise self.error
        return [], None, None

    def session(self, **kwargs):
        self.sessions.append(kwargs)
        return RecordingSession(self)


class RecordingSession:
    def __init__(self, client=None):
        self.client = client

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        return False

    async def begin_transaction(self):
        return RecordingTransaction(self.client)

    async def execute_write(self, work, *args, **kwargs):
        return await work(RecordingTransaction(self.client), *args, **kwargs)


class RecordingTransaction:
    def __init__(self, client):
        self.client = client

    async def run(self, query, *args, **kwargs):
        self.client.transaction_queries.append(query)
        rows = [{'version': self.client.graph_version}] if '_fuli_writer' in query else []
        return RecordingResult(rows)

    async def commit(self):
        return None

    async def rollback(self):
        return None


class RecordingResult:
    def __init__(self, rows):
        self.rows = rows

    def __aiter__(self):
        async def rows():
            for row in self.rows:
                yield row
        return rows()

    async def to_eager_result(self):
        return self.rows, None, []


async def _done():
    return None


def guarded_driver(state, client):
    driver = ManagedNeo4jDriver(uri='bolt://127.0.0.1:9', user='neo4j', password='synthetic')
    driver.client = client
    driver.format = state
    return driver


READ_ONLY = GraphFormatState('read', 'pending_confirmation', 4, 'synthetic read-only reason')
REFUSED = GraphFormatState('none', 'newer', 99, 'synthetic newer-format reason')


@pytest.mark.asyncio
async def test_unchecked_or_refused_graph_runs_nothing():
    client = RecordingClient()
    driver = guarded_driver(REFUSED, client)

    with pytest.raises(GraphFormatUnavailable) as refused:
        await driver.execute_query('MATCH (n) RETURN n', routing_='r')
    with pytest.raises(GraphFormatUnavailable):
        async with driver.transaction():
            pass
    with pytest.raises(GraphFormatUnavailable):
        driver.session()

    assert refused.value.code == 'data_format_blocked'
    assert refused.value.message == 'synthetic newer-format reason'
    assert client.queries == [] and client.sessions == []
    unchecked = ManagedNeo4jDriver(uri='bolt://127.0.0.1:9', user='neo4j', password='synthetic')
    unchecked.client = client
    with pytest.raises(GraphFormatUnavailable):
        await unchecked.execute_query('RETURN 1')


@pytest.mark.asyncio
async def test_read_only_graph_runs_every_query_in_read_access_mode():
    client = RecordingClient()
    driver = guarded_driver(READ_ONLY, client)

    await driver.execute_query('MATCH (n) SET n.touched = true')
    async with driver.transaction():
        pass
    driver.session()

    assert client.queries[0][1]['routing_'] == RoutingControl.READ
    assert [session['default_access_mode'] for session in client.sessions] == [
        READ_ACCESS, READ_ACCESS,
    ]


@pytest.mark.asyncio
async def test_a_write_neo4j_refuses_in_read_mode_answers_with_the_format_reason():
    refusal = Neo4jError._hydrate_neo4j(
        code='Neo.ClientError.Statement.AccessMode',
        message='Writing in read access mode not allowed',
    )
    driver = guarded_driver(READ_ONLY, RecordingClient(refusal))

    with pytest.raises(GraphFormatUnavailable) as refused:
        await driver.execute_query('CREATE (:Synthetic)')

    assert refused.value.code == 'data_format_read_only'
    assert refused.value.message == 'synthetic read-only reason'


@pytest.mark.asyncio
async def test_current_graph_writes_behind_the_writer_fence():
    client = RecordingClient()
    driver = guarded_driver(GraphFormatState('write', 'current', GRAPH_FORMAT_VERSION), client)

    await driver.execute_query('CREATE (:Synthetic)')
    async with driver.transaction():
        pass

    # The fence is the write transaction's last statement, before its commit.
    assert client.queries == []
    assert client.transaction_queries[0] == 'CREATE (:Synthetic)'
    assert '_fuli_writer' in client.transaction_queries[1]
    assert '_fuli_writer' in client.transaction_queries[2]
    # The dependency's own write transaction, which defaults to write access.
    assert all(session.get('default_access_mode', WRITE_ACCESS) == WRITE_ACCESS for session in client.sessions)


@pytest.mark.asyncio
async def test_a_provider_whose_graph_was_migrated_meanwhile_writes_nothing():
    client = RecordingClient(graph_version=GRAPH_FORMAT_VERSION - 1)
    driver = guarded_driver(GraphFormatState('write', 'current', GRAPH_FORMAT_VERSION), client)

    with pytest.raises(GraphFormatUnavailable) as refused:
        await driver.execute_query('CREATE (:Synthetic)')

    assert refused.value.code == 'data_format_changed_underneath'
    # The write ran in the transaction the fence then refuses to commit.
    assert client.transaction_queries[0] == 'CREATE (:Synthetic)'


@pytest.mark.asyncio
async def test_provider_routes_answer_503_with_the_format_reason_before_the_check():
    app = create_app(Settings(
        provider_id='format-guard', provider_mode='personal',
        bootstrap_token='format-guard-bootstrap-1234', neo4j_uri='bolt://127.0.0.1:9',
        neo4j_password='synthetic',
    ))
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url='http://fixture'
    ) as client:
        response = await client.get('/v1/spaces', headers={'Authorization': 'Bearer synthetic'})

    assert response.status_code == 503
    assert response.json()['detail']['code'] == 'data_format_blocked'
    assert response.json()['detail']['store'] == 'graph'
    assert 'not been checked' in response.json()['detail']['message']


@pytest.mark.asyncio
async def test_the_format_report_reads_in_read_access_mode_even_when_the_graph_is_refused():
    client = RecordingClient()
    driver = guarded_driver(REFUSED, client)

    await driver.read_only().execute_query('SHOW CONSTRAINTS YIELD name')

    assert client.queries[0][1]['routing_'] == RoutingControl.READ
    assert REFUSED.refusal().detail() == {'code': 'data_format_blocked',
                                          'message': 'synthetic newer-format reason',
                                          'store': 'graph', 'steps': []}


PROPERTY_FINGERPRINTS = Path(__file__).with_name('graph_property_fingerprints.json')
# A property name next to a record variable in Cypher text: n.name = …, or a
# key of a pattern's property map, (n:Label {name: …}).
CYPHER_PROPERTY = re.compile(r'\b[a-z_][A-Za-z0-9_]*\.([a-z][A-Za-z0-9_]*)\s*=(?!=)')
MAP_KEY = re.compile(r'[{,]\s*([a-z][A-Za-z0-9_]*)\s*:\s*[$\'"\w\[{(-]')


def _cypher_texts(source: str):
    """Every string literal of a module, f-string parts included."""
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            yield node.value


def test_a_new_graph_property_comes_with_the_next_graph_version():
    """Every property name the provider's Cypher reads or writes, by graph
    version. Readers coalesce a missing property, but an older guarded FULI
    ignores one it does not know, so a new stored property is a format change:
    add a migration with the next graph version, then record the new version
    and its property set here. A recorded version never changes once a guarded
    release ships it (rec#17 D-11). Version 10 is the first guarded release's
    baseline: no guarded build has been published yet (the release gate is
    blocked), so properties added before it ships (#258's turn receipts, #263's
    Episodic.fuli_conversation_id) are part of version 10, not a new step."""
    properties = set()
    for path in provider_sources():
        for text in _cypher_texts(path.read_text(encoding='utf-8')):
            if not re.search(r'\b(MATCH|MERGE|CREATE|SET|RETURN|WHERE)\b', text):
                continue
            properties.update(CYPHER_PROPERTY.findall(text))
            properties.update(MAP_KEY.findall(text))
    # A confirmed step's tag on what it creates is removed before its
    # transaction commits (graph_format_journal.py); it is never stored.
    properties -= {CREATED_TAG}
    recorded = json.loads(PROPERTY_FINGERPRINTS.read_text(encoding='utf-8'))
    assert str(GRAPH_FORMAT_VERSION) in recorded, (
        f'Record the property set of graph version {GRAPH_FORMAT_VERSION} in '
        f'{PROPERTY_FINGERPRINTS.name}'
    )
    expected = set(recorded[str(GRAPH_FORMAT_VERSION)])
    assert sorted(properties - expected) == [], (
        'New graph properties need a migration with the next graph version '
        f'(then record that version in {PROPERTY_FINGERPRINTS.name})'
    )
    assert sorted(expected - properties) == [], (
        f'Properties no longer used: record the next version in {PROPERTY_FINGERPRINTS.name}'
    )
