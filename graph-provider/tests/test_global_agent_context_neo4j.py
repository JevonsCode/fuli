"""Global identity, conversations and working notes against a disposable graph."""
from uuid import uuid4
import pytest
from test_project_agent_memory_neo4j import (
    dismiss_agent, fixture_settings, provider_client, seed_agent, write_payload,
)


@pytest.mark.asyncio
async def test_global_context_survives_assignment_and_remains_isolated():
    async with provider_client(fixture_settings()) as (client, _):
        space = (await client.post('/v1/spaces', json={
            'name': 'Synthetic global context', 'kind': 'personal'})).json()['id']
        response = await client.put('/v1/project-agents', json={
            'occupation': {'role': 'engineering'},
            'personal_space_id': space, 'agent_id': 'engineer',
            'profile': {'name': 'Synthetic global engineer', 'responsibility': 'Global work.',
                'allowed_clients': ['codex', 'claude_code']}})
        assert response.status_code == 200, response.text
        scope = dict(personal_space_id=space, agent_id='engineer', source_application='codex')
        # The identity exists before any project or assignment does.
        preferences = await client.get('/v1/collaboration-preferences', params={
            'personal_space_id': space, 'project_agent_id': 'engineer'})
        assert preferences.status_code == 200, preferences.text
        assert preferences.json()['personal_project_id'] is None
        memory = await client.get('/v1/project-agents/engineer/memory', params={'personal_space_id': space})
        assert memory.status_code == 200, memory.text
        assert memory.json()['scope'] == 'private_agent_global'
        assert memory.json()['revision'] == 0

        async def begin(session, project=None, source='codex'):
            token = 'fuli-task-' + uuid4().hex
            response = await client.put('/v1/task-contexts', json={
                'personal_space_id': space, 'personal_project_id': project,
                'project_agent_id': 'engineer', 'session_id': session,
                'source_application': source, 'token': token})
            assert response.status_code == 200, response.text
            return token

        token = await begin('global-session')
        base = {**scope, 'session_id': 'global-session', 'task_context_token': token}
        saved = await client.post('/v1/agent-conversations/append', json={**base,
            'events': [{'event_id': 'first', 'role': 'user', 'content': 'Global synthetic message.'}]})
        assert saved.status_code == 200, saved.text
        cid = saved.json()['conversation_id']
        checkpoint = {'personal_space_id': space, 'source_application': 'codex',
            'phase': 'prepare', 'disposition': 'retain_nothing', 'reason': 'Synthetic global work.',
            'fingerprint': 'c' * 64, 'work_log': {'status': 'completed', 'summary': 'Global result.'},
            'agent_memory': {'expected_revision': 0, 'memory': {'summary': 'Global working notes.'}}}
        prepared = await client.put(f'/v1/task-contexts/{token}/checkpoint', json=checkpoint)
        assert prepared.status_code == 200, prepared.text
        assert prepared.json()['agent_memory']['personal_project_id'] is None
        retry = await client.put(f'/v1/task-contexts/{token}/checkpoint', json=checkpoint)
        assert retry.status_code == 200, retry.text
        assert retry.json()['agent_memory']['revision'] == 1
        completed = await client.put(f'/v1/task-contexts/{token}/checkpoint', json={
            **{k: v for k, v in checkpoint.items() if k != 'agent_memory'}, 'phase': 'complete'})
        assert completed.status_code == 200, completed.text
        global_policy = {'compact_after_kb': 32, 'context_budget': 1000, 'enabled': True}
        assert (await client.put('/v1/agent-conversations/policy', json={
            **scope, 'policy': global_policy})).status_code == 200
        # Another client restores the same global conversation with a fresh token.
        second = await begin('second-client', source='claude_code')
        resumed = await client.post('/v1/agent-conversations/resume', json={**scope,
            'source_application': 'claude_code', 'session_id': 'second-client',
            'task_context_token': second, 'conversation_id': cid})
        assert resumed.status_code == 200, resumed.text

        # Later assignments never move or merge the global data.
        for project in ['project-a', 'project-b']:
            await seed_agent(client, space, project=project, allowed_clients=['codex', 'claude_code'])
            local = {**scope, 'personal_project_id': project}
            listing = await client.post('/v1/agent-conversations/query', json=local)
            assert listing.json() == {'conversations': []}
            policy = await client.post('/v1/agent-conversations/query', json={**local, 'mode': 'policy'})
            assert policy.json()['context_budget'] == 4000
            denied = await client.post('/v1/agent-conversations/query', json={**local,
                'mode': 'events', 'conversation_id': cid})
            assert denied.status_code == 404
            memory = await client.get('/v1/project-agents/engineer/memory', params={
                'personal_space_id': space, 'personal_project_id': project})
            assert memory.json()['revision'] == 0
            assert memory.json()['work_log'] == []
            saved = await client.put('/v1/project-agents/engineer/memory', json=write_payload(
                space, personal_project_id=project, memory={'summary': f'Notes for {project}.'}))
            assert saved.status_code == 200, saved.text
        project_token = await begin('project-session', project='project-a')
        mismatched = await client.post('/v1/agent-conversations/append', json={**base,
            'session_id': 'project-session', 'task_context_token': project_token})
        assert mismatched.status_code == 409
        assert (await client.post('/v1/agent-conversations/resume', json={**scope,
            'personal_project_id': 'project-a', 'session_id': 'project-session',
            'task_context_token': project_token, 'conversation_id': cid})).status_code == 404
        # Supplied but unassigned projects fail, rather than falling back to global.
        await client.put('/v1/personal-projects', json={'personal_space_id': space,
            'project_id': 'unassigned', 'profile': {'name': 'Synthetic unassigned'}})
        assert (await client.post('/v1/agent-conversations/query', json={**scope,
            'personal_project_id': 'unassigned'})).status_code == 404
        memory = await client.get('/v1/project-agents/engineer/memory', params={'personal_space_id': space})
        assert memory.json()['current']['memory']['summary'] == 'Global working notes.'
        assert memory.json()['revision'] == 1
        assert all(log['session_id'] != 'project-session' for log in memory.json()['work_log'])
        policy = await client.post('/v1/agent-conversations/query', json={**scope, 'mode': 'policy'})
        assert policy.json() == global_policy
        stale = await client.put('/v1/project-agents/engineer/memory', json=write_payload(
            space, personal_project_id=None, expected_revision=0))
        assert stale.status_code == 409
        assert (await client.post('/v1/agent-conversations/query', json={**scope,
            'source_application': 'cursor'})).status_code == 403
        other = (await client.post('/v1/spaces', json={
            'name': 'Synthetic other space', 'kind': 'personal'})).json()['id']
        assert (await client.post('/v1/agent-conversations/query', json={**scope,
            'personal_space_id': other, 'conversation_id': cid, 'mode': 'events'})).status_code == 404
        assert (await dismiss_agent(client, space, 'engineer')).status_code == 200
        assert (await client.put('/v1/project-agents/engineer/memory', json=write_payload(
            space, personal_project_id=None, expected_revision=1))).status_code == 409
