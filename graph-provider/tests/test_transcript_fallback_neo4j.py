"""Fallback transcript recovery on synthetic, disposable graph state."""
from uuid import uuid4
import pytest
from test_project_agent_memory_neo4j import fixture_settings, provider_client, seed_agent


@pytest.mark.asyncio
@pytest.mark.parametrize('via', ['tool', 'hook'])
async def test_fallback_boundary_records_only_omission_and_rejects_stale_tokens(via, monkeypatch):
    from fuli_graph.store_agent_conversations import StoreAgentConversations
    async with provider_client(fixture_settings(), raise_app_exceptions=False) as (client, _):
        space = (await client.post('/v1/spaces', json={'name': 'Synthetic fallback', 'kind': 'personal'})).json()['id']
        await seed_agent(client, space)
        scope = dict(personal_space_id=space, personal_project_id='sample-project',
                     agent_id='engineer', source_application='codex', session_id='fallback-session')
        async def begin(via='tool', session='fallback-session'):
            token = f'fuli-task-{uuid4().hex}'
            response = await client.put('/v1/task-contexts', json={
                **{key: value for key, value in scope.items() if key != 'agent_id'},
                'project_agent_id': 'engineer', 'session_id': session, 'token': token, 'entry_via': via})
            assert response.status_code == 200, response.text
            return token
        old = await begin('hook')
        initialized = await client.post('/v1/agent-conversations/boundary', json={
            **scope, 'task_context_token': old, 'expected_cursor': 0, 'cursor': 10, 'initialize_cursor': True})
        assert initialized.status_code == 200, initialized.text
        new = await begin(via)
        request = {**scope, 'task_context_token': new, 'expected_cursor': 10, 'cursor': 100,
                   'fallback_recovery': True}
        for changes in [dict(task_context_token=old), dict(session_id='foreign-session')]:
            denied = await client.post('/v1/agent-conversations/boundary', json={**request, **changes})
            assert denied.status_code in {404, 409}, denied.text
        # Simulate a committed pre-upgrade marker whose response was lost. The
        # stable event ID must keep exactly the old canonical marker bytes.
        original_append = StoreAgentConversations.append_conversation
        async def append_old_marker(store, actor, write):
            events = [event.model_copy(update={'content': event.content.replace('during handoff', 'after fallback')})
                      for event in write.events]
            return await original_append(store, actor, write.model_copy(update={'events': events}))
        monkeypatch.setattr(StoreAgentConversations, 'append_conversation', append_old_marker)
        recovered = await client.post('/v1/agent-conversations/boundary', json=request)
        monkeypatch.setattr(StoreAgentConversations, 'append_conversation', original_append)
        assert recovered.status_code == 200, recovered.text
        assert recovered.json()['status'] == 'saved'
        retry = await client.post('/v1/agent-conversations/boundary', json=request)
        assert retry.status_code == 200, retry.text
        assert retry.json()['revision'] == recovered.json()['revision']
        stale = await client.post('/v1/agent-conversations/boundary', json={
            **request, 'expected_cursor': 50})
        assert stale.status_code == 409, stale.text
        injected = await client.post('/v1/agent-conversations/boundary', json={
            **request, 'events': [{'event_id': 'injected', 'role': 'user', 'content': 'Unverified native text'}]})
        assert injected.status_code == 422, injected.text
        history = await client.post('/v1/agent-conversations/query', json={
            **{key: value for key, value in scope.items() if key != 'session_id'},
            'mode': 'events', 'conversation_id': recovered.json()['conversation_id']})
        assert history.status_code == 200, history.text
        events = history.json()['events']
        assert len(events) == 1 and events[0]['role'] == 'tool'
        assert 'omitted' in events[0]['content'] and 'unverified' in events[0]['content']
        state = await client.post('/v1/agent-conversations/query', json={**scope, 'mode': 'session'})
        assert state.json()['cursor'] == 100
        replacement = await begin('hook')
        rejected = await client.post('/v1/agent-conversations/boundary', json={
            **request, 'expected_cursor': 100, 'cursor': 200})
        assert rejected.status_code in {404, 409}, rejected.text
        invalid = await client.put('/v1/task-contexts', json={
            **{key: value for key, value in scope.items() if key != 'agent_id'},
            'project_agent_id': 'engineer', 'token': replacement, 'entry_via': 'unknown'})
        assert invalid.status_code == 422, invalid.text


