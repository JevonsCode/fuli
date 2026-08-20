import asyncio
import os
from datetime import datetime, timezone
from types import SimpleNamespace
from urllib.parse import urlparse

import pytest
from neo4j import AsyncGraphDatabase

from fuli_graph.runtime import GraphitiRuntime
from fuli_graph.store_project_agent_executor_learning import (
    project_agent_executor_outcome_bucket_id,
)


UTC = timezone.utc
AGGREGATE_CONSTRAINT = (
    'CREATE CONSTRAINT fuli_project_agent_executor_outcome_aggregate_id '
    'IF NOT EXISTS FOR (n:FuliProjectAgentExecutorOutcomeAggregate) '
    'REQUIRE n.id IS UNIQUE'
)
RESET_CONSTRAINT = (
    'CREATE CONSTRAINT fuli_project_agent_executor_outcome_reset_id '
    'IF NOT EXISTS FOR (n:FuliProjectAgentExecutorOutcomeReset) '
    'REQUIRE n.id IS UNIQUE'
)


@pytest.mark.asyncio
async def test_real_neo4j_learning_bucket_migration_and_concurrent_identity():
    uri = os.getenv('FULI_TEST_NEO4J_URI')
    password = os.getenv('FULI_TEST_NEO4J_PASSWORD')
    ephemeral = os.getenv('FULI_TEST_NEO4J_EPHEMERAL') == '1'
    if not uri or not password or not ephemeral:
        pytest.skip(
            'set FULI_TEST_NEO4J_URI, FULI_TEST_NEO4J_PASSWORD, and '
            'FULI_TEST_NEO4J_EPHEMERAL=1 for a disposable database'
        )
    if urlparse(uri).hostname not in {'127.0.0.1', 'localhost', '::1'}:
        pytest.fail('destructive Project Agent integration test requires loopback Neo4j')

    driver = AsyncGraphDatabase.driver(uri, auth=('neo4j', password))
    strategy_key = 'a' * 64
    try:
        await driver.verify_connectivity()
        await _clear_learning_fixture(driver)
        await _seed_legacy_learning_buckets(driver, strategy_key)
        runtime = GraphitiRuntime.__new__(GraphitiRuntime)
        runtime.graphiti = SimpleNamespace(driver=driver)
        runtime.settings = SimpleNamespace(provider_id='integration-provider')

        await runtime._migrate_project_agent_executor_learning_buckets()
        await driver.execute_query(AGGREGATE_CONSTRAINT)
        await driver.execute_query(RESET_CONSTRAINT)
        # Startup migration is deliberately safe to repeat after constraints
        # already exist, as happens on every subsequent provider restart.
        await runtime._migrate_project_agent_executor_learning_buckets()

        aggregates, _, _ = await driver.execute_query(
            '''
            MATCH (aggregate:FuliProjectAgentExecutorOutcomeAggregate)
            RETURN aggregate.personal_space_id AS space_id,
                   aggregate.id AS id,
                   aggregate.marker AS marker
            ORDER BY space_id
            ''',
            routing_='r',
        )
        assert [row['space_id'] for row in aggregates] == ['space-a', 'space-b']
        assert [row['marker'] for row in aggregates] == ['newest', 'space-b']
        assert aggregates[0]['id'] == project_agent_executor_outcome_bucket_id(
            'integration-provider',
            'space-a',
            'project-1',
            'review',
            'agent-1',
            'executor-1',
            strategy_key,
            bucket_kind='aggregate',
        )
        assert aggregates[0]['id'] != aggregates[1]['id']

        resets, _, _ = await driver.execute_query(
            '''
            MATCH (reset:FuliProjectAgentExecutorOutcomeReset)
            RETURN count(reset) AS count,
                   max(reset.reset_at) AS reset_at,
                   collect(reset.reason) AS reasons
            ''',
            routing_='r',
        )
        assert resets[0]['count'] == 1
        assert resets[0]['reset_at'].to_native() == datetime(2026, 2, 1, tzinfo=UTC)
        assert resets[0]['reasons'] == ['newest reset']

        evidence, _, _ = await driver.execute_query(
            'MATCH (evidence:FuliProjectAgentExecutorOutcomeEvidence) '
            'RETURN count(evidence) AS count, collect(evidence.id) AS ids',
            routing_='r',
        )
        assert evidence[0]['count'] == 2
        assert set(evidence[0]['ids']) == {'evidence-1', 'evidence-2'}

        await _concurrently_merge_one_bucket(driver, strategy_key)
        concurrent_count, _, _ = await driver.execute_query(
            '''
            MATCH (aggregate:FuliProjectAgentExecutorOutcomeAggregate {
              personal_space_id: 'space-concurrent'
            })
            RETURN count(aggregate) AS count, count(DISTINCT aggregate.id) AS ids
            ''',
            routing_='r',
        )
        assert concurrent_count[0]['count'] == 1
        assert concurrent_count[0]['ids'] == 1
    finally:
        try:
            await _clear_learning_fixture(driver)
        finally:
            await driver.close()


