"""Independent evidence HTTP regressions on a disposable synthetic graph."""

import asyncio
from datetime import UTC, datetime, timedelta

import pytest

from test_project_agent_memory_neo4j import fixture_settings, provider_client, seed_agent
from test_project_agent_activity_atomicity_neo4j import interrupt_one_audit_write, seed_executor


async def evidence_setup(client, *, with_actual=False):
    space = await client.post('/v1/spaces', json={
        'name': 'Synthetic independent evidence', 'kind': 'personal',
    })
    assert space.status_code == 200, space.text
    scope = {'personal_space_id': space.json()['id'], 'personal_project_id': 'sample-project'}
    await seed_agent(client, scope['personal_space_id'])
    await seed_executor(client, scope['personal_space_id'])
    response = await client.post('/v1/project-agent-tasks', json={
        **scope, 'idempotency_key': 'synthetic-independent-evidence-task',
        'title': 'Synthetic evidence task', 'objective': 'Verify evidence contracts.',
        'work_kind': 'implementation', 'lead_agent_id': 'engineer',
        'source_application': 'codex', 'routing_reason': 'Use the synthetic engineer.',
    })
    assert response.status_code == 200, response.text
    task = response.json()['task']
    evidence = {**scope, 'task_id': task['task_id'], 'agent_id': 'engineer',
        'executor_id': 'synthetic-executor', 'work_kind': task['work_kind'],
        'model_strategy': task['effective_model_strategy'],
        'evidence_kind': 'test_passed', 'source': 'test_fact',
        'reference_ids': ['synthetic:test-result'],
        'idempotency_key': 'synthetic-independent-evidence',
        'occurred_at': datetime.now(UTC).isoformat()}
    if with_actual:
        actual = await client.post('/v1/project-agent-executor-actuals', json=actual_payload(scope, task))
        assert actual.status_code == 200, actual.text
    return scope, task, evidence


def actual_payload(scope, task, **changes):
    return {**scope, 'task_id': task['task_id'], 'agent_id': 'engineer',
        'executor_id': 'synthetic-executor', 'provider': 'synthetic', 'model': 'synthetic-model',
        'model_strategy': task['effective_model_strategy'], 'run_id': 'synthetic-latest-run',
        'idempotency_key': 'synthetic-latest-actual', 'source_application': 'codex',
        'occurred_at': datetime.now(UTC).isoformat(), **changes}


@pytest.mark.asyncio
async def test_executor_availability_ignores_stale_preflight_and_health_reports():
    async with provider_client(fixture_settings(), raise_app_exceptions=False) as (client, _):
        space = await client.post('/v1/spaces', json={
            'name': 'Synthetic ordered executor observations',
            'kind': 'personal',
        })
        assert space.status_code == 200, space.text
        space_id = space.json()['id']
        registered = await client.put('/v1/executors', json={
            'personal_space_id': space_id,
            'executor_id': 'synthetic-ordered-executor',
            'display_name': 'Synthetic ordered executor',
            'capabilities': ['coding'],
            'health_required': True,
            'idempotency_key': 'synthetic-ordered-register',
            'test_source': 'synthetic_ordered_executor',
            'cleanup_eligible': True,
        })
        assert registered.status_code == 200, registered.text
        authorized = await client.post('/v1/executors/authorization', json={
            'personal_space_id': space_id,
            'executor_id': 'synthetic-ordered-executor',
            'status': 'authorized',
            'reason': 'Authorize synthetic ordered-observation fixture.',
            'idempotency_key': 'synthetic-ordered-authorize',
        })
        assert authorized.status_code == 200, authorized.text

        newest = datetime.now(UTC)
        passed = {
            'personal_space_id': space_id,
            'executor_id': 'synthetic-ordered-executor',
            'status': 'passed',
            'workspace_permission': True,
            'capabilities': ['coding'],
            'available_models': [{
                'provider': 'synthetic',
                'model': 'synthetic-ordered-model',
                'capabilities': ['coding'],
            }],
            'checked_at': newest.isoformat(),
            'idempotency_key': 'synthetic-ordered-preflight-new',
        }
        preflight = await client.post('/v1/executors/preflight', json=passed)
        assert preflight.status_code == 200, preflight.text
        unavailable = await client.get('/v1/executors', params={
            'personal_space_id': space_id,
            'available_only': True,
        })
        assert unavailable.status_code == 200, unavailable.text
        assert unavailable.json() == []

        stale_preflight = await client.post('/v1/executors/preflight', json={
            **passed,
            'status': 'failed',
            'workspace_permission': False,
            'available_models': [],
            'reason': 'Synthetic delayed failure.',
            'checked_at': (newest - timedelta(minutes=5)).isoformat(),
            'idempotency_key': 'synthetic-ordered-preflight-old',
        })
        assert stale_preflight.status_code == 409, stale_preflight.text
        replay = await client.post('/v1/executors/preflight', json=passed)
        assert replay.status_code == 200, replay.text
        assert replay.json()['preflight_status'] == 'passed'

        healthy = {
            'personal_space_id': space_id,
            'executor_id': 'synthetic-ordered-executor',
            'status': 'healthy',
            'checked_at': newest.isoformat(),
            'idempotency_key': 'synthetic-ordered-health-new',
        }
        health = await client.post('/v1/executors/health', json=healthy)
        assert health.status_code == 200, health.text
        stale_health = await client.post('/v1/executors/health', json={
            **healthy,
            'status': 'unhealthy',
            'reason': 'Synthetic delayed health failure.',
            'checked_at': (newest - timedelta(minutes=5)).isoformat(),
            'idempotency_key': 'synthetic-ordered-health-old',
        })
        assert stale_health.status_code == 409, stale_health.text
        available = await client.get('/v1/executors', params={
            'personal_space_id': space_id,
            'available_only': True,
        })
        assert available.status_code == 200, available.text
        assert [item['executor_id'] for item in available.json()] == [
            'synthetic-ordered-executor',
        ]


