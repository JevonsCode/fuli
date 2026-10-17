"""Frozen checkpoint attribution over existing synthetic WorkerRuns, no model."""

import asyncio
from datetime import UTC, datetime
from hashlib import sha256
from secrets import token_urlsafe
from uuid import uuid4

import pytest

from test_agent_delegations_neo4j import worker_run_fixture
from test_project_agent_memory_neo4j import fixture_settings, provider_client
from test_project_agent_team_lifecycle_neo4j import binding_parent, bind


async def run(client, scope, payload, headers, status=None, *, parent=None):
    suffix = uuid4().hex
    capability = token_urlsafe(32)
    headers = {'x-fuli-worker-capability': capability}
    request = {**payload, 'worker_id': f'worker-{suffix}', 'idempotency_key': f'attribution-{suffix}'}
    request['runtime_capability_hash'] = sha256(capability.encode()).hexdigest()
    if parent:
        request['task_context_token'] = parent
    prepared = await client.put('/v1/project-agent-worker-runs', json=request)
    assert prepared.status_code == 200, prepared.text
    run_id = prepared.json()['run_id']
    if status is None:
        closed = await client.post(f'/v1/project-agent-worker-runs/{run_id}/close',
            json={**scope, 'reason': 'Synthetic never-started run.'}, headers=headers)
        assert closed.status_code == 200, closed.text
        return run_id, request, headers
    for endpoint, data in [('start-claim', scope), ('session', {**scope, 'source_application': 'codex',
            'session_id': f'native-{suffix}'}), ('contexts', {**scope, 'source_application': 'codex',
            'session_id': f'native-{suffix}'})]:
        response = await client.request('PUT' if endpoint == 'session' else 'POST',
            f'/v1/project-agent-worker-runs/{run_id}/{endpoint}', json=data, headers=headers)
        assert response.status_code == 200, response.text
    if status != 'pending':
        await finish(client, scope, run_id, request, headers, status, f'native-{suffix}')
    return run_id, request, headers


async def finish(client, scope, run_id, request, headers, status, session_id):
    closed = await client.post(f'/v1/project-agent-worker-runs/{run_id}/close',
        json={**scope, 'reason': f'Synthetic {status}.'}, headers=headers)
    assert closed.status_code == 200, closed.text
    response = await client.post(f'/v1/project-agent-tasks/{request["task_id"]}/events', json={**scope,
        'task_id': request['task_id'], 'agent_id': request['agent_id'], 'worker_id': request['worker_id'],
        'status': 'running', 'worker_status': status,
        'worker_label': 'Synthetic implementation review',
        'worker_runtime': {'application': 'codex', 'session_id': session_id,
                           'session_url': f'codex://threads/{session_id}'},
        'source_application': 'codex', 'source_session_id': 'worker-parent-session',
        'idempotency_key': f'{run_id}:terminal', 'summary': f'Synthetic worker {status}.'})
    assert response.status_code == 200, response.text


async def checkpoint(client, scope, token, phase):
    response = await client.put(f'/v1/task-contexts/{token}/checkpoint', json={
        'personal_space_id': scope['personal_space_id'], 'source_application': 'codex',
        'phase': phase, 'disposition': 'retain_nothing', 'reason': 'Freeze synthetic attribution.',
        'fingerprint': 'c' * 64, 'work_log': {'status': 'completed', 'summary': 'Synthetic attribution accepted.'}})
    assert response.status_code == 200, response.text
    return response.json()['checkpoint']['collaboration']


