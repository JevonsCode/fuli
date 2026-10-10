"""Remote-device authority on an explicitly disposable graph."""

import asyncio
import json
from base64 import urlsafe_b64decode
from datetime import datetime, timedelta, timezone
from hashlib import sha256

from nacl.exceptions import BadSignatureError
from nacl.signing import VerifyKey

import pytest

from test_agent_delegations_neo4j import resolve, setup_delegation
from test_project_agent_memory_neo4j import fixture_settings, provider_client, seed_agent

NODE = 'a' * 64
OTHER_NODE = 'b' * 64
DIGEST = 'c' * 64


def remote_grant(scope, **changes):
    return {**scope, 'agent_id': 'lead', 'target_application': 'codex', 'origin_node': NODE,
            'origin_message_id': 'message-1', 'origin_attempt_id': 'attempt-1', **changes}


def iso_after(delta):
    moment = datetime.now(timezone.utc) + delta
    return moment.strftime('%Y-%m-%dT%H:%M:%S.') + f'{moment.microsecond // 1000:03d}Z'


def origin(request, **changes):
    return {'personal_space_id': request['personal_space_id'], 'task_context_token': request['task_context_token'],
            'source_application': 'codex', 'message_id': 'message-1', 'digest': DIGEST, 'target_node': OTHER_NODE,
            'binding_id': 'binding-1', 'expires_at': iso_after(timedelta(minutes=20)), **changes}


def b64(value):
    return urlsafe_b64decode(value + '=' * (-len(value) % 4))


@pytest.mark.asyncio
async def test_remote_grant_only_restores_the_current_lead_once_per_attempt():
    async with provider_client(fixture_settings()) as (client, _):
        scope, _request = await setup_delegation(client)
        member = await client.post('/v1/project-agent-context/remote-delegations', json=remote_grant(scope, agent_id='member'))
        assert member.status_code == 403
        await seed_agent(client, scope['personal_space_id'], agent='lead', allowed_clients=['codex'])
        wrong_client = await client.post('/v1/project-agent-context/remote-delegations',
                                         json=remote_grant(scope, target_application='claude_code', origin_attempt_id='attempt-x'))
        assert wrong_client.status_code == 403
        issued = await client.post('/v1/project-agent-context/remote-delegations', json=remote_grant(scope))
        assert issued.status_code == 200, issued.text
        token = issued.json()['token']
        replay = await client.post('/v1/project-agent-context/remote-delegations', json=remote_grant(scope))
        assert replay.status_code == 409
        denied = await resolve(client, scope, token, 'remote-session', agent_id='member')
        assert denied['status'] == 'agent_unavailable'
        restored = await resolve(client, scope, token, 'remote-session', agent_id='lead')
        assert restored['status'] == 'ready'
        assert restored['agent']['agent_id'] == 'lead'
        assert restored['reporting_lead_agent_id'] is None
        other_session = await resolve(client, scope, token, 'another-session', agent_id='lead')
        assert other_session['status'] == 'agent_unavailable'
        verified = await client.post('/v1/project-agent-context/delegations/verify', json={
            'personal_space_id': scope['personal_space_id'], 'token': token, 'session_id': 'remote-session'})
        assert verified.json() == {'redeemed': True}


@pytest.mark.asyncio
async def test_remote_grant_cannot_restore_a_lead_after_handoff():
    async with provider_client(fixture_settings()) as (client, _):
        scope, _request = await setup_delegation(client)
        issued = await client.post('/v1/project-agent-context/remote-delegations',
                                   json=remote_grant(scope, origin_attempt_id='attempt-2'))
        assert issued.status_code == 200, issued.text
        handoff = await client.put('/v1/project-agent-coordination-policy', json={
            **scope, 'team_lead_agent_id': 'other', 'team_member_agent_ids': ['member']})
        assert handoff.status_code == 200, handoff.text
        result = await resolve(client, scope, issued.json()['token'], 'remote-session', agent_id='lead')
        assert result['status'] == 'agent_unavailable'