@pytest.mark.asyncio
async def test_late_actual_preserves_current_projection_and_keeps_both_observations():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        scope, task, _ = await evidence_setup(client)
        latest = actual_payload(scope, task)
        first = await client.post('/v1/project-agent-executor-actuals', json=latest)
        assert first.status_code == 200, first.text
        task_path = f'/v1/project-agent-tasks/{task["task_id"]}'
        current = (await client.get(task_path, params=scope)).json()
        old = {**latest, 'run_id': 'synthetic-old-run', 'idempotency_key': 'synthetic-old-actual',
               'occurred_at': (datetime.fromisoformat(latest['occurred_at']) - timedelta(hours=1)).isoformat()}
        accepted = await client.post('/v1/project-agent-executor-actuals', json=old)
        assert accepted.status_code == 200, accepted.text
        assert (await client.get(task_path, params=scope)).json() == current
        replay = await client.post('/v1/project-agent-executor-actuals', json=old)
        assert replay.status_code == 200, replay.text
        from neo4j import AsyncGraphDatabase
        async with AsyncGraphDatabase.driver(settings.neo4j_uri,
                auth=('neo4j', settings.neo4j_password)) as driver:
            rows, _, _ = await driver.execute_query('''
                MATCH (task:FuliProjectAgentTask {personal_space_id: $space_id, task_id: $task_id})
                  -[:HAS_EXECUTOR_OBSERVATION]->(observation:FuliProjectAgentExecutorObservation)
                RETURN observation.run_id AS run_id ORDER BY run_id
                ''', space_id=scope['personal_space_id'], task_id=task['task_id'], routing_='r')
            assert [row['run_id'] for row in rows] == ['synthetic-latest-run', 'synthetic-old-run']


@pytest.mark.asyncio
async def test_legacy_actual_timestamp_is_recovered_from_its_observation():
    from neo4j import AsyncGraphDatabase
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        scope, task, _ = await evidence_setup(client)
        latest = actual_payload(scope, task)
        assert (await client.post('/v1/project-agent-executor-actuals', json=latest)).status_code == 200
        # Simulate the pre-migration shape only inside this disposable fixture.
        async with AsyncGraphDatabase.driver(settings.neo4j_uri,
                auth=('neo4j', settings.neo4j_password)) as driver:
            await driver.execute_query('''
                MATCH (task:FuliProjectAgentTask {personal_space_id: $space_id, task_id: $task_id})
                REMOVE task.actual_occurred_at
                ''', space_id=scope['personal_space_id'], task_id=task['task_id'])
        path = f'/v1/project-agent-tasks/{task["task_id"]}'
        current = (await client.get(path, params=scope)).json()
        old = {**latest, 'run_id': 'synthetic-legacy-old', 'idempotency_key': 'synthetic-legacy-old',
               'occurred_at': (datetime.fromisoformat(latest['occurred_at']) - timedelta(hours=1)).isoformat()}
        assert (await client.post('/v1/project-agent-executor-actuals', json=old)).status_code == 200
        assert (await client.get(path, params=scope)).json() == current
        newer = {**latest, 'run_id': 'synthetic-legacy-new', 'idempotency_key': 'synthetic-legacy-new',
                 'occurred_at': (datetime.fromisoformat(latest['occurred_at']) + timedelta(seconds=1)).isoformat()}
        assert (await client.post('/v1/project-agent-executor-actuals', json=newer)).status_code == 200
        assert (await client.get(path, params=scope)).json()['actual_run_id'] == newer['run_id']