@pytest.mark.asyncio
async def test_exact_parent_snapshot_retains_failed_cancelled_sessions_and_excludes_unstarted_runs():
    async with provider_client(fixture_settings()) as (client, _):
        scope, payload, headers = await worker_run_fixture(client)
        first, _, _ = await run(client, scope, payload, headers, 'failed')
        second, _, _ = await run(client, scope, payload, headers, 'cancelled')
        await run(client, scope, payload, headers)  # closed alone is not execution
        await run(client, scope, payload, headers, 'pending')
        # An isolated actual Observation has no exact-parent WorkerRun evidence.
        for observed_run in [first, f'isolated-{uuid4()}']:
            observation = await client.post('/v1/project-agent-executor-actuals', json={**scope,
                'task_id': payload['task_id'], 'agent_id': payload['agent_id'], 'executor_id': payload['executor_id'],
                'provider': payload['provider'], 'model': payload['model'], 'model_strategy': payload['model_strategy'],
                'run_id': observed_run, 'idempotency_key': f'observation-{uuid4()}',
                'occurred_at': datetime.now(UTC).isoformat(), 'source_application': 'codex', 'source_session_id': 'unrelated-session'})
            assert observation.status_code == 200, observation.text
        snapshot = await checkpoint(client, scope, payload['task_context_token'], 'complete')
        assert snapshot['owner']['agent_id'] == 'owner'
        assert [item['agent_id'] for item in snapshot['collaborators']] == ['specialist']
        evidence = snapshot['collaborators'][0]['runs']
        assert {item['run_id'] for item in evidence} == {first, second}
        assert {item['status'] for item in evidence} == {'failed', 'cancelled'}
        assert len({item['session_id'] for item in evidence}) == 2
        assert snapshot['collaborators'][0]['responsibility']
        assert all(item['task_id'] == payload['task_id'] for item in evidence)
        assert all(item['work_kind'] == 'implementation' for item in evidence)
        assert all(item['worker_label'] == 'Synthetic implementation review' for item in evidence)
        assert all(item['session_url'] == f'codex://threads/{item["session_id"]}' for item in evidence)
        assert len(next(item for item in evidence if item['run_id'] == first)['observation_ids']) == 1
        assert not next(item for item in evidence if item['run_id'] == second)['observation_ids']


@pytest.mark.asyncio
async def test_prepare_freezes_before_late_worker_finishes_and_replay_survives_provider_restart():
    settings = fixture_settings()
    async with provider_client(settings) as (client, access_token):
        scope, payload, headers = await worker_run_fixture(client)
        first, _, _ = await run(client, scope, payload, headers, 'failed')
        late_id, late, late_headers = await run(client, scope, payload, headers, 'pending')
        read = await client.get(f'/v1/project-agent-worker-runs/{late_id}', params=scope, headers=late_headers)
        session_id = read.json()['actual_session_id']
        frozen = await checkpoint(client, scope, payload['task_context_token'], 'prepare')
        assert {value['run_id'] for value in frozen['collaborators'][0]['runs']} == {first}
        await finish(client, scope, late_id, late, late_headers, 'completed', session_id)
        assert await checkpoint(client, scope, payload['task_context_token'], 'complete') == frozen
    async with provider_client(settings, access_token) as (client, _):
        assert await checkpoint(client, scope, payload['task_context_token'], 'complete') == frozen


@pytest.mark.asyncio
async def test_two_parent_tokens_sharing_a_coordination_task_never_share_worker_attribution():
    async with provider_client(fixture_settings()) as (client, _):
        scope, payload, headers = await worker_run_fixture(client)
        other = f'fuli-task-{uuid4()}'
        await binding_parent(client, scope, other, f'parent-{uuid4()}')
        assert (await bind(client, scope, other, payload['task_id'])).status_code == 200
        first, _, _ = await run(client, scope, payload, headers, 'failed')
        second, _, _ = await run(client, scope, payload, headers, 'cancelled', parent=other)
        one = await checkpoint(client, scope, payload['task_context_token'], 'complete')
        two = await checkpoint(client, scope, other, 'complete')
        assert {value['run_id'] for value in one['collaborators'][0]['runs']} == {first}
        assert {value['run_id'] for value in two['collaborators'][0]['runs']} == {second}