async def _clear_learning_fixture(driver):
    await driver.execute_query(
        'DROP CONSTRAINT fuli_project_agent_executor_outcome_aggregate_id '
        'IF EXISTS'
    )
    await driver.execute_query(
        'DROP CONSTRAINT fuli_project_agent_executor_outcome_reset_id IF EXISTS'
    )
    await driver.execute_query(
        '''
        MATCH (node)
        WHERE node:FuliProjectAgentExecutorOutcomeAggregate
           OR node:FuliProjectAgentExecutorOutcomeReset
           OR node:FuliProjectAgentExecutorOutcomeEvidence
        DETACH DELETE node
        '''
    )


async def _seed_legacy_learning_buckets(driver, strategy_key):
    common = {
        'personal_project_id': 'project-1',
        'work_kind': 'review',
        'agent_id': 'agent-1',
        'executor_id': 'executor-1',
        'model_strategy_key': strategy_key,
    }
    await driver.execute_query(
        '''
        UNWIND $rows AS row
        CREATE (aggregate:FuliProjectAgentExecutorOutcomeAggregate)
        SET aggregate = row
        ''',
        rows=[
            {
                **common,
                'personal_space_id': 'space-a',
                'as_of': datetime(2026, 1, 1, tzinfo=UTC),
                'marker': 'oldest',
            },
            {
                **common,
                'personal_space_id': 'space-a',
                'as_of': datetime(2026, 2, 1, tzinfo=UTC),
                'marker': 'newest',
            },
            {
                **common,
                'personal_space_id': 'space-b',
                'as_of': datetime(2026, 1, 15, tzinfo=UTC),
                'marker': 'space-b',
            },
        ],
    )
    await driver.execute_query(
        '''
        UNWIND $rows AS row
        CREATE (reset:FuliProjectAgentExecutorOutcomeReset)
        SET reset = row
        ''',
        rows=[
            {
                **common,
                'personal_space_id': 'space-a',
                'reset_at': datetime(2026, 1, 1, tzinfo=UTC),
                'reason': 'oldest reset',
            },
            {
                **common,
                'personal_space_id': 'space-a',
                'reset_at': datetime(2026, 2, 1, tzinfo=UTC),
                'reason': 'newest reset',
            },
        ],
    )
    await driver.execute_query(
        '''
        CREATE (:FuliProjectAgentExecutorOutcomeEvidence {id: 'evidence-1'})
        CREATE (:FuliProjectAgentExecutorOutcomeEvidence {id: 'evidence-2'})
        '''
    )


async def _concurrently_merge_one_bucket(driver, strategy_key):
    bucket_id = project_agent_executor_outcome_bucket_id(
        'integration-provider',
        'space-concurrent',
        'project-1',
        'review',
        'agent-1',
        'executor-1',
        strategy_key,
        bucket_kind='aggregate',
    )

    async def merge_once(writer):
        await driver.execute_query(
            '''
            MERGE (aggregate:FuliProjectAgentExecutorOutcomeAggregate {id: $id})
            ON CREATE SET aggregate.personal_space_id = 'space-concurrent',
                          aggregate.personal_project_id = 'project-1',
                          aggregate.work_kind = 'review',
                          aggregate.agent_id = 'agent-1',
                          aggregate.executor_id = 'executor-1',
                          aggregate.model_strategy_key = $model_strategy_key
            SET aggregate.last_writer = $writer
            ''',
            id=bucket_id,
            model_strategy_key=strategy_key,
            writer=writer,
        )

    await asyncio.gather(*(merge_once(writer) for writer in range(12)))
