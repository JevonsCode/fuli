"""Public HTTP activity acceptance against an explicitly disposable graph."""

import asyncio
from contextlib import asynccontextmanager
from datetime import UTC, datetime

import pytest

from test_project_agent_memory_neo4j import fixture_settings, provider_client, seed_agent


@pytest.mark.asyncio
async def test_blocked_collaborator_resume_promotes_exactly_one_lead():
    """A fallback runner must become the task's relational lead atomically."""

    async with provider_client(fixture_settings(), raise_app_exceptions=False) as (client, _):
        space = await client.post('/v1/spaces', json={
            'name': 'Synthetic fallback lead promotion', 'kind': 'personal',
        })
        assert space.status_code == 200, space.text
        scope = {'personal_space_id': space.json()['id'],
                 'personal_project_id': 'sample-project'}
        await seed_agent(client, scope['personal_space_id'], agent='reviewer')
        await seed_executor(client, scope['personal_space_id'])
        created = await client.post('/v1/project-agent-tasks', json={
            **scope, 'idempotency_key': 'synthetic-fallback-lead-task',
            'title': 'Synthetic fallback lead task',
            'objective': 'Keep scalar and participant lead ownership consistent.',
            'work_kind': 'implementation', 'staffing_intent': 'unassigned',
            'collaborator_agent_ids': ['reviewer'],
            'source_application': 'codex',
            'routing_reason': 'Start deliberately blocked with a collaborator only.',
        })
        assert created.status_code == 200, created.text
        blocked = created.json()['task']
        assert blocked['status'] == 'blocked'
        assert blocked['lead_agent_id'] is None
        assert [(item['agent_id'], item['role']) for item in blocked['participants']] == [
            ('reviewer', 'collaborator')]

        resumed = await client.post(
            f'/v1/project-agent-tasks/{blocked["task_id"]}/events',
            json={
                **scope, 'task_id': blocked['task_id'], 'agent_id': 'reviewer',
                'expected_revision': blocked['revision'],
                'idempotency_key': 'synthetic-fallback-lead-running',
                'status': 'running',
                'summary': 'Synthetic executor evidence resumes the blocked task.',
                'source_application': 'codex',
                'actual_executor_id': 'synthetic-executor',
                'actual_model_provider': 'synthetic',
                'actual_model': 'synthetic-model',
            },
        )
        assert resumed.status_code == 200, resumed.text
        running = resumed.json()
        assert running['lead_agent_id'] == 'reviewer'
        assert [(item['agent_id'], item['role']) for item in running['participants']] == [
            ('reviewer', 'lead')]


@pytest.mark.asyncio
async def test_rejected_executor_evidence_cannot_change_task_or_reserve_event_key():
    async with provider_client(fixture_settings(), raise_app_exceptions=False) as (client, _):
        space = await client.post('/v1/spaces', json={
            'name': 'Synthetic activity atomicity acceptance', 'kind': 'personal',
        })
        assert space.status_code == 200, space.text
        scope = {'personal_space_id': space.json()['id'], 'personal_project_id': 'sample-project'}
        await seed_agent(client, scope['personal_space_id'])
        created = await client.post('/v1/project-agent-tasks', json={
            **scope, 'idempotency_key': 'synthetic-activity-atomic-task',
            'title': 'Synthetic activity atomicity', 'objective': 'Reject invalid execution evidence.',
            'work_kind': 'implementation', 'lead_agent_id': 'engineer',
            'source_application': 'codex', 'routing_reason': 'Use the assigned synthetic engineer.',
        })
        assert created.status_code == 200, created.text
        original = created.json()['task']
        path = f'/v1/project-agent-tasks/{original["task_id"]}/events'
        invalid = {
            **scope, 'task_id': original['task_id'], 'agent_id': 'engineer',
            'idempotency_key': 'synthetic-invalid-executor-event', 'status': 'cancelled',
            'summary': 'Synthetic cancellation with invalid executor evidence.',
            'source_application': 'codex', 'worker_id': 'synthetic-activity-worker',
            'worker_status': 'cancelled', 'actual_executor_id': 'unregistered-synthetic-executor',
            'actual_model_provider': 'synthetic', 'actual_model': 'synthetic-model',
        }
        rejected = await client.post(path, json=invalid)
        assert 400 <= rejected.status_code < 500, rejected.text
        visible = await client.get('/v1/project-agent-tasks', params=scope)
        assert visible.status_code == 200, visible.text
        unchanged = next(task for task in visible.json() if task['task_id'] == original['task_id'])
        assert unchanged['status'] == original['status']
        assert unchanged['revision'] == original['revision']
        assert unchanged['events'] == original['events']
        assert unchanged['participants'] == original['participants']
        replay = await client.post(path, json=invalid)
        assert replay.status_code == rejected.status_code, replay.text
        corrected = {key: value for key, value in invalid.items()
            if key not in {'actual_executor_id', 'actual_model_provider', 'actual_model'}}
        accepted = await client.post(path, json=corrected)
        assert accepted.status_code == 200, accepted.text
        assert accepted.json()['revision'] == original['revision'] + 1
        assert accepted.json()['status'] == 'cancelled'
        assert len(accepted.json()['events']) == len(original['events']) + 1


