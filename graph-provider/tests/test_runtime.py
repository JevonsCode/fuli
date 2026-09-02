import asyncio
import math
from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest

from fuli_graph.runtime import (
    AgentStructuredLLM,
    GraphitiRuntime,
    LocalHashEmbedder,
    LocalLexicalReranker,
    ManagedNeo4jDriver,
)
from fuli_graph.store_project_agent_executor_learning import (
    project_agent_executor_outcome_bucket_id,
)


def test_local_hash_embedder_rejects_dimensions_that_are_too_small():
    with pytest.raises(ValueError, match='at least 64 dimensions'):
        LocalHashEmbedder(63)


@pytest.mark.asyncio
async def test_managed_driver_defers_dependency_auto_index_build(monkeypatch):
    from graphiti_core.driver.neo4j_driver import Neo4jDriver

    calls = 0

    async def build_indices(_driver, _delete_existing=False):
        nonlocal calls
        calls += 1

    monkeypatch.setattr(Neo4jDriver, 'build_indices_and_constraints', build_indices)
    driver = ManagedNeo4jDriver(
        uri='bolt://127.0.0.1:9', user='neo4j', password='synthetic-password'
    )
    try:
        await asyncio.sleep(0)
        assert calls == 0
        await driver.build_indices_and_constraints()
        assert calls == 1
    finally:
        await driver.close()


@pytest.mark.asyncio
async def test_local_hash_embedder_is_deterministic_and_normalized():
    embedder = LocalHashEmbedder(384)

    first = await embedder.create('项目不能直接修改公共模块')
    second = await embedder.create('项目不能直接修改公共模块')

    assert first == second
    assert len(first) == 384
    assert math.sqrt(sum(value * value for value in first)) == pytest.approx(1.0)


@pytest.mark.asyncio
async def test_local_hash_embedder_retains_multilingual_lexical_similarity():
    embedder = LocalHashEmbedder(384)
    query, related, unrelated = await embedder.create_batch(
        ['线上错误排查方法', '线上报错排查手册', '设计稿颜色规范']
    )

    def cosine(left, right):
        return sum(a * b for a, b in zip(left, right, strict=True))

    assert cosine(query, related) > cosine(query, unrelated)


@pytest.mark.asyncio
async def test_local_lexical_reranker_orders_exact_and_partial_matches():
    reranker = LocalLexicalReranker()

    ranked = await reranker.rank(
        'provider timeout',
        [
            'unrelated migration notes',
            'provider timeout behavior',
            'provider setup instructions',
        ],
    )

    assert ranked == [
        ('provider timeout behavior', 1.0),
        ('provider setup instructions', 0.5),
        ('unrelated migration notes', 0.0),
    ]


@pytest.mark.asyncio
async def test_agent_structured_llm_never_sends_knowledge_to_another_model():
    client = AgentStructuredLLM()

    with pytest.raises(RuntimeError, match='never invokes a second LLM'):
        await client._generate_response([])


@pytest.mark.asyncio
async def test_legacy_group_id_migration_uses_one_transaction_per_space():
    driver = MigrationDriver([
        {'id': 'space-1', 'group_id': 'personal:space-1'},
    ])
    runtime = runtime_with_driver(driver)

    await runtime._migrate_legacy_group_ids()

    assert len(driver.direct_calls) == 1
    assert driver.committed == 1
    assert driver.rolled_back == 0
    assert len(driver.transaction_calls) == 3
    assert all(
        parameters['previous'] == 'personal:space-1'
        and parameters['current'] == 'personal-space-1'
        for _, parameters in driver.transaction_calls[1:]
    )
    assert driver.transaction_calls[0][1] == {
        'space_id': 'space-1',
        'current': 'personal-space-1',
    }


@pytest.mark.asyncio
async def test_legacy_group_id_migration_rolls_back_when_one_update_fails():
    driver = MigrationDriver(
        [{'id': 'space-1', 'group_id': 'personal:space-1'}],
        fail_on_transaction_call=2,
    )
    runtime = runtime_with_driver(driver)

    with pytest.raises(RuntimeError, match='forced migration failure'):
        await runtime._migrate_legacy_group_ids()

    assert len(driver.direct_calls) == 1
    assert driver.committed == 0
    assert driver.rolled_back == 1


