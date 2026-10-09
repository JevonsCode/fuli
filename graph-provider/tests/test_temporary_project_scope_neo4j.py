"""Public HTTP checks on an explicitly disposable graph; no model or worker run."""

import hashlib
import json

import pytest

from test_project_agent_memory_neo4j import fixture_settings, provider_client


def scope_request(space_id, token, source='codex'):
    key = hashlib.sha256(json.dumps(['fuli-temporary-task-v1', space_id, source, token, None],
        separators=(',', ':')).encode()).hexdigest()
    return {'personal_space_id': space_id, 'scope_key': key,
            'source_application': source, 'task_context_token': token}


async def create_context(client, space_id, token, session):
    result = await client.put('/v1/task-contexts', json={
        'personal_space_id': space_id, 'session_id': session, 'turn_id': 'turn-one',
        'source_application': 'codex', 'token': token,
    })
    assert result.status_code == 200, result.text


@pytest.mark.asyncio
async def test_temporary_scope_binding_is_idempotent_and_rejects_wrong_lifecycle():
    async with provider_client(fixture_settings()) as (client, _):
        space = await client.post('/v1/spaces', json={'name': 'Synthetic temporary scope', 'kind': 'personal'})
        space_id = space.json()['id']
        token = 'fuli-task-temporary-scope-one'
        await create_context(client, space_id, token, 'temporary-session-one')
        payload = scope_request(space_id, token)
        wrong = await client.post('/v1/temporary-projects/ensure', json={**payload, 'scope_key': 'b' * 64})
        assert wrong.status_code == 409, wrong.text
        first = await client.post('/v1/temporary-projects/ensure', json=payload)
        assert first.status_code == 200, first.text
        retry = await client.post('/v1/temporary-projects/ensure', json=payload)
        assert retry.json() == first.json()
        assert first.json()['scope_type'] == 'temporary'
        params = {'personal_space_id': space_id, 'source_application': 'codex'}
        context = await client.get(f'/v1/task-contexts/{token}', params=params)
        assert context.json()['personal_project_id'] == first.json()['project_id']
        assert context.json()['project_scope']['type'] == 'temporary'
        other = await client.post('/v1/temporary-projects/ensure', json=scope_request(space_id, token, 'cursor'))
        assert other.status_code == 404, other.text
        next_token = 'fuli-task-temporary-scope-two'
        await create_context(client, space_id, next_token, 'temporary-session-two')
        second = await client.post('/v1/temporary-projects/ensure', json=scope_request(space_id, next_token))
        assert second.status_code == 200, second.text
        assert second.json()['project_id'] != first.json()['project_id']
        projects = await client.get('/v1/personal-projects', params={'personal_space_id': space_id})
        assert len(projects.json()) == 2


