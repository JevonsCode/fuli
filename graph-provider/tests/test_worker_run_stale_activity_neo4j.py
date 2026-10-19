"""A late report from an older worker run must not overwrite a newer run's task state."""

from hashlib import sha256
from secrets import token_urlsafe

import pytest

from test_agent_delegations_neo4j import worker_run_fixture
from test_project_agent_memory_neo4j import fixture_settings, provider_client


async def claimed_run(client, scope, payload, key):
    secret = token_urlsafe(32)
    prepared = await client.put('/v1/project-agent-worker-runs', json={**payload, 'idempotency_key': key,
        'runtime_capability_hash': sha256(secret.encode()).hexdigest()})
    assert prepared.status_code == 200, prepared.text
    run_id = prepared.json()['run_id']
    claimed = await client.post(f'/v1/project-agent-worker-runs/{run_id}/start-claim', json=scope,
        headers={'x-fuli-worker-capability': secret})
    assert claimed.status_code == 200 and claimed.json()['start_claimed'] is True, claimed.text
    return run_id


def report(scope, payload, run_id, status, phase):
    return {**scope, 'task_id': payload['task_id'], 'agent_id': payload['agent_id'],
        'worker_id': payload['worker_id'], 'worker_run_id': run_id, 'status': status,
        'worker_status': 'completed' if status == 'awaiting_review' else 'running',
        'source_application': 'codex', 'idempotency_key': f'{run_id}:{phase}',
        'summary': f'Synthetic {phase} report.'}


@pytest.mark.asyncio
async def test_older_run_report_cannot_overwrite_a_newer_claimed_run():
    async with provider_client(fixture_settings()) as (client, _):
        scope, payload, _ = await worker_run_fixture(client)
        task_path = f'/v1/project-agent-tasks/{payload["task_id"]}'
        older = await claimed_run(client, scope, payload, 'synthetic-older-attempt')
        newer = await claimed_run(client, scope, payload, 'synthetic-newer-attempt')
        running = await client.post(task_path + '/events', json=report(scope, payload, newer, 'running', 'running'))
        assert running.status_code == 200, running.text
        revision = running.json()['revision']

        late = await client.post(task_path + '/events', json=report(scope, payload, older, 'awaiting_review', 'terminal'))
        assert late.status_code == 200, late.text
        assert late.json()['status'] == 'running'
        assert late.json()['revision'] == revision
        replay = await client.post(task_path + '/events', json=report(scope, payload, older, 'awaiting_review', 'terminal'))
        assert replay.status_code == 200 and replay.json()['status'] == 'running', replay.text

        current = await client.post(task_path + '/events', json=report(scope, payload, newer, 'awaiting_review', 'terminal'))
        assert current.status_code == 200, current.text
        assert current.json()['status'] == 'awaiting_review'


@pytest.mark.asyncio
async def test_report_naming_a_run_of_another_task_is_rejected():
    async with provider_client(fixture_settings()) as (client, _):
        scope, payload, _ = await worker_run_fixture(client)
        task_path = f'/v1/project-agent-tasks/{payload["task_id"]}'
        rejected = await client.post(task_path + '/events',
            json=report(scope, payload, 'unbound-synthetic-run', 'running', 'running'))
        assert rejected.status_code == 409, rejected.text
