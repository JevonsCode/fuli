"""Concurrency regressions for executor-learning bucket transactions."""

import asyncio
from datetime import UTC, datetime, timedelta

import pytest

from fuli_graph.provider_values import native_datetime
from test_executor_evidence_neo4j import (
    actual_payload,
    evidence_setup,
    learning_snapshot,
)
from test_project_agent_memory_neo4j import fixture_settings, provider_client


OUTCOMES_PATH = '/v1/project-agent-routing-outcomes'
IGNORE_PATH = '/v1/project-agent-routing-learning/ignore'
RESET_PATH = '/v1/project-agent-routing-learning/reset'
LEARNING_PATH = '/v1/project-agent-routing-learning'


async def create_related_task(client, scope, suffix):
    response = await client.post('/v1/project-agent-tasks', json={
        **scope,
        'idempotency_key': f'synthetic-learning-{suffix}-task',
        'title': f'Synthetic learning task {suffix}',
        'objective': 'Exercise one executor-learning bucket concurrently.',
        'work_kind': 'implementation',
        'lead_agent_id': 'engineer',
        'source_application': 'codex',
        'routing_reason': 'Use the synthetic engineer.',
    })
    assert response.status_code == 200, response.text
    task = response.json()['task']
    actual = await client.post('/v1/project-agent-executor-actuals', json=actual_payload(
        scope,
        task,
        run_id=f'synthetic-learning-{suffix}-run',
        idempotency_key=f'synthetic-learning-{suffix}-actual',
    ))
    assert actual.status_code == 200, actual.text
    return task


def evidence_payload(scope, task, suffix, *, occurred_at=None):
    return {
        **scope,
        'task_id': task['task_id'],
        'agent_id': 'engineer',
        'executor_id': 'synthetic-executor',
        'work_kind': task['work_kind'],
        'model_strategy': task['effective_model_strategy'],
        'evidence_kind': 'test_passed',
        'source': 'test_fact',
        'reference_ids': [f'synthetic:{suffix}'],
        'idempotency_key': f'synthetic-learning-{suffix}-evidence',
        'occurred_at': (occurred_at or datetime.now(UTC)).isoformat(),
    }


def pause_after_aggregate_read(monkeypatch, personal_space_id):
    """Pause one transaction after its evidence read and before aggregate write."""

    from graphiti_core.driver.neo4j_driver import Neo4jDriver
    from fuli_graph.store_transactions import TransactionQueryDriver

    paused = asyncio.Event()
    release = asyncio.Event()
    fired = False

    def wrapper(execute):
        async def intercepted(driver, query, **parameters):
            nonlocal fired
            result = await execute(driver, query, **parameters)
            if (
                not fired
                and 'MATCH (evidence:FuliProjectAgentExecutorOutcomeEvidence' in query
                and 'RETURN evidence' in query
                and 'MERGE' not in query
                and parameters.get('personal_space_id') == personal_space_id
            ):
                fired = True
                paused.set()
                await asyncio.wait_for(release.wait(), 10)
            return result

        return intercepted

    monkeypatch.setattr(Neo4jDriver, 'execute_query', wrapper(Neo4jDriver.execute_query))
    monkeypatch.setattr(
        TransactionQueryDriver,
        'execute_query',
        wrapper(TransactionQueryDriver.execute_query),
    )
    return paused, release


async def join_operations(first, second, release):
    release.set()
    results = []
    for operation in (first, second):
        if operation is not None:
            results.append(await asyncio.wait_for(operation, 10))
    return results


def assert_one_successful_sample(learning_response, evidence_id):
    assert learning_response.status_code == 200, learning_response.text
    aggregates = learning_response.json()
    assert len(aggregates) == 1
    aggregate = aggregates[0]
    assert aggregate['sample_count'] == 1
    assert aggregate['success_count'] == 1
    assert aggregate['failure_count'] == 0
    assert [item['evidence_id'] for item in aggregate['evidence_contributions']] == [
        evidence_id,
    ]


@pytest.mark.asyncio
async def test_record_and_ignore_same_bucket_publish_a_current_aggregate(monkeypatch):
    settings = fixture_settings()
    async with provider_client(settings, raise_app_exceptions=False) as (client, _):
        scope, task, record_payload = await evidence_setup(client, with_actual=True)
        ignored_task = await create_related_task(client, scope, 'ignore')
        ignored_payload = evidence_payload(scope, ignored_task, 'ignore')
        created = await client.post(OUTCOMES_PATH, json=ignored_payload)
        assert created.status_code == 200, created.text
        ignored_evidence_id = created.json()['evidence_id']

        paused, release = pause_after_aggregate_read(
            monkeypatch,
            scope['personal_space_id'],
        )
        first = asyncio.create_task(client.post(OUTCOMES_PATH, json=record_payload))
        second = None
        first_result = second_result = None
        try:
            await asyncio.wait_for(paused.wait(), 10)
            second = asyncio.create_task(client.post(IGNORE_PATH, json={
                **scope,
                'agent_id': 'engineer',
                'evidence_id': ignored_evidence_id,
                'idempotency_key': 'synthetic-concurrent-ignore',
                'reason': 'Ignore one synthetic sample while recording another.',
            }))
            done, _ = await asyncio.wait([second], timeout=0.5)
            assert not done, 'same-bucket ignore must wait for the active aggregate transaction'
        finally:
            results = await join_operations(first, second, release)
            first_result = results[0]
            second_result = results[1] if second is not None else None

        assert first_result.status_code == 200, first_result.text
        assert second_result is not None and second_result.status_code == 200, (
            second_result.text if second_result is not None else 'ignore did not start'
        )
        learning = await client.get(LEARNING_PATH, params=scope)
        assert_one_successful_sample(learning, first_result.json()['evidence_id'])
        assert first_result.json()['evidence_id'] != ignored_evidence_id
        assert len(await learning_snapshot(settings, scope)) == 3