@pytest.mark.asyncio
@pytest.mark.parametrize('stage', ['observation', 'outcome', 'aggregate'])
async def test_interrupted_execution_audit_rolls_back_the_whole_activity(monkeypatch, stage):
    async with provider_client(fixture_settings(), raise_app_exceptions=False) as (client, _):
        space = await client.post('/v1/spaces', json={
            'name': 'Synthetic interrupted audit acceptance', 'kind': 'personal',
        })
        assert space.status_code == 200, space.text
        scope = {'personal_space_id': space.json()['id'], 'personal_project_id': 'sample-project'}
        await seed_agent(client, scope['personal_space_id'])
        await seed_executor(client, scope['personal_space_id'])
        created = await client.post('/v1/project-agent-tasks', json={
            **scope, 'idempotency_key': 'synthetic-interrupted-audit-task',
            'title': 'Synthetic audit persistence', 'objective': 'Keep task and audit consistent.',
            'work_kind': 'implementation', 'lead_agent_id': 'engineer',
            'source_application': 'codex', 'routing_reason': 'Use the assigned synthetic engineer.',
        })
        assert created.status_code == 200, created.text
        original = created.json()['task']
        path = f'/v1/project-agent-tasks/{original["task_id"]}/events'
        event = {
            **scope, 'task_id': original['task_id'], 'agent_id': 'engineer',
            'idempotency_key': 'synthetic-interrupted-audit-event', 'status': 'cancelled',
            'summary': 'Synthetic terminal executor evidence.',
            'source_application': 'codex', 'worker_id': 'synthetic-activity-worker',
            'worker_status': 'cancelled', 'actual_executor_id': 'synthetic-executor',
            'actual_model_provider': 'synthetic', 'actual_model': 'synthetic-model',
        }
        fault = interrupt_one_audit_write(monkeypatch, stage)
        interrupted = await client.post(path, json=event)
        assert fault['fired'], interrupted.text
        assert interrupted.status_code == 500, interrupted.text
        visible = await client.get('/v1/project-agent-tasks', params=scope)
        assert visible.status_code == 200, visible.text
        unchanged = next(task for task in visible.json() if task['task_id'] == original['task_id'])
        for key in ['status', 'revision', 'events', 'participants', 'actual_executor_id',
                    'actual_model_provider', 'actual_model', 'actual_run_id']:
            assert unchanged.get(key) == original.get(key), key
        learning = await client.get('/v1/project-agent-routing-learning', params=scope)
        assert learning.status_code == 200, learning.text
        assert learning.json() == []
        accepted = await client.post(path, json=event)
        assert accepted.status_code == 200, accepted.text
        assert accepted.json()['revision'] == original['revision'] + 1
        assert accepted.json()['status'] == 'cancelled'
        assert accepted.json()['actual_model'] == 'synthetic-model'
        replay = await client.post(path, json=event)
        assert replay.status_code == 200, replay.text
        assert replay.json() == accepted.json()
        learning = await client.get('/v1/project-agent-routing-learning', params=scope)
        assert learning.status_code == 200, learning.text
        assert len(learning.json()) == 1