@pytest.mark.asyncio
async def test_remote_grant_for_a_project_in_another_space_is_rejected():
    async with provider_client(fixture_settings()) as (client, _):
        scope, _request = await setup_delegation(client)
        foreign, _ = await setup_delegation(client)
        await seed_agent(client, foreign['personal_space_id'], project='sample-project', agent='lead')
        mixed = await client.post('/v1/project-agent-context/remote-delegations', json=remote_grant(
            {**scope, 'personal_project_id': 'missing-project'}, origin_attempt_id='attempt-3'))
        assert mixed.status_code in {403, 404}


@pytest.mark.asyncio
async def test_origin_is_signed_only_for_the_live_lead_task_and_exact_message():
    async with provider_client(fixture_settings()) as (client, _):
        scope, request = await setup_delegation(client)
        authority = await client.get('/v1/project-agent-context/remote-origin-authority',
                                     params={'personal_space_id': request['personal_space_id']})
        assert authority.status_code == 200, authority.text
        key = authority.json()
        assert set(key) == {'algorithm', 'key_id', 'public_key'}
        again = await client.get('/v1/project-agent-context/remote-origin-authority',
                                 params={'personal_space_id': request['personal_space_id']})
        assert again.json() == key

        issued = await client.post('/v1/project-agent-context/remote-origins', json=origin(request))
        assert issued.status_code == 200, issued.text
        proof = issued.json()['proof']
        payload, signature = b64(proof['payload']), b64(proof['signature'])
        public = VerifyKey(b64(key['public_key']))
        public.verify(payload, signature)
        claims = json.loads(payload)
        assert claims == {
            'version': 'fuli-remote-origin/1', 'key_id': key['key_id'], 'space_id': request['personal_space_id'],
            'project_id': 'sample-project', 'agent_id': 'lead',
            'task_hash': sha256(request['task_context_token'].encode()).hexdigest(), 'message_id': 'message-1',
            'digest': DIGEST, 'target_node': OTHER_NODE, 'binding_id': 'binding-1',
            'issued_at': claims['issued_at'], 'expires_at': claims['expires_at']}
        assert 'private' not in issued.text and 'private' not in authority.text
        # Changing any signed statement (sender, target, project) breaks the signature.
        for field, value in [('agent_id', 'member'), ('target_node', NODE), ('project_id', 'other-project')]:
            forged = json.dumps({**claims, field: value}, sort_keys=True, separators=(',', ':')).encode()
            with pytest.raises(BadSignatureError):
                public.verify(forged, signature)

        reused = await client.post('/v1/project-agent-context/remote-origins', json=origin(request, digest='d' * 64))
        assert reused.status_code == 409
        retarget = await client.post('/v1/project-agent-context/remote-origins',
                                     json=origin(request, binding_id='binding-2'))
        assert retarget.status_code == 409

        superseded = await client.put('/v1/task-contexts', json={
            **scope, 'token': request['task_context_token'] + '-next', 'project_agent_id': 'lead',
            'source_application': 'codex', 'session_id': 'synthetic-lead-session', 'turn_id': 'next-turn'})
        assert superseded.status_code == 200, superseded.text
        stale = await client.post('/v1/project-agent-context/remote-origins', json=origin(request, message_id='message-2'))
        assert stale.status_code == 404


@pytest.mark.asyncio
async def test_members_cannot_sign_remote_asks_past_their_lead():
    async with provider_client(fixture_settings()) as (client, _):
        scope, request = await setup_delegation(client)
        member_token = request['task_context_token'] + '-member'
        response = await client.put('/v1/task-contexts', json={
            **scope, 'token': member_token, 'project_agent_id': 'member', 'source_application': 'codex',
            'session_id': 'synthetic-member-session', 'turn_id': 'member-turn'})
        assert response.status_code == 200, response.text
        denied = await client.post('/v1/project-agent-context/remote-origins',
                                   json=origin({**request, 'task_context_token': member_token}, message_id='member-ask'))
        assert denied.status_code == 403
        handoff = await client.put('/v1/project-agent-coordination-policy', json={
            **scope, 'team_lead_agent_id': 'other', 'team_member_agent_ids': ['member', 'lead']})
        assert handoff.status_code == 200, handoff.text
        former = await client.post('/v1/project-agent-context/remote-origins', json=origin(request, message_id='after-handoff'))
        assert former.status_code == 403


