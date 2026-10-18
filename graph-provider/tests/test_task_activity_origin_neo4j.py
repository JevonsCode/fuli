"""Source metadata acceptance using disposable graphs and synthetic host grants."""

from uuid import uuid4

import pytest

from test_agent_delegations_neo4j import setup_delegation, issue, resolve, worker_run_fixture
from test_project_agent_memory_neo4j import fixture_settings, provider_client


async def internal_context(client, scope, grant_request, work_kind):
    session = f'origin-session-{uuid4()}'
    grant = await issue(client, {**grant_request, 'target_session_id': session})
    assert (await resolve(client, scope, grant, session))['status'] == 'ready'
    sealed = await client.post('/v1/project-agent-context/delegations/seal', json={
        'personal_space_id': scope['personal_space_id'], 'token': grant, 'session_id': session})
    assert sealed.status_code == 200, sealed.text
    request = {**scope, 'project_agent_id': 'member', 'source_application': 'codex',
               'session_id': session, 'token': f'fuli-task-{uuid4()}', 'turn_id': 'origin-turn',
               'delegation_token': grant,
               'preference_scope': {'version': 1, 'work_kind': work_kind, 'workflow': None}}
    response = await client.put('/v1/task-contexts', json=request)
    assert response.status_code == 200, response.text
    assert grant not in response.text
    return request, response.json()


@pytest.mark.asyncio
@pytest.mark.parametrize(('work_kind', 'purpose'), [('test_validation', 'test'), ('input_suggestion', 'input_suggestion')])
async def test_verified_roundtable_origin_survives_retry_reopen_and_coordination_reads(work_kind, purpose):
    settings = fixture_settings()
    async with provider_client(settings) as (client, access_token):
        scope, grant_request = await setup_delegation(client)
        request, record = await internal_context(client, scope, grant_request, work_kind)
        origin = {'version': 1, 'kind': 'ai_internal', 'source': 'roundtable_delegation', 'purpose': purpose}
        assert record.get('activity_origin') == origin
        retry = await client.put('/v1/task-contexts', json={**request, 'token': f'fuli-task-{uuid4()}'})
        assert retry.status_code == 200 and retry.json()['activity_origin'] == origin, retry.text
        task_input = {**scope, 'idempotency_key': 'origin-task', 'title': 'Synthetic internal activity',
                      'objective': 'Verify provenance only, without running a model.', 'work_kind': 'implementation',
                      'lead_agent_id': 'member', 'coordinator_agent_id': 'lead', 'complexity_hint': 'simple',
                      'routing_reason': 'Synthetic origin acceptance.', 'source_application': 'codex',
                      'task_context_token': record['token']}
        response = await client.post('/v1/project-agent-tasks', json=task_input)
        assert response.status_code == 200, response.text
        task = response.json()['task']
        assert task['activity_origin'] == origin
        task_id = task['task_id']
        repeated = await client.post('/v1/project-agent-tasks', json=task_input)
        assert repeated.status_code == 200 and repeated.json()['task']['activity_origin'] == origin, repeated.text
        forged = await client.post('/v1/project-agent-tasks', json={**task_input, 'activity_origin': origin})
        assert forged.status_code == 422
        # Entry proof authenticates creation; replays preserve the frozen origin.
        ordinary = await client.put('/v1/task-contexts', json={**scope, 'project_agent_id': 'lead',
            'source_application': 'codex', 'session_id': f'ordinary-{uuid4()}', 'token': f'fuli-task-{uuid4()}'})
        assert ordinary.status_code == 200 and ordinary.json()['activity_origin'] is None
        changed = await client.post('/v1/project-agent-tasks', json={**task_input,
            'task_context_token': ordinary.json()['token']})
        assert changed.status_code == 200 and changed.json()['task']['activity_origin'] == origin
        plain_input = {key: value for key, value in task_input.items() if key != 'task_context_token'}
        plain_input['idempotency_key'] = 'ordinary-task'
        plain = await client.post('/v1/project-agent-tasks', json=plain_input)
        assert plain.status_code == 200 and plain.json()['task']['activity_origin'] is None
        plain_retry = await client.post('/v1/project-agent-tasks', json={**plain_input,
            'task_context_token': record['token']})
        assert plain_retry.status_code == 200 and plain_retry.json()['task']['activity_origin'] is None
        for change in [{'title': 'Changed title'}, {'work_kind': 'test_validation'},
                       {'source_session_id': 'changed-session'}]:
            assert (await client.post('/v1/project-agent-tasks', json={**task_input, **change})).status_code == 409
        cleared = {key: value for key, value in request.items() if key != 'delegation_token'}
        cleared['token'] = f'fuli-task-{uuid4()}'
        cleared_retry = await client.put('/v1/task-contexts', json=cleared)
        assert cleared_retry.status_code == 200 and cleared_retry.json()['activity_origin'] == origin
        for change in [{'session_id': 'foreign-session'}, {'project_agent_id': 'other'},
                       {'source_application': 'claude_code'}]:
            rejected = await client.put('/v1/task-contexts', json={**request, **change,
                'token': f'fuli-task-{uuid4()}', 'turn_id': f'foreign-{uuid4()}'})
            assert rejected.status_code in {403, 409}, rejected.text
    async with provider_client(settings, access_token) as (client, _):
        context = await client.get(f'/v1/task-contexts/{record["token"]}', params={
            'personal_space_id': scope['personal_space_id'], 'source_application': 'codex'})
        assert context.status_code == 200 and context.json()['activity_origin'] == origin
        listed = await client.get('/v1/project-agent-tasks', params={**scope, 'agent_id': 'member'})
        assert listed.status_code == 200, listed.text
        tasks = {item['task_id']: item for item in listed.json()}
        assert tasks[task_id]['activity_origin'] == origin
        assert tasks[plain.json()['task']['task_id']]['activity_origin'] is None
        detail = await client.get(f'/v1/project-agent-tasks/{task_id}', params=scope)
        assert detail.status_code == 200 and detail.json()['activity_origin'] == origin
        assert 'delegation_token' not in context.text


