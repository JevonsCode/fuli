"""Execution facts stay separate from admission and business acceptance."""
import json
from datetime import UTC, datetime

import pytest
from pydantic import ValidationError

from fuli_graph import project_agent_worker_models as models
from fuli_graph.store_project_agent_worker_runs import worker_run_view


def raw_run(**changes):
    return {'id': 'run', 'state': 'closed', 'provider': 'synthetic', 'model': 'requested',
            'model_strategy_json': json.dumps({'mode': 'deep'}),
            'created_at': datetime.now(UTC), **changes}


def test_legacy_closed_run_does_not_invent_a_successful_execution():
    view = worker_run_view(raw_run(close_reason='worker_checkpoint_completed'))
    assert view.get('execution_status') == 'unknown'
    assert view.get('execution_result') is None
    assert view.get('close_reason') == 'worker_checkpoint_completed'
    assert view.get('prompt_dispatched_at') is None
    assert view.get('attempt_number') is None
    assert worker_run_view(raw_run(execution_status='running'))['execution_status'] == 'unknown'
    assert worker_run_view(raw_run(close_reason='worker_' + 'a' * 64))['close_reason'] is None
    assert worker_run_view(raw_run(close_reason='Legacy diagnostic with synthetic private capability'))['close_reason'] is None


def test_execution_result_is_bounded_and_does_not_accept_arbitrary_error_text():
    result_type = getattr(models, 'WorkerRunResult', None)
    assert result_type is not None, 'host terminal execution result contract is missing'
    result = dict(personal_space_id='space', personal_project_id='project',
                  status='failed', code='worker_connection_closed', stage='configure',
                  prompt_dispatched=False, process_stopped=True, run_closed=True,
                  terminal_recorded=True, cleanup_errors=[])
    assert result_type(**result).status == 'failed'
    for changes in [dict(code='raw error with secret'), dict(status='done'),
                    dict(stage='arbitrary'), dict(cleanup_errors=['raw sensitive error']),
                    dict(actual_model='requested-model'), dict(prompt_dispatched='false')]:
        with pytest.raises(ValidationError):
            result_type(**{**result, **changes})


def test_retry_policy_requires_positive_pre_prompt_cleanup_facts_and_never_retries_timeouts():
    from fuli_graph import store_project_agent_worker_runs as module
    classify = getattr(module, 'execution_result_fields', None)
    assert callable(classify), 'durable failure classification is missing'
    base = dict(personal_space_id='space', personal_project_id='project', status='failed',
                code='worker_connection_closed', stage='configure', prompt_dispatched=False,
                process_stopped=True, run_closed=True, terminal_recorded=True, cleanup_errors=[])
    run = raw_run(attempt_number=1, root_run_id='run')
    assert classify(models.WorkerRunResult(**base), run)['retry_eligible'] is True
    for changes in [dict(prompt_dispatched=True), dict(process_stopped=False), dict(run_closed=False),
                    dict(cleanup_errors=['worker_lease_release_failed']), dict(code='worker_timeout'),
                    dict(code='worker_authentication_required'), dict(code='worker_transport_failed'),
                    dict(code='worker_authority_unavailable'), dict(status='cancelled')]:
        assert classify(models.WorkerRunResult(**{**base, **changes}), run)['retry_eligible'] is False
    assert classify(models.WorkerRunResult(**base), raw_run())['retry_eligible'] is False
    assert classify(models.WorkerRunResult(**base), {**run, 'attempt_number': 3})['retry_eligible'] is False
    regular = models.WorkerRunResult(**{**base, 'code': 'worker_runtime_offline'})
    assert classify(regular, run)['attempt_limit'] == 2
    assert classify(regular, {**run, 'attempt_number': 2})['retry_eligible'] is False


def test_network_final_backoff_is_five_seconds_and_is_not_applied_to_the_first_retry(monkeypatch):
    from fuli_graph import worker_run_execution as policy
    fixed = datetime(2026, 10, 19, tzinfo=UTC)
    monkeypatch.setattr(policy, 'now_utc', lambda: fixed)
    result = models.WorkerRunResult(personal_space_id='space', personal_project_id='project',
        status='failed', code='worker_connection_closed', stage='configure', prompt_dispatched=False,
        process_stopped=True, run_closed=True, terminal_recorded=True, cleanup_errors=[])
    assert policy.execution_result_fields(result, raw_run(attempt_number=1))['retry_not_before'] == fixed.isoformat()
    final = policy.execution_result_fields(result, raw_run(attempt_number=2, retry_limit=3))
    assert (datetime.fromisoformat(final['retry_not_before']) - fixed).total_seconds() == 5