@pytest.mark.asyncio
async def test_temporary_scope_preserves_hr_gate_then_adopts_task_only_agent_and_checkpoints():
    async with provider_client(fixture_settings()) as (client, _):
        space = await client.post('/v1/spaces', json={'name': 'Synthetic temporary staffing', 'kind': 'personal'})
        space_id = space.json()['id']
        token = 'fuli-task-temporary-staffing'
        await create_context(client, space_id, token, 'temporary-staffing-session')
        project = await client.post('/v1/temporary-projects/ensure', json=scope_request(space_id, token))
        assert project.status_code == 200, project.text
        scope = {'personal_space_id': space_id, 'personal_project_id': project.json()['project_id']}
        hr = await client.post('/v1/project-agents/system-hr', params={'personal_space_id': space_id})
        assert hr.status_code == 200, hr.text
        payload = {**scope, 'idempotency_key': 'synthetic-temporary-staffing',
            'title': 'Synthetic temporary verification', 'objective': 'Verify isolated task lifecycle.',
            'work_kind': 'verification', 'source_application': 'codex', 'source_session_id': 'synthetic-session',
            'staffing_intent': 'temporary', 'duration': 'one_off', 'routing_reason': 'Synthetic acceptance.'}
        route = await client.post('/v1/project-agent-tasks', json=payload)
        assert route.status_code == 200, route.text
        assert route.json()['task']['status'] == 'awaiting_recruitment'
        assert route.json()['task']['project_scope']['type'] == 'temporary'
        assert route.json()['task']['participants'] == []
        proposal = route.json()['recruitment']
        approval = await client.post(f'/v1/project-agent-recruitments/{proposal["recruitment_id"]}/decision', json={
            **scope, 'recruitment_id': proposal['recruitment_id'], 'decision': 'approve',
            'expected_revision': proposal['revision'], 'reason': 'Synthetic explicit approval.'})
        assert approval.status_code == 200, approval.text
        retry = await client.post('/v1/project-agent-tasks', json=payload)
        assert retry.status_code == 200, retry.text
        task = retry.json()['task']
        # Approval proves staffing; executor authorization can still block work.
        assert task['status'] in {'queued', 'blocked'}
        if task['status'] == 'blocked':
            assert task['executor_blocked_reason']
        lead = task['lead_agent_id']
        adopted = await client.put(f'/v1/task-contexts/{token}/agent', json={
            **scope, 'source_application': 'codex', 'task_id': task['task_id'], 'agent_id': lead})
        assert adopted.status_code == 200, adopted.text
        assert adopted.json()['agent_memory_scope'] == 'task_only'
        assert adopted.json()['work_log_required'] is True
        recovered = await client.post('/v1/project-agent-context/resolve', json={
            **scope, 'agent_id': lead, 'session_id': 'temporary-staffing-session',
            'turn_id': 'turn-one', 'source_application': 'codex'})
        assert recovered.status_code == 200, recovered.text
        assert recovered.json()['agent']['agent_id'] == lead
        assert recovered.json()['worker_started'] is False
        for changes in [{'session_id': 'another-host-task'}, {'turn_id': 'another-turn'}]:
            denied = await client.post('/v1/project-agent-context/resolve', json={
                **scope, 'agent_id': lead, 'session_id': 'temporary-staffing-session',
                'turn_id': 'turn-one', 'source_application': 'codex', **changes})
            assert denied.status_code == 409, denied.text
        memory = await client.get(f'/v1/project-agents/{lead}/memory', params=scope)
        assert memory.status_code == 409, memory.text
        checkpoint = {'personal_space_id': space_id, 'source_application': 'codex',
            'disposition': 'retain_nothing', 'reason': 'No real worker was started.', 'fingerprint': 'c' * 64,
            'work_log': {'status': 'incomplete', 'summary': 'Synthetic staffing and lifecycle validated; no worker execution.'}}
        for phase in ['prepare', 'complete']:
            saved = await client.put(f'/v1/task-contexts/{token}/checkpoint', json={**checkpoint, 'phase': phase})
            assert saved.status_code == 200, saved.text
        verified = await client.get('/v1/task-context-sessions/checkpoint', params={
            'personal_space_id': space_id, 'source_application': 'codex', 'session_id': 'temporary-staffing-session'})
        assert verified.json()['status'] == 'checkpointed'
        tasks = await client.get('/v1/project-agent-tasks', params=scope)
        assert len(tasks.json()) == 1
        assert tasks.json()[0]['project_scope']['type'] == 'temporary'
        assert tasks.json()[0]['execution_summary'] == []
        terminal = await client.post(f'/v1/project-agent-tasks/{task["task_id"]}/events', json={
            **scope, 'task_id': task['task_id'], 'agent_id': lead,
            'expected_revision': task['revision'], 'status': 'cancelled',
            'idempotency_key': 'synthetic-temporary-cancel', 'source_application': 'codex',
            'summary': 'Synthetic lifecycle finished; no executor was started.'})
        assert terminal.status_code == 200, terminal.text
        retained = await client.get('/v1/personal-projects', params={'personal_space_id': space_id})
        assert retained.json()[0]['project_id'] == scope['personal_project_id']
        replay = await client.post('/v1/project-agent-tasks', json=payload)
        assert replay.status_code == 200, replay.text
        assert replay.json()['task']['status'] == 'cancelled'
        assert replay.json()['task']['execution_summary'] == []