@pytest.mark.asyncio
@pytest.mark.parametrize('legacy_shape', ['projection_without_run', 'local_observation_time'])
async def test_legacy_actual_without_comparable_time_preserves_current_projection(legacy_shape):
    from neo4j import AsyncGraphDatabase
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        scope, task, _ = await evidence_setup(client)
        if legacy_shape == 'local_observation_time':
            first = actual_payload(scope, task)
            assert (await client.post('/v1/project-agent-executor-actuals', json=first)).status_code == 200
        async with AsyncGraphDatabase.driver(settings.neo4j_uri,
                auth=('neo4j', settings.neo4j_password)) as driver:
            if legacy_shape == 'projection_without_run':
                await driver.execute_query('''
                    MATCH (task:FuliProjectAgentTask {personal_space_id: $space_id, task_id: $task_id})
                    SET task.actual_executor_id = 'legacy-executor',
                        task.actual_model_provider = 'legacy-provider', task.actual_model = 'legacy-model'
                    REMOVE task.actual_run_id, task.actual_occurred_at
                    ''', space_id=scope['personal_space_id'], task_id=task['task_id'])
            else:
                await driver.execute_query('''
                    MATCH (task:FuliProjectAgentTask {personal_space_id: $space_id, task_id: $task_id})
                          -[:HAS_EXECUTOR_OBSERVATION]->(observation {run_id: task.actual_run_id})
                    REMOVE task.actual_occurred_at
                    SET observation.occurred_at = localdatetime('2026-08-01T12:00:00')
                    ''', space_id=scope['personal_space_id'], task_id=task['task_id'])
        path = f'/v1/project-agent-tasks/{task["task_id"]}'
        before = (await client.get(path, params=scope)).json()
        new = actual_payload(scope, task, run_id='synthetic-after-legacy',
                             idempotency_key='synthetic-after-legacy')
        accepted = await client.post('/v1/project-agent-executor-actuals', json=new)
        assert accepted.status_code == 200, accepted.text
        assert (await client.get(path, params=scope)).json() == before
        async with AsyncGraphDatabase.driver(settings.neo4j_uri,
                auth=('neo4j', settings.neo4j_password)) as driver:
            rows, _, _ = await driver.execute_query('''
                MATCH (task:FuliProjectAgentTask {personal_space_id: $space_id, task_id: $task_id})
                      -[:HAS_EXECUTOR_OBSERVATION]->(observation)
                RETURN count(observation) AS count
                ''', space_id=scope['personal_space_id'], task_id=task['task_id'], routing_='r')
            assert rows[0]['count'] == (1 if legacy_shape == 'projection_without_run' else 2)


@pytest.mark.asyncio
async def test_same_run_unapplied_observations_do_not_repair_missing_legacy_baseline():
    from neo4j import AsyncGraphDatabase
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        scope, task, _ = await evidence_setup(client)
        original = actual_payload(scope, task)
        async with AsyncGraphDatabase.driver(settings.neo4j_uri,
                auth=('neo4j', settings.neo4j_password)) as driver:
            await driver.execute_query('''
                MATCH (task:FuliProjectAgentTask {personal_space_id: $space_id, task_id: $task_id})
                SET task.actual_executor_id = $executor_id,
                    task.actual_run_id = $run_id,
                    task.actual_model_provider = $provider,
                    task.actual_model = $model,
                    task.matched_executor_rule_id = 'legacy-rule',
                    task.executor_fallback_reason = 'Legacy projection has no comparable baseline.'
                REMOVE task.actual_occurred_at
                ''', space_id=scope['personal_space_id'], task_id=task['task_id'],
                executor_id=original['executor_id'], run_id=original['run_id'],
                provider=original['provider'], model=original['model'])
        path = f'/v1/project-agent-tasks/{task["task_id"]}'
        before = (await client.get(path, params=scope)).json()
        first_unapplied = {**original,
            'idempotency_key': 'synthetic-same-run-unapplied-one',
            'occurred_at': '2026-08-01T13:00:00+00:00'}
        accepted = await client.post('/v1/project-agent-executor-actuals', json=first_unapplied)
        assert accepted.status_code == 200, accepted.text
        assert (await client.get(path, params=scope)).json() == before
        second_unapplied = {**original,
            'idempotency_key': 'synthetic-same-run-unapplied-two',
            'occurred_at': '2026-08-01T14:00:00+00:00'}
        accepted = await client.post('/v1/project-agent-executor-actuals', json=second_unapplied)
        assert accepted.status_code == 200, accepted.text
        assert (await client.get(path, params=scope)).json() == before
        async with AsyncGraphDatabase.driver(settings.neo4j_uri,
                auth=('neo4j', settings.neo4j_password)) as driver:
            rows, _, _ = await driver.execute_query('''
                MATCH (task:FuliProjectAgentTask {personal_space_id: $space_id, task_id: $task_id})
                      -[:HAS_EXECUTOR_OBSERVATION]->(observation {run_id: $run_id})
                RETURN task.actual_occurred_at AS actual_occurred_at,
                       task.matched_executor_rule_id AS matched_rule_id,
                       collect(observation.projection_considered) AS considered,
                       collect(observation.projection_applied) AS applied
                ''', space_id=scope['personal_space_id'], task_id=task['task_id'],
                run_id=original['run_id'], routing_='r')
            assert rows[0]['actual_occurred_at'] is None
            assert rows[0]['matched_rule_id'] == 'legacy-rule'
            assert rows[0]['considered'] == [True, True]
            assert rows[0]['applied'] == []