@pytest.mark.asyncio
async def test_concurrent_activity_revision_has_only_one_winner():
    async with provider_client(fixture_settings(), raise_app_exceptions=False) as (client, _):
        space = await client.post('/v1/spaces', json={
            'name': 'Synthetic concurrent activity acceptance', 'kind': 'personal',
        })
        assert space.status_code == 200, space.text
        scope = {'personal_space_id': space.json()['id'], 'personal_project_id': 'sample-project'}
        await seed_agent(client, scope['personal_space_id'])
        for round_number in range(3):
            created = await client.post('/v1/project-agent-tasks', json={
                **scope, 'idempotency_key': f'synthetic-concurrent-task-{round_number}',
                'title': 'Synthetic concurrent task', 'objective': 'Accept only one revision.',
                'work_kind': 'implementation', 'lead_agent_id': 'engineer',
                'source_application': 'codex', 'routing_reason': 'Use the synthetic engineer.',
            })
            assert created.status_code == 200, created.text
            original = created.json()['task']
            path = f'/v1/project-agent-tasks/{original["task_id"]}/events'
            requests = [{
                **scope, 'task_id': original['task_id'], 'agent_id': 'engineer',
                'idempotency_key': f'synthetic-concurrent-event-{index}',
                'expected_revision': original['revision'], 'status': 'cancelled',
                'summary': f'Synthetic concurrent cancellation {index}.',
                'source_application': 'codex',
            } for index in range(8)]
            results = await asyncio.gather(*(client.post(path, json=event) for event in requests))
            assert sorted(result.status_code for result in results) == [200] + [409] * 7, [
                (result.status_code, result.text) for result in results
            ]
            visible = await client.get('/v1/project-agent-tasks', params=scope)
            assert visible.status_code == 200, visible.text
            current = next(task for task in visible.json() if task['task_id'] == original['task_id'])
            assert current['revision'] == original['revision'] + 1
            assert len(current['events']) == len(original['events']) + 1
            winner = requests[next(index for index, result in enumerate(results) if result.status_code == 200)]
            replays = await asyncio.gather(*(client.post(path, json=winner) for _ in range(8)))
            assert all(result.status_code == 200 for result in replays)
            assert all(result.json() == current for result in replays)


@pytest.mark.asyncio
async def test_one_activity_rollback_cannot_rollback_an_independent_request(monkeypatch):
    async with provider_client(fixture_settings(), raise_app_exceptions=False) as (client, _):
        tasks = []
        for index in range(2):
            space = await client.post('/v1/spaces', json={
                'name': f'Synthetic transaction isolation {index}', 'kind': 'personal',
            })
            assert space.status_code == 200, space.text
            scope = {'personal_space_id': space.json()['id'], 'personal_project_id': 'sample-project'}
            await seed_agent(client, scope['personal_space_id'])
            if index == 0:
                await seed_executor(client, scope['personal_space_id'])
            created = await client.post('/v1/project-agent-tasks', json={
                **scope, 'idempotency_key': 'synthetic-isolated-task',
                'title': 'Synthetic isolated transaction', 'objective': 'Do not share a transaction.',
                'work_kind': 'implementation', 'lead_agent_id': 'engineer',
                'source_application': 'codex', 'routing_reason': 'Use the synthetic engineer.',
            })
            assert created.status_code == 200, created.text
            tasks.append((scope, created.json()['task']))

        def event_for(scope, task):
            return {
                **scope, 'task_id': task['task_id'], 'agent_id': 'engineer',
                'idempotency_key': 'synthetic-isolated-event', 'status': 'cancelled',
                'summary': 'Synthetic independent cancellation.', 'source_application': 'codex',
            }

        first_scope, first_task = tasks[0]
        first_event = {**event_for(first_scope, first_task),
            'actual_executor_id': 'synthetic-executor',
            'actual_model_provider': 'synthetic', 'actual_model': 'synthetic-model'}
        reached_fault = asyncio.Event()
        release_fault = asyncio.Event()

        async def hold_failed_transaction():
            reached_fault.set()
            await asyncio.wait_for(release_fault.wait(), timeout=10)

        fault = interrupt_one_audit_write(monkeypatch, 'observation',
            task_id=first_task['task_id'], before_raise=hold_failed_transaction)
        first_request = asyncio.create_task(client.post(
            f'/v1/project-agent-tasks/{first_task["task_id"]}/events', json=first_event))
        try:
            await asyncio.wait_for(reached_fault.wait(), timeout=10)
            second_scope, second_task = tasks[1]
            second = await asyncio.wait_for(client.post(
                f'/v1/project-agent-tasks/{second_task["task_id"]}/events',
                json=event_for(second_scope, second_task)), timeout=5)
            assert second.status_code == 200, second.text
        finally:
            release_fault.set()
            first = await first_request
        assert fault['fired']
        assert first.status_code == 500, first.text
        for index, (scope, task) in enumerate(tasks):
            visible = await client.get('/v1/project-agent-tasks', params=scope)
            assert visible.status_code == 200, visible.text
            current = next(item for item in visible.json() if item['task_id'] == task['task_id'])
            assert current['revision'] == task['revision'] + index
            assert current['status'] == (task['status'] if index == 0 else 'cancelled')
            assert len(current['events']) == len(task['events']) + index