@pytest.mark.asyncio
@pytest.mark.parametrize('via', ['tool', 'hook'])
async def test_fallback_omission_and_scope_transfer_roll_back_together(monkeypatch, via):
    from fuli_graph.store_agent_conversations import StoreAgentConversations
    async with provider_client(fixture_settings(), raise_app_exceptions=False) as (client, _):
        space = (await client.post('/v1/spaces', json={'name': 'Synthetic atomic fallback', 'kind': 'personal'})).json()['id']
        await seed_agent(client, space)
        await seed_agent(client, space, agent='replacement')
        scope = dict(personal_space_id=space, personal_project_id='sample-project',
                     source_application='codex', session_id='atomic-fallback')
        async def begin(agent, via):
            token = f'fuli-task-{uuid4().hex}'
            response = await client.put('/v1/task-contexts', json={**scope,
                'project_agent_id': agent, 'token': token, 'entry_via': via})
            assert response.status_code == 200, response.text
            return token
        old = await begin('engineer', 'hook')
        initialized = await client.post('/v1/agent-conversations/boundary', json={
            **scope, 'agent_id': 'engineer', 'task_context_token': old,
            'expected_cursor': 0, 'cursor': 10, 'initialize_cursor': True})
        assert initialized.status_code == 200, initialized.text
        new = await begin('replacement', via)
        original = StoreAgentConversations.append_conversation
        interrupted = False
        async def fail_once(store, actor, request):
            nonlocal interrupted
            if not interrupted and request.events and request.events[0].event_id.endswith(':fallback'):
                interrupted = True
                raise RuntimeError('Synthetic interruption after scope transfer')
            return await original(store, actor, request)
        monkeypatch.setattr(StoreAgentConversations, 'append_conversation', fail_once)
        request = {**scope, 'agent_id': 'replacement', 'task_context_token': new,
                   'expected_cursor': 10, 'cursor': 100, 'fallback_recovery': True}
        failed = await client.post('/v1/agent-conversations/boundary', json=request)
        assert interrupted and failed.status_code == 500, failed.text
        state = await client.post('/v1/agent-conversations/query', json={
            **scope, 'agent_id': 'replacement', 'mode': 'session'})
        assert state.json()['cursor'] == 10
        # The old scope also remains: the replacement cannot append raw text.
        raw = await client.post('/v1/agent-conversations/append', json={
            **request, 'fallback_recovery': False, 'cursor': 20,
            'events': [{'event_id': 'not-owned', 'role': 'user', 'content': 'Unverified text'}]})
        assert raw.status_code == 409, raw.text
        recovered = await client.post('/v1/agent-conversations/boundary', json=request)
        assert recovered.status_code == 200, recovered.text
        assert recovered.json()['revision'] == 1


@pytest.mark.asyncio
async def test_fallback_can_recover_a_guard_whose_initial_boundary_never_committed():
    async with provider_client(fixture_settings(), raise_app_exceptions=False) as (client, _):
        space = (await client.post('/v1/spaces', json={'name': 'Synthetic uninitialized fallback', 'kind': 'personal'})).json()['id']
        await seed_agent(client, space)
        token = f'fuli-task-{uuid4().hex}'
        scope = dict(personal_space_id=space, personal_project_id='sample-project',
                     source_application='codex', session_id='uninitialized-fallback')
        begun = await client.put('/v1/task-contexts', json={**scope,
            'project_agent_id': 'engineer', 'token': token, 'entry_via': 'tool'})
        assert begun.status_code == 200, begun.text
        recovered = await client.post('/v1/agent-conversations/boundary', json={**scope,
            'agent_id': 'engineer', 'task_context_token': token, 'expected_cursor': 0,
            'cursor': 100, 'fallback_recovery': True})
        assert recovered.status_code == 200, recovered.text
        state = await client.post('/v1/agent-conversations/query', json={
            **scope, 'agent_id': 'engineer', 'mode': 'session'})
        assert state.json()['cursor'] == 100 and state.json()['initialized'] is True