@pytest.mark.asyncio
async def test_activity_keeps_newer_actual_projection_while_adding_its_own_history():
    async with provider_client(fixture_settings(), raise_app_exceptions=False) as (client, _):
        scope, task, _ = await evidence_setup(client)
        latest = actual_payload(scope, task,
            occurred_at=(datetime.now(UTC) + timedelta(minutes=1)).isoformat(),
            matched_rule_id='synthetic-newer-rule', fallback_reason='Synthetic newer reason.')
        assert (await client.post('/v1/project-agent-executor-actuals', json=latest)).status_code == 200
        path = f'/v1/project-agent-tasks/{task["task_id"]}'
        before = (await client.get(path, params=scope)).json()
        running = await client.post(f'{path}/events', json={
            **scope, 'task_id': task['task_id'], 'agent_id': 'engineer',
            'idempotency_key': 'synthetic-older-running-event', 'status': 'running',
            'summary': 'Synthetic current event older than observed future clock.',
            'source_application': 'codex', 'actual_executor_id': 'synthetic-executor',
            'actual_model_provider': 'synthetic', 'actual_model': 'synthetic-model',
            'matched_executor_rule_id': 'synthetic-older-rule',
            'executor_fallback_reason': 'Synthetic older reason.',
        })
        assert running.status_code == 200, running.text
        current = running.json()
        assert current['status'] == 'running'
        for key in ('actual_run_id', 'actual_executor_id', 'actual_model_provider',
                    'actual_model', 'matched_executor_rule_id', 'executor_fallback_reason', 'updated_at'):
            assert current[key] == before[key], key


@pytest.mark.asyncio
async def test_naive_actual_and_reset_times_are_rejected_without_writes():
    settings = fixture_settings()
    async with provider_client(settings, raise_app_exceptions=False) as (client, _):
        scope, task, evidence = await evidence_setup(client)
        invalid_actual = await client.post('/v1/project-agent-executor-actuals',
            json=actual_payload(scope, task, occurred_at='2026-08-01T12:00:00'))
        assert invalid_actual.status_code == 422, invalid_actual.text
        invalid_reset = await client.post('/v1/project-agent-routing-learning/reset', json={
            **{key: evidence[key] for key in ('personal_space_id', 'personal_project_id',
                'agent_id', 'executor_id', 'work_kind', 'model_strategy')},
            'reset_at': '2026-08-01T12:00:00', 'reason': 'Synthetic timezone test.',
            'idempotency_key': 'synthetic-naive-reset',
        })
        assert invalid_reset.status_code == 422, invalid_reset.text
        current = (await client.get(f'/v1/project-agent-tasks/{task["task_id"]}', params=scope)).json()
        assert current['actual_executor_id'] is None
        assert await learning_snapshot(settings, scope) == []


@pytest.mark.asyncio
async def test_independent_actual_respects_the_agent_client_allow_list():
    async with provider_client(fixture_settings(), raise_app_exceptions=False) as (client, _):
        scope, task, _ = await evidence_setup(client)
        await seed_agent(client, scope['personal_space_id'], allowed_clients=['codex'])
        response = await client.post('/v1/project-agent-executor-actuals',
            json=actual_payload(scope, task, source_application='cursor'))
        assert response.status_code == 403, response.text
        current = (await client.get(f'/v1/project-agent-tasks/{task["task_id"]}', params=scope)).json()
        assert current['actual_executor_id'] is None
        accepted = await client.post('/v1/project-agent-executor-actuals',
            json=actual_payload(scope, task))
        assert accepted.status_code == 200, accepted.text


@pytest.mark.asyncio
async def test_actual_validation_and_permission_revocation_are_serialized(monkeypatch):
    from graphiti_core.driver.neo4j_driver import Neo4jDriver
    from fuli_graph.store_transactions import TransactionQueryDriver
    async with provider_client(fixture_settings(), raise_app_exceptions=False) as (client, _):
        scope, task, _ = await evidence_setup(client)
        paused, release = asyncio.Event(), asyncio.Event()
        fired = False

        def wrapper(execute):
            async def intercepted(driver, query, **parameters):
                nonlocal fired
                result = await execute(driver, query, **parameters)
                if not fired and 'RETURN task, agent, executor, permission' in query:
                    fired = True
                    paused.set()
                    await asyncio.wait_for(release.wait(), 10)
                return result
            return intercepted

        for driver in [Neo4jDriver, TransactionQueryDriver]:
            monkeypatch.setattr(driver, 'execute_query', wrapper(driver.execute_query))
        report = asyncio.create_task(client.post('/v1/project-agent-executor-actuals',
            json=actual_payload(scope, task)))
        revoke = None
        try:
            await asyncio.wait_for(paused.wait(), 10)
            revoke = asyncio.create_task(client.post('/v1/executors/authorization', json={
                'personal_space_id': scope['personal_space_id'], 'executor_id': 'synthetic-executor',
                'status': 'revoked', 'reason': 'Synthetic concurrent revocation.',
                'idempotency_key': 'synthetic-concurrent-revoke',
            }))
            done, _ = await asyncio.wait([revoke], timeout=0.5)
            revoked_before_report = bool(done)
        finally:
            release.set()
            actual = await asyncio.wait_for(report, 10)
            revoked = await asyncio.wait_for(revoke, 10) if revoke else None
        assert revoked is not None and revoked.status_code == 200
        assert actual.status_code == (409 if revoked_before_report else 200), actual.text


