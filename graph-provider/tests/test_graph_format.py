"""The graph format registry without a database: its declarations, its
fingerprint, the record-changing steps' bodies and the driver's format guard.
Behavior against a real graph lives in test_graph_format_neo4j.py."""

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
from fuli_graph.graph_format_ledger import LEDGER_LABELS
from fuli_graph.graph_format_migrations import GRAPH_FORMAT_VERSION, GRAPH_MIGRATIONS
from fuli_graph.graph_format_schema import schema_fingerprint
from fuli_graph.runtime import ManagedNeo4jDriver
from fuli_graph.store_project_agent_executor_learning import (
    project_agent_executor_outcome_bucket_id,
)

PACKAGE = Path(__file__).resolve().parents[1] / 'fuli_graph'
FINGERPRINTS = Path(__file__).with_name('graph_format_fingerprints.json')
SCHEMA_OWNER = 'graph_format_schema.py'
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
        for path in provider_sources() if path.name != SCHEMA_OWNER
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
    """Stands in for the Neo4j client under ManagedNeo4jDriver."""

    def __init__(self, error=None):
        self.error = error
        self.queries = []
        self.sessions = []

    async def execute_query(self, query, **kwargs):
        self.queries.append((query, kwargs))
        if self.error:
            raise self.error
        return [], None, None

    def session(self, **kwargs):
        self.sessions.append(kwargs)
        return RecordingSession()


class RecordingSession:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        return False

    async def begin_transaction(self):
        return SimpleNamespace(commit=_done, rollback=_done)


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
async def test_current_graph_writes_normally():
    client = RecordingClient()
    driver = guarded_driver(GraphFormatState('write', 'current', GRAPH_FORMAT_VERSION), client)

    await driver.execute_query('CREATE (:Synthetic)')
    async with driver.transaction():
        pass

    assert 'routing_' not in client.queries[0][1]
    # A writable graph uses the dependency's own write transaction.
    assert client.sessions[0].get('default_access_mode', WRITE_ACCESS) == WRITE_ACCESS


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
    assert 'not been checked' in response.json()['detail']['message']
