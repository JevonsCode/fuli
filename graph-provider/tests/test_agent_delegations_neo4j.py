"""Real Provider capability isolation on an explicitly disposable graph."""

import asyncio

import pytest

from test_project_agent_memory_neo4j import fixture_settings, provider_client, seed_agent
from test_system_hr_identity_neo4j import _create_space


async def setup_delegation(client):
    space_id = await _create_space(client, 'Synthetic delegation isolation')
    for agent in ['lead', 'member', 'other']:
        await seed_agent(client, space_id, agent=agent)
    scope = {'personal_space_id': space_id, 'personal_project_id': 'sample-project'}
    response = await client.put('/v1/project-agent-coordination-policy', json={
        **scope, 'team_lead_agent_id': 'lead', 'team_member_agent_ids': ['member', 'other']})
    assert response.status_code == 200, response.text
    token = f'fuli-task-{space_id}'
    response = await client.put('/v1/task-contexts', json={
        **scope, 'token': token, 'project_agent_id': 'lead', 'source_application': 'codex',
        'session_id': 'synthetic-lead-session', 'turn_id': 'synthetic-turn'})
    assert response.status_code == 200, response.text
    return scope, {'personal_space_id': space_id, 'task_context_token': token,
                   'source_application': 'codex', 'agent_id': 'member', 'target_application': 'codex'}


async def issue(client, payload):
    response = await client.post('/v1/project-agent-context/delegations', json=payload)
    assert response.status_code == 200, response.text
    return response.json()['token']


async def resolve(client, scope, token, session, **changes):
    response = await client.post('/v1/project-agent-context/resolve', json={
        **scope, 'source_application': 'codex', 'agent_id': 'member',
        'delegation_token': token, 'delegation_session_id': session, **changes})
    assert response.status_code == 200, response.text
    return response.json()


@pytest.mark.asyncio
async def test_resumed_grant_rejects_replay_and_is_revoked_after_delivery():
    async with provider_client(fixture_settings()) as (client, _):
        scope, request = await setup_delegation(client)
        token = await issue(client, {**request, 'target_session_id': 'intended-session'})
        for session, changes in [('unrelated-session', {}), ('intended-session', {'agent_id': 'other'}),
                                 ('intended-session', {'source_application': 'claude_code'})]:
            denied = await resolve(client, scope, token, session, **changes)
            assert denied['status'] == 'agent_unavailable'
            assert denied['agent'] is None
        for _ in range(2):
            member = await resolve(client, scope, token, 'intended-session')
            assert member['agent']['agent_id'] == 'member'
            assert member['reporting_lead_agent_id'] == 'lead'
        check = {'personal_space_id': scope['personal_space_id'], 'token': token, 'session_id': 'intended-session'}
        verified = await client.post('/v1/project-agent-context/delegations/verify', json=check)
        assert verified.json() == {'redeemed': True}
        wrong = await client.post('/v1/project-agent-context/delegations/verify', json={**check, 'session_id': 'unrelated-session'})
        assert wrong.json() == {'redeemed': False}
        revoked = await client.post('/v1/project-agent-context/delegations/revoke', json=check)
        assert revoked.status_code == 200
        assert (await resolve(client, scope, token, 'intended-session'))['status'] == 'agent_unavailable'


@pytest.mark.asyncio
async def test_fresh_grant_can_only_bind_one_receiving_session_even_concurrently():
    async with provider_client(fixture_settings()) as (client, _):
        scope, request = await setup_delegation(client)
        token = await issue(client, request)
        responses = await asyncio.gather(*[
            resolve(client, scope, token, session) for session in ['fresh-session-a', 'fresh-session-b']])
        assert sorted(result['status'] for result in responses) == ['agent_unavailable', 'ready']
        winner = ['fresh-session-a', 'fresh-session-b'][next(i for i, r in enumerate(responses) if r['status'] == 'ready')]
        assert (await resolve(client, scope, token, winner))['agent']['agent_id'] == 'member'


