import math
from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest

from fuli_graph.runtime import (
    AgentStructuredLLM,
    GraphitiRuntime,
    LocalHashEmbedder,
    LocalLexicalReranker,
)


def test_local_hash_embedder_rejects_dimensions_that_are_too_small():
    with pytest.raises(ValueError, match='at least 64 dimensions'):
        LocalHashEmbedder(63)


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


def runtime_with_driver(driver):
    runtime = GraphitiRuntime.__new__(GraphitiRuntime)
    runtime.graphiti = SimpleNamespace(driver=driver)
    return runtime


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