@pytest.mark.asyncio
async def test_revocation_committed_first_rejects_actual_without_history():
    settings = fixture_settings()
    async with provider_client(settings, raise_app_exceptions=False) as (client, _):
        scope, task, _ = await evidence_setup(client)
        revoke = await client.post('/v1/executors/authorization', json={
            'personal_space_id': scope['personal_space_id'], 'executor_id': 'synthetic-executor',
            'status': 'revoked', 'reason': 'Synthetic revocation before report.',
            'idempotency_key': 'synthetic-first-revoke',
        })
        assert revoke.status_code == 200, revoke.text
        actual = await client.post('/v1/project-agent-executor-actuals', json=actual_payload(scope, task))
        assert actual.status_code == 409, actual.text
        from neo4j import AsyncGraphDatabase
        async with AsyncGraphDatabase.driver(settings.neo4j_uri,
                auth=('neo4j', settings.neo4j_password)) as driver:
            rows, _, _ = await driver.execute_query('''
                MATCH (task:FuliProjectAgentTask {personal_space_id: $space_id, task_id: $task_id})
                OPTIONAL MATCH (task)-[:HAS_EXECUTOR_OBSERVATION]->(observation)
                RETURN task.actual_executor_id AS actual, count(observation) AS observations
                ''', space_id=scope['personal_space_id'], task_id=task['task_id'], routing_='r')
            assert rows[0]['actual'] is None and rows[0]['observations'] == 0


@pytest.mark.asyncio
async def test_ignore_idempotency_rejects_changed_reason_without_overwriting():
    async with provider_client(fixture_settings(), raise_app_exceptions=False) as (client, _):
        scope, _, payload = await evidence_setup(client, with_actual=True)
        created = await client.post('/v1/project-agent-routing-outcomes', json=payload)
        assert created.status_code == 200, created.text
        ignore = {**scope, 'agent_id': 'engineer', 'evidence_id': created.json()['evidence_id'],
                  'idempotency_key': 'synthetic-ignore-evidence', 'reason': 'Synthetic first reason.'}
        first = await client.post('/v1/project-agent-routing-learning/ignore', json=ignore)
        assert first.status_code == 200, first.text
        conflicting = await client.post('/v1/project-agent-routing-learning/ignore', json={
            **ignore, 'reason': 'Synthetic conflicting reason.',
        })
        assert conflicting.status_code == 409, conflicting.text
        replay = await client.post('/v1/project-agent-routing-learning/ignore', json=ignore)
        assert replay.status_code == 200, replay.text
        assert replay.json() == first.json()


@pytest.mark.asyncio
async def test_naive_outcome_time_is_rejected_before_it_can_poison_learning():
    async with provider_client(fixture_settings(), raise_app_exceptions=False) as (client, _):
        scope, _, payload = await evidence_setup(client, with_actual=True)
        invalid = await client.post('/v1/project-agent-routing-outcomes', json={
            **payload, 'occurred_at': '2026-08-01T12:00:00',
        })
        assert invalid.status_code == 422, invalid.text
        corrected = await client.post('/v1/project-agent-routing-outcomes', json=payload)
        assert corrected.status_code == 200, corrected.text
        learning = await client.get('/v1/project-agent-routing-learning', params=scope)
        assert learning.status_code == 200, learning.text
        assert len(learning.json()) == 1
        assert learning.json()[0]['sample_count'] == 1


async def learning_snapshot(settings, scope):
    """Read only the exact synthetic space; never inspect a daily database."""
    from neo4j import AsyncGraphDatabase
    async with AsyncGraphDatabase.driver(settings.neo4j_uri,
            auth=('neo4j', settings.neo4j_password)) as driver:
        rows, _, _ = await driver.execute_query('''
            MATCH (node {personal_space_id: $space_id})
            WHERE node:FuliProjectAgentExecutorOutcomeEvidence
               OR node:FuliProjectAgentExecutorOutcomeAggregate
               OR node:FuliProjectAgentExecutorOutcomeReset
            RETURN properties(node) AS node ORDER BY node.id
            ''', space_id=scope['personal_space_id'], routing_='r')
        return [dict(row['node']) for row in rows]


@pytest.mark.asyncio
@pytest.mark.parametrize('operation', ['record', 'ignore', 'reset'])
async def test_independent_learning_mutation_rolls_back_when_aggregate_fails(monkeypatch, operation):
    settings = fixture_settings()
    async with provider_client(settings, raise_app_exceptions=False) as (client, _):
        scope, _, payload = await evidence_setup(client, with_actual=True)
        path = '/v1/project-agent-routing-outcomes'
        request = payload
        if operation != 'record':
            created = await client.post(path, json=payload)
            assert created.status_code == 200, created.text
            if operation == 'ignore':
                path = '/v1/project-agent-routing-learning/ignore'
                request = {**scope, 'agent_id': 'engineer',
                    'evidence_id': created.json()['evidence_id'],
                    'idempotency_key': 'synthetic-atomic-ignore', 'reason': 'Synthetic ignored sample.'}
            else:
                path = '/v1/project-agent-routing-learning/reset'
                request = {**scope, 'agent_id': 'engineer', 'executor_id': 'synthetic-executor',
                    'work_kind': payload['work_kind'], 'model_strategy': payload['model_strategy'],
                    'idempotency_key': 'synthetic-atomic-reset', 'reason': 'Synthetic reset.',
                    'reset_at': datetime.now(UTC).isoformat()}
        before = await learning_snapshot(settings, scope)
        fault = interrupt_one_audit_write(monkeypatch, 'aggregate')
        failed = await client.post(path, json=request)
        assert fault['fired'] and failed.status_code == 500, failed.text
        assert await learning_snapshot(settings, scope) == before
        retry = await client.post(path, json=request)
        assert retry.status_code == 200, retry.text
        learning = await client.get('/v1/project-agent-routing-learning', params=scope)
        assert learning.status_code == 200, learning.text
        assert learning.json()[0]['sample_count'] == (1 if operation == 'record' else 0)