@pytest.mark.asyncio
async def test_learning_bucket_migration_is_space_scoped_deterministic_and_idempotent():
    strategy_key = 'a' * 64
    aggregate_buckets = [
        learning_bucket('space-a', strategy_key),
        learning_bucket('space-b', strategy_key),
    ]
    reset_buckets = [learning_bucket('space-a', strategy_key)]
    driver = LearningMigrationDriver(aggregate_buckets, reset_buckets)
    runtime = runtime_with_driver(driver)
    runtime.settings = SimpleNamespace(provider_id='provider-1')

    await runtime._migrate_project_agent_executor_learning_buckets()
    await runtime._migrate_project_agent_executor_learning_buckets()

    aggregate_calls = [
        call for call in driver.mutation_calls
        if 'OutcomeAggregate' in call[0]
    ]
    reset_calls = [
        call for call in driver.mutation_calls
        if 'OutcomeReset' in call[0]
    ]
    assert len(aggregate_calls) == 4
    assert len(reset_calls) == 2
    assert aggregate_calls[0][1]['bucket_id'] == aggregate_calls[2][1]['bucket_id']
    assert aggregate_calls[0][1]['bucket_id'] != aggregate_calls[1][1]['bucket_id']
    assert aggregate_calls[0][1]['bucket_id'] == (
        project_agent_executor_outcome_bucket_id(
            'provider-1',
            'space-a',
            'project-1',
            'review',
            'agent-1',
            'executor-1',
            strategy_key,
            bucket_kind='aggregate',
        )
    )
    assert 'bucket.as_of' in aggregate_calls[0][0]
    assert 'bucket.reset_at' in reset_calls[0][0]
    assert 'tail(buckets) AS duplicates' in aggregate_calls[0][0]
    assert 'DETACH DELETE duplicate' in aggregate_calls[0][0]
    assert 'OutcomeEvidence' not in ''.join(
        query for query, _ in driver.mutation_calls
    )


@pytest.mark.asyncio
async def test_initialize_adds_learning_id_constraints_after_legacy_deduplication():
    driver = InitializationDriver()
    runtime = runtime_with_driver(driver)
    runtime.settings = SimpleNamespace(provider_id='provider-1')
    runtime.graphiti.build_indices_and_constraints = driver.build_indices_and_constraints
    for method_name in (
        '_migrate_project_agent_control_plane',
        '_migrate_knowledge_lifecycle_defaults',
        '_migrate_personal_project_relation_review_defaults',
        '_migrate_space_visibility_and_owners',
        '_migrate_project_releases',
        '_migrate_legacy_group_ids',
    ):
        setattr(runtime, method_name, driver.noop_migration)

    await runtime.initialize()

    queries = [query for query, _ in driver.calls]
    aggregate_constraint = next(
        index for index, query in enumerate(queries)
        if 'outcome_aggregate_id' in query
    )
    reset_constraint = next(
        index for index, query in enumerate(queries)
        if 'outcome_reset_id' in query
    )
    aggregate_discovery = next(
        index for index, query in enumerate(queries)
        if 'MATCH (bucket:FuliProjectAgentExecutorOutcomeAggregate)' in query
    )
    reset_discovery = next(
        index for index, query in enumerate(queries)
        if 'MATCH (bucket:FuliProjectAgentExecutorOutcomeReset)' in query
    )
    assert aggregate_discovery < aggregate_constraint
    assert reset_discovery < reset_constraint
    assert 'REQUIRE n.id IS UNIQUE' in queries[aggregate_constraint]
    assert 'REQUIRE n.id IS UNIQUE' in queries[reset_constraint]


def runtime_with_driver(driver):
    runtime = GraphitiRuntime.__new__(GraphitiRuntime)
    runtime.graphiti = SimpleNamespace(driver=driver)
    return runtime


def learning_bucket(space_id, strategy_key):
    return {
        'personal_space_id': space_id,
        'personal_project_id': 'project-1',
        'work_kind': 'review',
        'agent_id': 'agent-1',
        'executor_id': 'executor-1',
        'model_strategy_key': strategy_key,
    }


class LearningMigrationDriver:
    def __init__(self, aggregate_buckets, reset_buckets):
        self.aggregate_buckets = aggregate_buckets
        self.reset_buckets = reset_buckets
        self.mutation_calls = []

    async def execute_query(self, query, **parameters):
        if 'RETURN DISTINCT' in query and 'OutcomeAggregate' in query:
            return self.aggregate_buckets, None, None
        if 'RETURN DISTINCT' in query and 'OutcomeReset' in query:
            return self.reset_buckets, None, None
        self.mutation_calls.append((query, parameters))
        return [{'removed_count': 1}], None, None


class InitializationDriver:
    def __init__(self):
        self.calls = []

    async def build_indices_and_constraints(self):
        return None

    async def noop_migration(self):
        return None

    async def execute_query(self, query, **parameters):
        self.calls.append((query, parameters))
        return [], None, None


class MigrationDriver:
    def __init__(self, records, fail_on_transaction_call=None):
        self.records = records
        self.fail_on_transaction_call = fail_on_transaction_call
        self.direct_calls = []
        self.transaction_calls = []
        self.committed = 0
        self.rolled_back = 0

    async def execute_query(self, query, **parameters):
        self.direct_calls.append((query, parameters))
        if 'RETURN s.id AS id, s.group_id AS group_id' in query:
            return self.records, None, None
        return [], None, None

    @asynccontextmanager
    async def transaction(self):
        transaction = MigrationTransaction(self)
        try:
            yield transaction
        except BaseException:
            self.rolled_back += 1
            raise
        else:
            self.committed += 1


class MigrationTransaction:
    def __init__(self, driver):
        self.driver = driver

    async def run(self, query, **parameters):
        self.driver.transaction_calls.append((query, parameters))
        if len(self.driver.transaction_calls) == self.driver.fail_on_transaction_call:
            raise RuntimeError('forced migration failure')