@pytest.mark.asyncio
async def test_record_and_reset_same_bucket_publish_record_after_reset(monkeypatch):
    settings = fixture_settings()
    async with provider_client(settings, raise_app_exceptions=False) as (client, _):
        scope, old_task, old_payload = await evidence_setup(client, with_actual=True)
        old_record = await client.post(OUTCOMES_PATH, json=old_payload)
        assert old_record.status_code == 200, old_record.text
        new_task = await create_related_task(client, scope, 'reset')
        reset_at = datetime.now(UTC) + timedelta(seconds=1)
        new_payload = evidence_payload(
            scope,
            new_task,
            'after-reset',
            occurred_at=reset_at + timedelta(seconds=1),
        )

        paused, release = pause_after_aggregate_read(
            monkeypatch,
            scope['personal_space_id'],
        )
        first = asyncio.create_task(client.post(OUTCOMES_PATH, json=new_payload))
        second = None
        first_result = second_result = None
        try:
            await asyncio.wait_for(paused.wait(), 10)
            second = asyncio.create_task(client.post(RESET_PATH, json={
                **scope,
                'agent_id': 'engineer',
                'executor_id': 'synthetic-executor',
                'work_kind': old_task['work_kind'],
                'model_strategy': old_task['effective_model_strategy'],
                'idempotency_key': 'synthetic-concurrent-reset',
                'reason': 'Reset the synthetic bucket before the new sample.',
                'reset_at': reset_at.isoformat(),
            }))
            done, _ = await asyncio.wait([second], timeout=0.5)
            assert not done, 'same-bucket reset must wait for the active aggregate transaction'
        finally:
            results = await join_operations(first, second, release)
            first_result = results[0]
            second_result = results[1] if second is not None else None

        assert first_result.status_code == 200, first_result.text
        assert second_result is not None and second_result.status_code == 200, (
            second_result.text if second_result is not None else 'reset did not start'
        )
        assert datetime.fromisoformat(new_payload['occurred_at']) > reset_at
        learning = await client.get(LEARNING_PATH, params=scope)
        assert_one_successful_sample(learning, first_result.json()['evidence_id'])
        snapshot = await learning_snapshot(settings, scope)
        assert any(node.get('reset_at') is not None for node in snapshot)
        new_occurred_at = datetime.fromisoformat(new_payload['occurred_at'])
        assert any(
            native_datetime(node.get('occurred_at')) == new_occurred_at
            for node in snapshot
        )


@pytest.mark.asyncio
async def test_different_learning_buckets_do_not_block_each_other(monkeypatch):
    settings = fixture_settings()
    async with provider_client(settings, raise_app_exceptions=False) as (client, _):
        first_scope, _, first_payload = await evidence_setup(client, with_actual=True)
        second_scope, _, second_payload = await evidence_setup(client, with_actual=True)
        paused, release = pause_after_aggregate_read(
            monkeypatch,
            first_scope['personal_space_id'],
        )
        first = asyncio.create_task(client.post(OUTCOMES_PATH, json=first_payload))
        second = None
        first_result = second_result = None
        try:
            await asyncio.wait_for(paused.wait(), 10)
            second = asyncio.create_task(client.post(OUTCOMES_PATH, json=second_payload))
            done, _ = await asyncio.wait([second], timeout=1)
            assert done, 'independent bucket must complete while the first bucket is paused'
            second_result = second.result()
        finally:
            results = await join_operations(first, second, release)
            first_result = results[0]
            if second_result is None and second is not None:
                second_result = results[1]

        assert first_result.status_code == 200, first_result.text
        assert second_result is not None and second_result.status_code == 200, (
            second_result.text if second_result is not None else 'independent write did not start'
        )
        first_learning = await client.get(LEARNING_PATH, params=first_scope)
        second_learning = await client.get(LEARNING_PATH, params=second_scope)
        assert_one_successful_sample(first_learning, first_result.json()['evidence_id'])
        assert_one_successful_sample(second_learning, second_result.json()['evidence_id'])