@pytest.mark.asyncio
async def test_concurrent_learning_writes_cannot_publish_an_older_evidence_snapshot(monkeypatch):
    from graphiti_core.driver.neo4j_driver import Neo4jDriver
    from fuli_graph.store_transactions import TransactionQueryDriver
    async with provider_client(fixture_settings(), raise_app_exceptions=False) as (client, _):
        scope, _, payload = await evidence_setup(client, with_actual=True)
        other_task = await client.post('/v1/project-agent-tasks', json={
            **scope, 'idempotency_key': 'synthetic-independent-task-two',
            'title': 'Synthetic second task', 'objective': 'Share one learning bucket.',
            'work_kind': 'implementation', 'lead_agent_id': 'engineer',
            'source_application': 'codex', 'routing_reason': 'Use the synthetic engineer.',
        })
        assert other_task.status_code == 200, other_task.text
        other_actual = await client.post('/v1/project-agent-executor-actuals',
            json=actual_payload(scope, other_task.json()['task']))
        assert other_actual.status_code == 200, other_actual.text
        paused = asyncio.Event()
        release = asyncio.Event()
        fired = False

        def wrapper(execute):
            async def intercepted(driver, query, **parameters):
                nonlocal fired
                result = await execute(driver, query, **parameters)
                if (not fired and 'MATCH (evidence:FuliProjectAgentExecutorOutcomeEvidence' in query
                        and 'RETURN evidence' in query and 'MERGE' not in query
                        and parameters.get('personal_space_id') == scope['personal_space_id']):
                    fired = True
                    paused.set()
                    await asyncio.wait_for(release.wait(), 10)
                return result
            return intercepted

        for driver in [Neo4jDriver, TransactionQueryDriver]:
            monkeypatch.setattr(driver, 'execute_query', wrapper(driver.execute_query))
        path = '/v1/project-agent-routing-outcomes'
        first = asyncio.create_task(client.post(path, json=payload))
        second = None
        try:
            await asyncio.wait_for(paused.wait(), 10)
            second = asyncio.create_task(client.post(path, json={
                **payload, 'idempotency_key': 'synthetic-independent-evidence-two',
                'task_id': other_task.json()['task']['task_id'],
                'reference_ids': ['synthetic:test-result-two'],
            }))
            done, _ = await asyncio.wait([second], timeout=0.5)
            second_waited = not done
        finally:
            release.set()
            first_result = await first
            second_result = await second if second else None
        assert first_result.status_code == 200, first_result.text
        assert second_result is not None and second_result.status_code == 200
        assert second_waited, 'same-bucket mutation must wait for the active snapshot transaction'
        learning = await client.get('/v1/project-agent-routing-learning', params=scope)
        assert learning.status_code == 200, learning.text
        assert learning.json()[0]['sample_count'] == 2


@pytest.mark.asyncio
@pytest.mark.parametrize('mismatch', ['agent', 'executor', 'work_kind', 'strategy', 'run', 'no_actual'])
async def test_outcome_cannot_credit_an_unrelated_execution(mismatch):
    settings = fixture_settings()
    async with provider_client(settings, raise_app_exceptions=False) as (client, _):
        scope, _, payload = await evidence_setup(client, with_actual=mismatch != 'no_actual')
        changes = {
            'agent': {'agent_id': 'unrelated-synthetic-agent'},
            'executor': {'executor_id': 'unrelated-synthetic-executor'},
            'work_kind': {'work_kind': 'unrelated-work'},
            'strategy': {'model_strategy': {'mode': 'fast'}},
            'run': {'run_id': 'unrelated-synthetic-run'}, 'no_actual': {},
        }
        rejected = await client.post('/v1/project-agent-routing-outcomes', json={**payload, **changes[mismatch]})
        assert rejected.status_code == 409, rejected.text
        assert await learning_snapshot(settings, scope) == []


@pytest.mark.asyncio
async def test_claimed_terminal_outcome_requires_a_matching_persisted_event():
    settings = fixture_settings()
    async with provider_client(settings, raise_app_exceptions=False) as (client, _):
        scope, _, payload = await evidence_setup(client, with_actual=True)
        rejected = await client.post('/v1/project-agent-routing-outcomes', json={
            **payload, 'source': 'system_terminal', 'evidence_kind': 'terminal_outcome',
            'terminal_outcome': 'completed', 'run_id': 'synthetic-latest-run',
            'reference_ids': ['synthetic-latest-run'],
        })
        assert rejected.status_code == 409, rejected.text
        assert await learning_snapshot(settings, scope) == []


@pytest.mark.asyncio
async def test_explicit_feedback_without_run_can_reference_a_task_execution():
    async with provider_client(fixture_settings(), raise_app_exceptions=False) as (client, _):
        scope, _, payload = await evidence_setup(client, with_actual=True)
        feedback = {**payload, 'source': 'user_explicit', 'evidence_kind': 'explicit_rating',
                    'rating': 4, 'reference_ids': [], 'note': 'Synthetic explicit feedback fixture.'}
        accepted = await client.post('/v1/project-agent-routing-outcomes', json=feedback)
        assert accepted.status_code == 200, accepted.text
        learning = await client.get('/v1/project-agent-routing-learning', params=scope)
        assert learning.json()[0]['rating_count'] == 1