@pytest.mark.asyncio
async def test_origin_rejects_a_lifetime_beyond_the_short_bound():
    async with provider_client(fixture_settings()) as (client, _):
        _scope, request = await setup_delegation(client)
        too_long = await client.post('/v1/project-agent-context/remote-origins',
                                     json=origin(request, expires_at=iso_after(timedelta(minutes=31))))
        assert too_long.status_code == 422
        past = await client.post('/v1/project-agent-context/remote-origins',
                                 json=origin(request, expires_at=iso_after(timedelta(seconds=-1))))
        assert past.status_code == 422
        loose = await client.post('/v1/project-agent-context/remote-origins',
                                  json=origin(request, expires_at='2030-01-01T00:00:00+00:00'))
        assert loose.status_code == 422


@pytest.mark.asyncio
async def test_concurrent_first_use_creates_one_authority_key():
    async with provider_client(fixture_settings()) as (client, _):
        _scope, request = await setup_delegation(client)
        responses = await asyncio.gather(*[
            client.get('/v1/project-agent-context/remote-origin-authority',
                       params={'personal_space_id': request['personal_space_id']}) for _ in range(8)])
        assert all(response.status_code == 200 for response in responses), [r.text for r in responses]
        assert len({response.json()['public_key'] for response in responses}) == 1


# A new task turn or a lead handoff that commits while an origin is being issued
# must win: the origin is checked again under the same locks those writers take.
async def _origin_after_change(monkeypatch, change):
    from graphiti_core.driver.neo4j_driver import Neo4jDriver

    reached, proceed = asyncio.Event(), asyncio.Event()
    execute = Neo4jDriver.execute_query

    async def pause_origin(driver, query, **kwargs):
        if 'MERGE (origin:FuliRemoteAgentOrigin' in query:
            reached.set()
            await proceed.wait()
        return await execute(driver, query, **kwargs)

    async with provider_client(fixture_settings()) as (client, _):
        scope, request = await setup_delegation(client)
        authority = await client.get('/v1/project-agent-context/remote-origin-authority',
                                     params={'personal_space_id': scope['personal_space_id']})
        assert authority.status_code == 200, authority.text
        with monkeypatch.context() as patch:
            patch.setattr(Neo4jDriver, 'execute_query', pause_origin)
            issuing = asyncio.create_task(client.post('/v1/project-agent-context/remote-origins',
                                                      json=origin(request)))
            try:
                await asyncio.wait_for(reached.wait(), timeout=10)
                if change == 'supersede':
                    changed = await client.put('/v1/task-contexts', json={
                        **scope, 'token': request['task_context_token'] + '-next',
                        'project_agent_id': 'lead', 'source_application': 'codex',
                        'session_id': 'synthetic-lead-session', 'turn_id': 'next-turn'})
                else:
                    changed = await client.put('/v1/project-agent-coordination-policy', json={
                        **scope, 'team_lead_agent_id': 'other', 'team_member_agent_ids': ['member', 'lead']})
                assert changed.status_code == 200, changed.text
            finally:
                proceed.set()
                response = await issuing

        # A fresh request is refused too, so the old one was checked against the same state.
        fresh = await client.post('/v1/project-agent-context/remote-origins',
                                  json=origin(request, message_id='after-change'))
        assert fresh.status_code in {403, 404, 409}, fresh.text

        assert response.status_code in {403, 404}, f'{change}: status={response.status_code} {response.text}'
        assert 'proof' not in response.text


@pytest.mark.asyncio
async def test_origin_cannot_be_issued_after_source_task_is_superseded(monkeypatch):
    await _origin_after_change(monkeypatch, 'supersede')


@pytest.mark.asyncio
async def test_origin_cannot_be_issued_after_source_lead_handoff(monkeypatch):
    await _origin_after_change(monkeypatch, 'handoff')