@pytest.mark.asyncio
@pytest.mark.parametrize('closure', ['complete', 'superseded'])
async def test_coordination_replay_outlives_its_source_context(closure):
    async with provider_client(fixture_settings()) as (client, _):
        scope, grant_request = await setup_delegation(client)
        request, record = await internal_context(client, scope, grant_request, 'input_suggestion')
        task_input = {**scope, 'idempotency_key': 'completed-origin', 'title': 'Synthetic internal suggestion',
                      'objective': 'Check replay after context closure.', 'work_kind': 'implementation',
                      'lead_agent_id': 'member', 'coordinator_agent_id': 'lead', 'complexity_hint': 'simple',
                      'routing_reason': 'Synthetic replay acceptance.', 'source_application': 'codex',
                      'task_context_token': record['token']}
        original = await client.post('/v1/project-agent-tasks', json=task_input)
        assert original.status_code == 200, original.text
        if closure == 'complete':
            for phase in ['prepare', 'complete']:
                closed = await client.put(f'/v1/task-contexts/{record["token"]}/checkpoint', json={
                    'personal_space_id': scope['personal_space_id'], 'source_application': 'codex',
                    'phase': phase, 'disposition': 'retain_nothing', 'reason': 'Synthetic context closure.',
                    'fingerprint': 'a' * 64, 'work_log': {'status': 'reported', 'summary': 'Synthetic replay acceptance.'}})
                assert closed.status_code == 200, closed.text
        else:
            next_turn = {key: value for key, value in request.items() if key != 'delegation_token'}
            next_turn.update(token=f'fuli-task-{uuid4()}', turn_id='ordinary-next-turn')
            next_context = await client.put('/v1/task-contexts', json=next_turn)
            assert next_context.status_code == 200 and next_context.json()['activity_origin'] is None
        replay = await client.post('/v1/project-agent-tasks', json=task_input)
        assert replay.status_code == 200, replay.text
        assert replay.json()['task']['activity_origin'] == original.json()['task']['activity_origin']
        fresh = await client.post('/v1/project-agent-tasks', json={**task_input, 'idempotency_key': 'new-after-closure'})
        assert fresh.status_code in {404, 409}, fresh.text


@pytest.mark.asyncio
@pytest.mark.parametrize('legacy', [False, True])
async def test_sealed_worker_context_is_internal_without_relabelling_its_user_parent_task(legacy, monkeypatch):
    from fuli_graph import store_task_contexts
    original_origin = store_task_contexts.context_activity_origin
    if legacy:
        async def old_origin(*args, **kwargs):
            return None
        monkeypatch.setattr(store_task_contexts, 'context_activity_origin', old_origin)
    async with provider_client(fixture_settings()) as (client, _):
        scope, payload, headers = await worker_run_fixture(client)
        response = await client.put('/v1/project-agent-worker-runs', json=payload)
        assert response.status_code == 200, response.text
        path = f'/v1/project-agent-worker-runs/{response.json()["run_id"]}'
        assert (await client.post(path + '/start-claim', json=scope, headers=headers)).status_code == 200
        session = {**scope, 'source_application': 'codex', 'session_id': f'origin-worker-{uuid4()}'}
        assert (await client.put(path + '/session', json=session, headers=headers)).status_code == 200
        own = await client.post(path + '/contexts', json=session, headers=headers)
        assert own.status_code == 200, own.text
        origin = None if legacy else {'version': 1, 'kind': 'ai_internal', 'source': 'sealed_worker', 'purpose': 'delegated_work'}
        assert own.json()['task_context'].get('activity_origin') == origin
        monkeypatch.setattr(store_task_contexts, 'context_activity_origin', original_origin)
        retried = await client.post(path + '/contexts', json=session, headers=headers)
        assert retried.status_code == 200 and retried.json()['task_context']['activity_origin'] == origin
        parent = await client.get(f'/v1/project-agent-tasks/{payload["task_id"]}', params=scope)
        assert parent.status_code == 200 and parent.json()['activity_origin'] is None