@pytest.mark.asyncio
async def test_terminal_evidence_cannot_be_counted_again_with_a_new_client_key():
    async with provider_client(fixture_settings(), raise_app_exceptions=False) as (client, _):
        scope, task, _ = await evidence_setup(client)
        terminal = await client.post(f'/v1/project-agent-tasks/{task["task_id"]}/events', json={
            **scope, 'task_id': task['task_id'], 'agent_id': 'engineer',
            'idempotency_key': 'synthetic-canonical-terminal', 'status': 'cancelled',
            'summary': 'Synthetic terminal evidence deduplication.', 'source_application': 'codex',
            'actual_executor_id': 'synthetic-executor', 'actual_model_provider': 'synthetic',
            'actual_model': 'synthetic-model',
        })
        assert terminal.status_code == 200, terminal.text
        event = terminal.json()['events'][-1]
        assert event['status'] == 'cancelled'
        payload = {**scope, 'task_id': task['task_id'], 'agent_id': 'engineer',
            'executor_id': 'synthetic-executor', 'work_kind': task['work_kind'],
            'model_strategy': task['effective_model_strategy'],
            'evidence_kind': 'terminal_outcome', 'source': 'system_terminal',
            'terminal_outcome': 'cancelled', 'run_id': event['event_id'],
            'reference_ids': [event['event_id']], 'occurred_at': event['created_at'],
            'idempotency_key': f'terminal:{event["event_id"]}'}
        replay = await client.post('/v1/project-agent-routing-outcomes', json=payload)
        assert replay.status_code == 200, replay.text
        changed = await client.post('/v1/project-agent-routing-outcomes', json={
            **payload, 'idempotency_key': 'synthetic-forged-duplicate-terminal'})
        assert changed.status_code == 409, changed.text
        assert (await client.get('/v1/project-agent-routing-learning', params=scope)).json()[0]['sample_count'] == 1


@pytest.mark.asyncio
@pytest.mark.parametrize('incompatible', ['mode', 'effort', 'capability'])
async def test_actual_reported_model_itself_must_satisfy_task_strategy(incompatible):
    async with provider_client(fixture_settings(), raise_app_exceptions=False) as (client, _):
        scope, _, _ = await evidence_setup(client)
        strategy = {'mode': 'deep', 'reasoning_effort': 'high', 'capability_hints': ['coding']}
        valid = {'provider': 'synthetic', 'model': 'synthetic-capable-model',
            'available': True, 'strategy_modes': ['deep'], 'reasoning_efforts': ['high'],
            'capabilities': ['coding']}
        invalid = {**valid, 'model': 'synthetic-incompatible-model', **{
            'mode': {'strategy_modes': ['fast']}, 'effort': {'reasoning_efforts': ['low']},
            'capability': {'capabilities': ['unrelated']},
        }[incompatible]}
        preflight = await client.post('/v1/executors/preflight', json={
            'personal_space_id': scope['personal_space_id'], 'executor_id': 'synthetic-executor',
            'status': 'passed', 'workspace_permission': True, 'capabilities': ['coding'],
            'available_models': [invalid, valid], 'reason': 'Synthetic multiple-model fixture.',
            'checked_at': datetime.now(UTC).isoformat(), 'idempotency_key': 'synthetic-multi-model-preflight',
        })
        assert preflight.status_code == 200, preflight.text
        created = await client.post('/v1/project-agent-tasks', json={
            **scope, 'idempotency_key': 'synthetic-deep-strategy-task',
            'title': 'Synthetic deep task', 'objective': 'Check the actually reported model.',
            'work_kind': 'implementation', 'lead_agent_id': 'engineer',
            'source_application': 'codex', 'routing_reason': 'Use the synthetic engineer.',
            'model_strategy_override': strategy,
        })
        assert created.status_code == 200, created.text
        task = created.json()['task']
        assert task['effective_model_strategy'] == strategy
        assert task['selected_executor_id'] == 'synthetic-executor'
        payload = actual_payload(scope, task, model=invalid['model'])
        rejected = await client.post('/v1/project-agent-executor-actuals', json=payload)
        assert rejected.status_code == 409, rejected.text
        accepted = await client.post('/v1/project-agent-executor-actuals', json={**payload, 'model': valid['model']})
        assert accepted.status_code == 200, accepted.text