@pytest.mark.asyncio
async def test_task_run_history_preserves_task_and_empty_legacy_history():
    from test_project_agent_memory_neo4j import fixture_settings, provider_client
    from test_agent_delegations_neo4j import worker_run_fixture
    async with provider_client(fixture_settings()) as (client, _):
        scope, payload, headers = await worker_run_fixture(client)
        path = f'/v1/project-agent-tasks/{payload["task_id"]}'
        before = (await client.get(path, params=scope)).json()
        empty = await client.get(path + '/runs', params=scope)
        assert empty.status_code == 200, empty.text
        assert empty.json() == {'runs': [], 'next_cursor': None, 'complete': True}
        ids = []
        for index in range(2):
            from hashlib import sha256
            secret = headers['x-fuli-worker-capability'] + str(index)
            response = await client.put('/v1/project-agent-worker-runs', json={
                **payload, 'idempotency_key': f'history-attempt-{index}',
                'worker_id': f'history-worker-{index}',
                'runtime_capability_hash': sha256(secret.encode()).hexdigest()})
            assert response.status_code == 200, response.text
            ids.append(response.json()['run_id'])
        history = await client.get(path + '/runs', params={**scope, 'limit': 1})
        assert history.status_code == 200, history.text
        first = history.json()
        assert len(first['runs']) == 1 and first['complete'] is False
        second = (await client.get(path + '/runs', params={**scope, 'limit': 1,
                            'cursor': first['next_cursor']})).json()
        assert second['complete'] is True
        assert {row['run_id'] for row in first['runs'] + second['runs']} == set(ids)
        assert 'runtime_capability_hash' not in history.text and 'own_context_token' not in history.text
        assert headers['x-fuli-worker-capability'] not in history.text
        after = (await client.get(path, params=scope)).json()
        assert after['status'] == before['status']
        assert after['revision'] == before['revision']


@pytest.mark.asyncio
async def test_run_terminal_result_is_immutable_capability_scoped_and_keeps_business_state():
    from test_project_agent_memory_neo4j import fixture_settings, provider_client
    from test_agent_delegations_neo4j import worker_run_fixture
    async with provider_client(fixture_settings()) as (client, _):
        scope, payload, headers = await worker_run_fixture(client)
        run = (await client.put('/v1/project-agent-worker-runs', json=payload)).json()
        path = '/v1/project-agent-worker-runs/' + run['run_id']
        result = {**scope, 'status': 'failed', 'code': 'worker_connection_closed', 'stage': 'configure',
                  'prompt_dispatched': False, 'process_stopped': True, 'run_closed': True,
                  'terminal_recorded': True, 'cleanup_errors': []}
        early = await client.post(path + '/result', json=result, headers=headers)
        assert early.status_code == 409, early.text
        await client.post(path + '/close', json={**scope, 'reason': result['code']}, headers=headers)
        denied = await client.post(path + '/result', json=result)
        assert denied.status_code == 403, denied.text
        first = await client.post(path + '/result', json=result, headers=headers)
        assert first.status_code == 200, first.text
        assert first.json()['execution_status'] == 'failed'
        assert first.json()['execution_result']['failure_class'] == 'network'
        assert (await client.post(path + '/result', json=result, headers=headers)).json() == first.json()
        conflict = await client.post(path + '/result', json={**result, 'code': 'worker_timeout'}, headers=headers)
        assert conflict.status_code == 409, conflict.text
        task = (await client.get('/v1/project-agent-tasks/' + payload['task_id'], params=scope)).json()
        assert task['status'] == 'queued'
        assert first.json()['execution_result'].get('actual_model') is None