async def seed_executor(client, space_id):
    """Synthetic advertised executor metadata only; no model process is launched."""
    registered = await client.put('/v1/executors', json={
        'personal_space_id': space_id, 'executor_id': 'synthetic-executor',
        'display_name': 'Synthetic executor', 'capabilities': ['coding'],
        'idempotency_key': 'synthetic-executor-register',
        'test_source': 'synthetic_activity_atomicity', 'cleanup_eligible': True,
    })
    assert registered.status_code == 200, registered.text
    authorized = await client.post('/v1/executors/authorization', json={
        'personal_space_id': space_id, 'executor_id': 'synthetic-executor',
        'status': 'authorized', 'reason': 'Authorize only synthetic test metadata.',
        'idempotency_key': 'synthetic-executor-authorize',
    })
    assert authorized.status_code == 200, authorized.text
    ready = await client.post('/v1/executors/preflight', json={
        'personal_space_id': space_id, 'executor_id': 'synthetic-executor',
        'status': 'passed', 'workspace_permission': True, 'capabilities': ['coding'],
        'available_models': [{'provider': 'synthetic', 'model': 'synthetic-model',
                              'capabilities': ['coding']}],
        'checked_at': datetime.now(UTC).isoformat(),
        'idempotency_key': 'synthetic-executor-preflight',
    })
    assert ready.status_code == 200, ready.text


def interrupt_one_audit_write(monkeypatch, stage, *, task_id=None, before_raise=None):
    from graphiti_core.driver.neo4j_driver import Neo4jDriver

    markers = {
        'observation': 'MERGE (observation:FuliProjectAgentExecutorObservation',
        'outcome': 'MERGE (evidence:FuliProjectAgentExecutorOutcomeEvidence',
        'aggregate': 'SET aggregate.aggregate_json',
    }
    execute = Neo4jDriver.execute_query
    transaction = Neo4jDriver.transaction
    fault = {'fired': False}

    async def inspect(query, parameters):
        if (not fault['fired'] and markers[stage] in query
                and (task_id is None or parameters.get('task_id') == task_id)):
            fault['fired'] = True
            if before_raise:
                await before_raise()
            raise RuntimeError('Synthetic audit persistence interruption')

    async def execute_with_fault(driver, query, **parameters):
        await inspect(query, parameters)
        return await execute(driver, query, **parameters)

    @asynccontextmanager
    async def transaction_with_fault(driver):
        async with transaction(driver) as current:
            class FaultingTransaction:
                async def run(self, query, **parameters):
                    await inspect(query, parameters)
                    return await current.run(query, **parameters)
            yield FaultingTransaction()

    monkeypatch.setattr(Neo4jDriver, 'execute_query', execute_with_fault)
    monkeypatch.setattr(Neo4jDriver, 'transaction', transaction_with_fault)
    return fault
