import asyncio
import logging
import math

import pytest

from fuli_graph.runtime import (
    AgentStructuredLLM,
    LocalHashEmbedder,
    LocalLexicalReranker,
    ManagedNeo4jDriver,
)


def test_neo4j_notifications_stay_out_of_the_provider_log_while_driver_errors_remain(caplog):
    from neo4j._async.work.result import notification_log

    notification_log.warning('Received notification from DBMS server: synthetic unknown label')
    logging.getLogger('neo4j').error('synthetic driver error')

    assert [record.getMessage() for record in caplog.records] == ['synthetic driver error']


def test_local_hash_embedder_rejects_dimensions_that_are_too_small():
    with pytest.raises(ValueError, match='at least 64 dimensions'):
        LocalHashEmbedder(63)


@pytest.mark.asyncio
async def test_managed_driver_never_runs_the_dependency_index_build(monkeypatch):
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
        await driver.build_indices_and_constraints()
        # The format registry declares and creates Graphiti's indexes itself.
        assert calls == 0
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
async def test_a_failed_name_key_tidy_up_still_gives_every_space_its_defaults(monkeypatch, caplog):
    import types

    from fuli_graph import store_project_agent_naming, system_agents
    from fuli_graph.runtime import GraphitiRuntime

    class Driver:
        async def execute_query(self, query, **_params):
            rows = [{'space_id': 'space-a'}, {'space_id': 'space-b'}] if 'RETURN space.id' in query else []
            return rows, None, None

    async def failing_clear(_driver, space_id=None, keys=None):
        raise RuntimeError(f'constraint on "nova park" in {space_id}')

    ensured = []

    async def ensure(_driver, provider_id, space_id):
        ensured.append((provider_id, space_id))

    monkeypatch.setattr(store_project_agent_naming, 'clear_stale_name_keys', failing_clear)
    monkeypatch.setattr(system_agents, 'ensure_system_agents', ensure)
    runtime = object.__new__(GraphitiRuntime)
    runtime.settings = types.SimpleNamespace(provider_id='provider')
    runtime.graphiti = types.SimpleNamespace(driver=Driver())

    with caplog.at_level(logging.WARNING, logger='fuli_graph.runtime'):
        await runtime._ensure_personal_space_defaults()

    assert ensured == [('provider', 'space-a'), ('provider', 'space-b')]
    logged = [record.getMessage() for record in caplog.records if record.name == 'fuli_graph.runtime']
    assert len(logged) == 2
    assert 'space-a' in logged[0] and 'RuntimeError' in logged[0]
    assert all('nova park' not in message for message in logged)