@pytest.mark.asyncio
async def test_dispatch_marker_claims_once_and_prevents_safe_retry_after_uncertain_prompt():
    from test_project_agent_memory_neo4j import fixture_settings, provider_client
    from test_agent_delegations_neo4j import worker_run_fixture
    async with provider_client(fixture_settings()) as (client, _):
        scope, payload, headers = await worker_run_fixture(client)
        run = (await client.put('/v1/project-agent-worker-runs', json=payload)).json()
        path = '/v1/project-agent-worker-runs/' + run['run_id']
        assert (await client.post(path + '/dispatch', json=scope, headers=headers)).status_code == 409
        await client.post(path + '/start-claim', json=scope, headers=headers)
        session = {**scope, 'source_application': 'codex', 'session_id': 'execution-' + scope['personal_space_id']}
        assert (await client.put(path + '/session', json=session, headers=headers)).status_code == 200
        assert (await client.post(path + '/contexts', json=session, headers=headers)).status_code == 200
        import asyncio
        responses = await asyncio.gather(*(client.post(path + '/dispatch', json=scope, headers=headers) for _ in range(2)))
        assert sorted(r.json()['dispatch_claimed'] for r in responses) == [False, True]
        await client.post(path + '/close', json={**scope, 'reason': 'worker_connection_closed'}, headers=headers)
        result = {**scope, 'status': 'failed', 'code': 'worker_connection_closed', 'stage': 'prompt',
                  'prompt_dispatched': False, 'process_stopped': True, 'run_closed': True,
                  'terminal_recorded': True, 'cleanup_errors': []}
        denied = await client.post(path + '/result', json=result, headers=headers)
        assert denied.status_code == 409, denied.text
        saved = await client.post(path + '/result', json={**result, 'prompt_dispatched': True}, headers=headers)
        assert saved.status_code == 200, saved.text
        assert saved.json()['execution_result']['retry_eligible'] is False


@pytest.mark.asyncio
async def test_retry_chain_is_durable_bounded_idempotent_and_has_one_successor(monkeypatch):
    import asyncio
    from hashlib import sha256
    from fuli_graph import worker_run_execution
    from test_project_agent_memory_neo4j import fixture_settings, provider_client
    from test_agent_delegations_neo4j import worker_run_fixture
    monkeypatch.setattr(worker_run_execution, 'WORKER_FINAL_RETRY_DELAY_MS', 0)
    async with provider_client(fixture_settings()) as (client, _):
        scope, payload, headers = await worker_run_fixture(client)
        first = await client.put('/v1/project-agent-worker-runs', json=payload)
        run = first.json()
        root_id, ids = run['run_id'], [run['run_id']]
        for attempt in range(1, 4):
            assert run.get('attempt_number') == attempt
            path = '/v1/project-agent-worker-runs/' + run['run_id']
            await client.post(path + '/close', json={**scope, 'reason': 'worker_connection_closed'}, headers=headers)
            terminal = await client.post(path + '/result', headers=headers, json={**scope,
                'status': 'failed', 'code': 'worker_connection_closed', 'stage': 'configure',
                'prompt_dispatched': False, 'process_stopped': True, 'run_closed': True,
                'terminal_recorded': True, 'cleanup_errors': []})
            assert terminal.status_code == 200, terminal.text
            assert terminal.json()['execution_result']['retry_eligible'] is (attempt < 3)
            secret = 'synthetic-retry-capability-for-attempt-' + str(attempt)
            next_payload = {**payload, 'retry_of_run_id': run['run_id'],
                'worker_id': f'retry-worker-{attempt}', 'idempotency_key': f'retry-after-{run["run_id"]}',
                'runtime_capability_hash': sha256(secret.encode()).hexdigest()}
            responses = await asyncio.gather(*(client.put('/v1/project-agent-worker-runs', json=next_payload) for _ in range(2)))
            if attempt == 3:
                assert all(r.status_code == 409 for r in responses)
                break
            assert all(r.status_code == 200 for r in responses), [r.text for r in responses]
            assert responses[0].json()['run_id'] == responses[1].json()['run_id']
            run = responses[0].json()
            assert run['root_run_id'] == root_id
            assert run['retry_of_run_id'] == ids[-1]
            ids.append(run['run_id'])
            competitor = await client.put('/v1/project-agent-worker-runs', json={
                **next_payload, 'idempotency_key': next_payload['idempotency_key'] + '-duplicate'})
            assert competitor.status_code == 409, competitor.text
            headers = {'x-fuli-worker-capability': secret}
        history = (await client.get('/v1/project-agent-tasks/' + payload['task_id'] + '/runs', params=scope)).json()
        assert len(history['runs']) == 3
        assert {r['run_id'] for r in history['runs']} == set(ids)