@pytest.mark.asyncio
async def test_concurrent_first_prepare_serializes_two_providers_and_preserves_frozen_receipt(monkeypatch):
    import fuli_graph.store_task_contexts as contexts

    settings = fixture_settings()
    async with provider_client(settings, raise_app_exceptions=False) as (first, access_token):
        scope, payload, headers = await worker_run_fixture(first)
        run_id, _, _ = await run(first, scope, payload, headers, 'failed')
        endpoint = f'/v1/task-contexts/{payload["task_context_token"]}/checkpoint'
        request = {'personal_space_id': scope['personal_space_id'], 'source_application': 'codex',
            'phase': 'prepare', 'disposition': 'retain_nothing', 'reason': 'Freeze synthetic attribution.',
            'fingerprint': 'c' * 64, 'work_log': {'status': 'completed', 'summary': 'Synthetic attribution accepted.'}}
        ready, release = asyncio.Event(), asyncio.Event()
        original = contexts.checkpoint_collaboration

        async def pause_first_read(*args, **kwargs):
            snapshot = await original(*args, **kwargs)
            if not ready.is_set():
                ready.set()
                await release.wait()
            return snapshot

        monkeypatch.setattr(contexts, 'checkpoint_collaboration', pause_first_read)
        async with provider_client(settings, access_token, raise_app_exceptions=False) as (second, _):
            tasks = []
            try:
                tasks.append(asyncio.create_task(first.put(endpoint, json=request)))
                await asyncio.wait_for(ready.wait(), 10)
                tasks.append(asyncio.create_task(second.put(endpoint, json=request)))
                await asyncio.wait({tasks[1]}, timeout=0.1)
                assert not tasks[1].done(), 'Second prepare must wait for the first snapshot transaction'
                release.set()
                results = await asyncio.wait_for(asyncio.gather(*tasks), 20)
                assert [response.status_code for response in results] == [200, 200], [response.text for response in results]
                frozen = results[0].json()['checkpoint']['collaboration']
                assert results[1].json()['checkpoint']['collaboration'] == frozen
                assert {item['run_id'] for item in frozen['collaborators'][0]['runs']} == {run_id}
                assert await checkpoint(second, scope, payload['task_context_token'], 'complete') == frozen
            finally:
                release.set()
                for task in tasks:
                    if not task.done():
                        task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
    async with provider_client(settings, access_token) as (restarted, _):
        assert await checkpoint(restarted, scope, payload['task_context_token'], 'complete') == frozen


@pytest.mark.asyncio
async def test_another_project_cannot_claim_or_display_the_original_worker_receipt():
    from test_project_agent_memory_neo4j import seed_agent
    from test_project_agent_team_lifecycle_neo4j import binding_policy

    async with provider_client(fixture_settings()) as (client, _):
        scope, payload, headers = await worker_run_fixture(client)
        run_id, _, _ = await run(client, scope, payload, headers, 'completed')
        other = {**scope, 'personal_project_id': 'other-' + uuid4().hex}
        for agent in ['owner', 'specialist']:
            await seed_agent(client, scope['personal_space_id'], project=other['personal_project_id'],
                             agent=agent, allowed_clients=['codex', 'claude_code'])
        await binding_policy(client, other)
        parent = 'fuli-task-other-' + uuid4().hex
        await binding_parent(client, other, parent, 'other-session-' + uuid4().hex)
        denied = await client.put('/v1/project-agent-worker-runs', json={**payload, **other,
            'task_context_token': parent, 'idempotency_key': 'foreign-attribution-' + uuid4().hex})
        assert denied.status_code in {403, 404, 409}, denied.text
        foreign = await checkpoint(client, other, parent, 'complete')
        assert foreign['owner']['agent_id'] == 'owner'
        assert foreign['collaborators'] == []
        original = await checkpoint(client, scope, payload['task_context_token'], 'complete')
        assert [item['run_id'] for item in original['collaborators'][0]['runs']] == [run_id]