@pytest.mark.asyncio
async def test_superseded_sender_or_handed_off_lead_cannot_restore_member_context():
    async with provider_client(fixture_settings()) as (client, _):
        scope, request = await setup_delegation(client)
        token = await issue(client, request)
        response = await client.put('/v1/task-contexts', json={
            **scope, 'token': request['task_context_token'] + '-next', 'project_agent_id': 'lead',
            'source_application': 'codex', 'session_id': 'synthetic-lead-session', 'turn_id': 'next-turn'})
        assert response.status_code == 200, response.text
        assert (await resolve(client, scope, token, 'fresh-session'))['status'] == 'agent_unavailable'
        rejected = await client.post('/v1/project-agent-context/delegations', json=request)
        assert rejected.status_code == 404
        token = await issue(client, {**request, 'task_context_token': request['task_context_token'] + '-next'})
        policy = await client.put('/v1/project-agent-coordination-policy', json={
            **scope, 'team_lead_agent_id': 'other', 'team_member_agent_ids': ['member']})
        assert policy.status_code == 200, policy.text
        assert (await resolve(client, scope, token, 'fresh-session'))['status'] == 'agent_unavailable'


@pytest.mark.asyncio
async def test_expired_grant_cannot_restore_a_member(monkeypatch):
    from graphiti_core.driver.neo4j_driver import Neo4jDriver
    execute = Neo4jDriver.execute_query

    async def expire_fixture(driver, query, **kwargs):
        if 'CREATE (:FuliAgentDelegation' in query:
            kwargs['lifetime'] = -1  # Fast expiry only in this disposable test graph.
        return await execute(driver, query, **kwargs)

    async with provider_client(fixture_settings()) as (client, _):
        scope, request = await setup_delegation(client)
        with monkeypatch.context() as patch:
            patch.setattr(Neo4jDriver, 'execute_query', expire_fixture)
            token = await issue(client, request)
        assert (await resolve(client, scope, token, 'fresh-session'))['status'] == 'agent_unavailable'


@pytest.mark.asyncio
async def test_reporting_label_or_wrong_project_does_not_authorize_delegation():
    async with provider_client(fixture_settings()) as (client, _):
        scope, request = await setup_delegation(client)
        supplied = await client.post('/v1/project-agent-context/resolve', json={
            **scope, 'source_application': 'codex', 'agent_id': 'member', 'report_to_agent_id': 'lead'})
        assert supplied.status_code == 422
        token = await issue(client, request)
        await seed_agent(client, scope['personal_space_id'], project='other-project', agent='member')
        denied = await resolve(client, {**scope, 'personal_project_id': 'other-project'}, token, 'fresh-session')
        assert denied['status'] == 'agent_unavailable'


@pytest.mark.asyncio
async def test_handoff_during_redemption_cannot_use_a_stale_lead(monkeypatch):
    from graphiti_core.driver.neo4j_driver import Neo4jDriver
    reached, proceed = asyncio.Event(), asyncio.Event()
    execute = Neo4jDriver.execute_query

    async def pause_claim(driver, query, **kwargs):
        if 'grant.redeemed = true' in query:
            reached.set()
            await proceed.wait()
        return await execute(driver, query, **kwargs)

    async with provider_client(fixture_settings()) as (client, _):
        scope, request = await setup_delegation(client)
        token = await issue(client, request)
        with monkeypatch.context() as patch:
            patch.setattr(Neo4jDriver, 'execute_query', pause_claim)
            claiming = asyncio.create_task(resolve(client, scope, token, 'fresh-session'))
            try:
                await asyncio.wait_for(reached.wait(), timeout=5)
                handoff = await client.put('/v1/project-agent-coordination-policy', json={
                    **scope, 'team_lead_agent_id': 'other', 'team_member_agent_ids': ['member']})
                assert handoff.status_code == 200, handoff.text
            finally:
                proceed.set()
            assert (await claiming)['status'] == 'agent_unavailable'


@pytest.mark.asyncio
async def test_cross_client_member_does_not_require_its_lead_to_run_in_that_client():
    async with provider_client(fixture_settings()) as (client, _):
        scope, request = await setup_delegation(client)
        await seed_agent(client, scope['personal_space_id'], agent='lead', allowed_clients=['codex'])
        await seed_agent(client, scope['personal_space_id'], agent='member', allowed_clients=['claude_code'])
        token = await issue(client, {**request, 'target_application': 'claude_code'})
        result = await resolve(client, scope, token, 'claude-fork', source_application='claude_code')
        assert result['status'] == 'ready'
        assert result['agent']['agent_id'] == 'member'
        assert result['reporting_lead_agent_id'] == 'lead'