@pytest.mark.asyncio
async def test_independent_actual_failure_after_observation_write_rolls_back(monkeypatch):
    from graphiti_core.driver.neo4j_driver import Neo4jDriver
    from fuli_graph.store_transactions import TransactionQueryDriver
    from neo4j import AsyncGraphDatabase
    settings = fixture_settings()
    async with provider_client(settings, raise_app_exceptions=False) as (client, _):
        scope, task, _ = await evidence_setup(client)
        fired = False

        def wrapper(execute):
            async def interrupted(driver, query, **parameters):
                nonlocal fired
                result = await execute(driver, query, **parameters)
                if not fired and 'MERGE (observation:FuliProjectAgentExecutorObservation' in query:
                    fired = True
                    raise RuntimeError('Synthetic failure after observation write.')
                return result
            return interrupted

        for driver in [Neo4jDriver, TransactionQueryDriver]:
            monkeypatch.setattr(driver, 'execute_query', wrapper(driver.execute_query))
        payload = actual_payload(scope, task)
        failed = await client.post('/v1/project-agent-executor-actuals', json=payload)
        assert fired and failed.status_code == 500, failed.text
        assert (await client.get(f'/v1/project-agent-tasks/{task["task_id"]}', params=scope)).json()['actual_run_id'] is None
        async with AsyncGraphDatabase.driver(settings.neo4j_uri,
                auth=('neo4j', settings.neo4j_password)) as driver:
            rows, _, _ = await driver.execute_query('''
                MATCH (observation:FuliProjectAgentExecutorObservation {task_id: $task_id})
                RETURN count(observation) AS count
                ''', task_id=task['task_id'], routing_='r')
            assert rows[0]['count'] == 0
        retried = await client.post('/v1/project-agent-executor-actuals', json=payload)
        assert retried.status_code == 200, retried.text


@pytest.mark.asyncio
async def test_legacy_unknown_timezone_evidence_can_be_ignored_without_guessing_time():
    from neo4j import AsyncGraphDatabase
    settings = fixture_settings()
    async with provider_client(settings, raise_app_exceptions=False) as (client, _):
        scope, _, payload = await evidence_setup(client, with_actual=True)
        ids = []
        for index in range(2):
            response = await client.post('/v1/project-agent-routing-outcomes', json={
                **payload, 'idempotency_key': f'synthetic-legacy-time-{index}'})
            assert response.status_code == 200, response.text
            ids.append(response.json()['evidence_id'])
        # Reproduce values accepted by the older datetime-only request model.
        async with AsyncGraphDatabase.driver(settings.neo4j_uri,
                auth=('neo4j', settings.neo4j_password)) as driver:
            await driver.execute_query('''
                MATCH (evidence:FuliProjectAgentExecutorOutcomeEvidence {personal_space_id: $space_id})
                SET evidence.occurred_at = localdatetime('2026-08-01T12:00:00')
                ''', space_id=scope['personal_space_id'])
        valid = await client.post('/v1/project-agent-routing-outcomes', json={
            **payload, 'idempotency_key': 'synthetic-after-legacy-times'})
        assert valid.status_code == 200, valid.text
        bucket = (await client.get('/v1/project-agent-routing-learning', params=scope)).json()[0]
        assert bucket['ignored'] and bucket['neutral_due_to_insufficient_evidence']
        assert bucket['validation_warnings']
        for index, evidence_id in enumerate(ids):
            ignored = await client.post('/v1/project-agent-routing-learning/ignore', json={
                **scope, 'agent_id': 'engineer', 'evidence_id': evidence_id,
                'idempotency_key': f'synthetic-ignore-legacy-{index}',
                'reason': 'Synthetic evidence with unknown original timezone.',
            })
            assert ignored.status_code == 200, ignored.text
        bucket = (await client.get('/v1/project-agent-routing-learning', params=scope)).json()[0]
        assert bucket['sample_count'] == 1 and not bucket['ignored']
        assert bucket['validation_warnings'] == []


@pytest.mark.asyncio
async def test_legacy_unknown_timezone_reset_is_neutral_and_can_be_replaced():
    from neo4j import AsyncGraphDatabase
    settings = fixture_settings()
    async with provider_client(settings, raise_app_exceptions=False) as (client, _):
        scope, _, payload = await evidence_setup(client, with_actual=True)
        reset = {**{key: payload[key] for key in ('personal_space_id', 'personal_project_id',
                 'work_kind', 'agent_id', 'executor_id', 'model_strategy')},
                 'idempotency_key': 'synthetic-reset-before-legacy', 'reason': 'Synthetic reset fixture.',
                 'reset_at': (datetime.now(UTC) - timedelta(days=1)).isoformat()}
        assert (await client.post('/v1/project-agent-routing-learning/reset', json=reset)).status_code == 200
        async with AsyncGraphDatabase.driver(settings.neo4j_uri,
                auth=('neo4j', settings.neo4j_password)) as driver:
            await driver.execute_query('''
                MATCH (reset:FuliProjectAgentExecutorOutcomeReset {personal_space_id: $space_id})
                SET reset.reset_at = localdatetime('2026-08-01T12:00:00')
                ''', space_id=scope['personal_space_id'])
        written = await client.post('/v1/project-agent-routing-outcomes', json=payload)
        assert written.status_code == 200, written.text
        bucket = (await client.get('/v1/project-agent-routing-learning', params=scope)).json()[0]
        assert bucket['validation_warnings'] == ['reset_timestamp_timezone_missing']
        assert bucket['ignored'] and bucket['weighted_success'] == 0
        replaced = await client.post('/v1/project-agent-routing-learning/reset', json={
            **reset, 'reset_at': datetime.now(UTC).isoformat(),
            'idempotency_key': 'synthetic-replace-legacy-reset',
        })
        assert replaced.status_code == 200, replaced.text
        assert replaced.json()['validation_warnings'] == []
        assert replaced.json()['sample_count'] == 0
