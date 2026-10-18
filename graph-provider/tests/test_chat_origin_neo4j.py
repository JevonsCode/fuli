"""Pure chat authority for assigned Agents, on an explicitly disposable graph."""
import json
from base64 import urlsafe_b64decode

import pytest
from test_agent_delegations_neo4j import setup_delegation
from test_project_agent_memory_neo4j import fixture_settings, provider_client
from test_remote_agent_authority_neo4j import origin


@pytest.mark.asyncio
async def test_member_chat_proof_cannot_sign_an_execution_and_expires_with_its_task():
    async with provider_client(fixture_settings()) as (client, _):
        scope, request = await setup_delegation(client)
        token = request['task_context_token'] + '-member-chat'
        begun = await client.put('/v1/task-contexts', json={
            **scope, 'token': token, 'project_agent_id': 'member', 'source_application': 'codex',
            'session_id': 'synthetic-member-chat', 'turn_id': 'chat-turn'})
        assert begun.status_code == 200, begun.text
        body = origin({**request, 'task_context_token': token}, message_id='chat-1', purpose='chat')
        issued = await client.post('/v1/project-agent-context/remote-origins', json=body)
        assert issued.status_code == 200, issued.text
        encoded = issued.json()['proof']['payload']
        claims = json.loads(urlsafe_b64decode(encoded + '=' * (-len(encoded) % 4)))
        assert claims['purpose'] == 'chat' and claims['agent_id'] == 'member'
        assert claims['version'] == 'fuli-chat-origin/1'
        same_id_execution = await client.post('/v1/project-agent-context/remote-origins', json={**body, 'purpose': 'execution'})
        assert same_id_execution.status_code == 403
        ordinary = await client.post('/v1/project-agent-context/remote-origins', json={**body, 'message_id': 'exec-2', 'purpose': 'execution'})
        assert ordinary.status_code == 403
        next_turn = await client.put('/v1/task-contexts', json={
            **scope, 'token': token + '-next', 'project_agent_id': 'member', 'source_application': 'codex',
            'session_id': 'synthetic-member-chat', 'turn_id': 'chat-next'})
        assert next_turn.status_code == 200, next_turn.text
        stale = await client.post('/v1/project-agent-context/remote-origins', json={**body, 'message_id': 'stale-chat'})
        assert stale.status_code in {404, 409}, stale.text