@pytest.mark.asyncio
async def test_retry_prepare_locks_parent_and_predecessor_child_in_one_global_order(monkeypatch):
    from hashlib import sha256
    from fuli_graph.store_task_contexts import StoreTaskContexts
    from test_project_agent_memory_neo4j import fixture_settings, provider_client
    from test_agent_delegations_neo4j import worker_run_fixture
    async with provider_client(fixture_settings()) as (client, _):
        scope, payload, headers = await worker_run_fixture(client)
        run = (await client.put('/v1/project-agent-worker-runs', json=payload)).json()
        path = '/v1/project-agent-worker-runs/' + run['run_id']
        await client.post(path + '/start-claim', json=scope, headers=headers)
        session = {**scope, 'source_application': 'codex', 'session_id': 'retry-lock-child-' + scope['personal_space_id']}
        assert (await client.put(path + '/session', json=session, headers=headers)).status_code == 200
        assert (await client.post(path + '/contexts', json=session, headers=headers)).status_code == 200
        await client.post(path + '/close', json={**scope, 'reason': 'worker_connection_closed'}, headers=headers)
        terminal = await client.post(path + '/result', headers=headers, json={**scope,
            'status': 'failed', 'code': 'worker_connection_closed', 'stage': 'configure',
            'prompt_dispatched': False, 'process_stopped': True, 'run_closed': True,
            'terminal_recorded': True, 'cleanup_errors': []})
        assert terminal.status_code == 200, terminal.text
        original, locks = StoreTaskContexts._lock_task_context_session, []
        async def observe(store, session_id):
            locks.append(session_id)
            return await original(store, session_id)
        monkeypatch.setattr(StoreTaskContexts, '_lock_task_context_session', observe)
        response = await client.put('/v1/project-agent-worker-runs', json={**payload,
            'retry_of_run_id': run['run_id'], 'idempotency_key': 'retry-lock-order-1',
            'worker_id': 'retry-lock-worker', 'runtime_capability_hash': sha256(b'synthetic-retry-lock-capability-123456').hexdigest()})
        assert response.status_code == 200, response.text
        assert len(locks) == 2, 'retry must acquire the complete parent/child set once, before any task or run lock'
        assert locks == sorted(set(locks))


@pytest.mark.asyncio
async def test_retry_racing_predecessor_revocation_never_claims_new_execution():
    import asyncio
    from hashlib import sha256
    from test_project_agent_memory_neo4j import fixture_settings, provider_client
    from test_agent_delegations_neo4j import worker_run_fixture
    async with provider_client(fixture_settings()) as (client, _):
        scope, payload, headers = await worker_run_fixture(client)
        run = (await client.put('/v1/project-agent-worker-runs', json=payload)).json()
        path = '/v1/project-agent-worker-runs/' + run['run_id']
        await client.post(path + '/start-claim', json=scope, headers=headers)
        session = {**scope, 'source_application': 'codex', 'session_id': 'revoke-child-' + scope['personal_space_id']}
        assert (await client.put(path + '/session', json=session, headers=headers)).status_code == 200
        assert (await client.post(path + '/contexts', json=session, headers=headers)).status_code == 200
        await client.post(path + '/close', json={**scope, 'reason': 'worker_connection_closed'}, headers=headers)
        terminal = await client.post(path + '/result', headers=headers, json={**scope,
            'status': 'failed', 'code': 'worker_connection_closed', 'stage': 'configure',
            'prompt_dispatched': False, 'process_stopped': True, 'run_closed': True,
            'terminal_recorded': True, 'cleanup_errors': []})
        assert terminal.status_code == 200, terminal.text
        secret = 'synthetic-retry-revocation-capability-123456'
        retry, revoked = await asyncio.wait_for(asyncio.gather(
            client.put('/v1/project-agent-worker-runs', json={**payload, 'retry_of_run_id': run['run_id'],
                'idempotency_key': 'retry-racing-revoke-1', 'worker_id': 'retry-revocation-worker',
                'runtime_capability_hash': sha256(secret.encode()).hexdigest()}),
            client.post(path + '/revoke', json={**scope, 'reason': 'Synthetic human stop'})), 10)
        assert revoked.status_code == 200, revoked.text
        assert retry.status_code in {200, 409}, retry.text
        if retry.status_code == 200:
            claim = await client.post('/v1/project-agent-worker-runs/' + retry.json()['run_id'] + '/start-claim',
                json=scope, headers={'x-fuli-worker-capability': secret})
            assert claim.status_code == 409, claim.text
        history_path = '/v1/project-agent-tasks/' + payload['task_id'] + '/runs'
        bad = await client.get(history_path, params={**scope, 'cursor': 'foreign-run-id'})
        assert bad.status_code == 422
        denied = await client.get(history_path, params={**scope, 'personal_project_id': 'not-authorized-project'})
        assert denied.status_code in {403, 404}
