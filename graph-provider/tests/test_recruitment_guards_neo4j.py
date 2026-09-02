"""Public HTTP recruitment guards over a disposable real graph.

All roles and data are synthetic. Graph-port interruptions and a virtual clock
make pending-claim boundaries deterministic; no product worker is started.
"""

import asyncio
from datetime import timedelta

import pytest

from test_project_agent_memory_neo4j import fixture_settings, provider_client
from test_project_agent_staffing_neo4j import create_scope


async def hr_profile(client, scope, status='active'):
    if status == 'archived':
        response = await client.delete('/v1/project-agents/synthetic-hr', params={
            'personal_space_id': scope['personal_space_id'],
            'reason': 'Synthetic recruitment guard archive.',
        })
    else:
        response = await client.put('/v1/project-agents', json={
            'personal_space_id': scope['personal_space_id'],
            'agent_id': 'synthetic-hr',
            'profile': {
                'name': 'Synthetic recruiter',
                'responsibility': 'Audit sample hiring.',
                'agent_type': 'hr',
                'status': status,
            },
        })
    assert response.status_code == 200, response.text


async def recruitment_setup(client, *, confirmation):
    scope = await create_scope(client)
    await hr_profile(client, scope)
    policy = await client.put('/v1/project-agent-coordination-policy', json={
        **scope, 'ask_before_recruitment': confirmation, 'auto_reuse_previous_agent': True,
    })
    assert policy.status_code == 200, policy.text
    payload = {**scope, 'idempotency_key': 'synthetic-recruitment-guard',
               'title': 'Synthetic recruitment guard', 'objective': 'Verify claim boundaries.',
               'work_kind': 'verification', 'source_application': 'codex',
               'staffing_intent': 'new_durable', 'routing_reason': 'Synthetic acceptance.'}
    return scope, payload


async def recruitments(client, scope):
    response = await client.get('/v1/project-agent-recruitments', params=scope)
    assert response.status_code == 200, response.text
    return response.json()


async def agents(client, scope):
    response = await client.get('/v1/project-agents', params={
        'personal_space_id': scope['personal_space_id'],
    })
    assert response.status_code == 200, response.text
    return response.json()


def graph_fault(monkeypatch, inspect):
    from graphiti_core.driver.neo4j_driver import Neo4jDriver
    from fuli_graph.store_transactions import TransactionQueryDriver
    # Cover both the legacy autocommit port and its request-private transaction.
    def wrapper(execute):
        async def intercepted(driver, query, **kwargs):
            return await execute(driver, query, **inspect(query, kwargs))
        return intercepted
    for driver in [Neo4jDriver, TransactionQueryDriver]:
        monkeypatch.setattr(driver, 'execute_query', wrapper(driver.execute_query))


@pytest.mark.asyncio
async def test_failed_initial_recruitment_rolls_back_claim_and_retries_immediately(monkeypatch):
    async with provider_client(fixture_settings(), raise_app_exceptions=False) as (client, _):
        scope, payload = await recruitment_setup(client, confirmation=False)
        agents_before = await agents(client, scope)
        fired = False

        def interrupt_identity(query, kwargs):
            nonlocal fired
            if (not fired and kwargs.get('recruitment_id')
                    and 'SET agent.profile_json' in query):
                fired = True
                raise RuntimeError('Synthetic interruption before recruited identity creation')
            return kwargs

        graph_fault(monkeypatch, interrupt_identity)
        failed = await client.post('/v1/project-agent-tasks', json=payload)
        assert fired and failed.status_code == 500, failed.text
        assert await recruitments(client, scope) == []
        assert await agents(client, scope) == agents_before
        tasks = await client.get('/v1/project-agent-tasks', params=scope)
        assert tasks.json() == []

        retry = await client.post('/v1/project-agent-tasks', json=payload)
        assert retry.status_code == 200, retry.text
        recruitment = retry.json()['recruitment']
        assert recruitment['status'] == 'fulfilled'
        assert retry.json()['task']['lead_agent_id'] == recruitment['proposed_agent_id']
        assert len(await recruitments(client, scope)) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize('hr_status', ['inactive', 'archived'])
async def test_approval_rechecks_hr_active_status_before_any_provisioning(hr_status):
    async with provider_client(fixture_settings()) as (client, _):
        scope, payload = await recruitment_setup(client, confirmation=True)
        submitted = await client.post('/v1/project-agent-tasks', json=payload)
        assert submitted.status_code == 200, submitted.text
        recruitment = submitted.json()['recruitment']
        assert recruitment['status'] == 'awaiting_confirmation'
        await hr_profile(client, scope, hr_status)
        decision = await client.post(
            f'/v1/project-agent-recruitments/{recruitment["recruitment_id"]}/decision',
            json={**scope, 'recruitment_id': recruitment['recruitment_id'],
                  'decision': 'approve', 'expected_revision': recruitment['revision'],
                  'reason': 'Synthetic approval after HR status change.'},
        )
        assert decision.status_code == 409, decision.text
        assert (await recruitments(client, scope))[0] == recruitment
        identity = await client.get(f'/v1/project-agents/{recruitment["proposed_agent_id"]}',
                                    params={'personal_space_id': scope['personal_space_id']})
        assert identity.status_code == 404, identity.text


@pytest.mark.asyncio
async def test_activity_cancellation_rejects_unexpired_provisioning_claim(monkeypatch):
    async with provider_client(fixture_settings(), raise_app_exceptions=False) as (client, _):
        scope, payload = await recruitment_setup(client, confirmation=True)
        submitted = await client.post('/v1/project-agent-tasks', json=payload)
        assert submitted.status_code == 200, submitted.text
        pending = submitted.json()
        recruitment = pending['recruitment']
        task = pending['task']
        assert recruitment['status'] == 'awaiting_confirmation'
        assert task['status'] == 'awaiting_recruitment'

        fired = False

        def interrupt_before_provisioning(query, kwargs):
            nonlocal fired
            if (
                not fired
                and 'SET task._recruitment_write_lock = true' in query
                and kwargs.get('provisioning_claim_id')
            ):
                fired = True
                # The approval CAS has already committed the fresh claim in a
                # separate query. Fail at the first guarded provisioning query,
                # before identity or assignment writes can begin.
                raise RuntimeError(
                    'Synthetic interruption before recruitment provisioning'
                )
            return kwargs

        graph_fault(monkeypatch, interrupt_before_provisioning)
        failed = await client.post(
            f'/v1/project-agent-recruitments/{recruitment["recruitment_id"]}/decision',
            json={**scope, 'recruitment_id': recruitment['recruitment_id'],
                  'decision': 'approve', 'expected_revision': recruitment['revision'],
                  'reason': 'Synthetic approval interrupted before provisioning.'},
        )
        assert fired and failed.status_code == 500, failed.text

        claimed_task = (await client.get(
            f'/v1/project-agent-tasks/{task["task_id"]}',
            params=scope,
        )).json()
        claimed_recruitment = (await recruitments(client, scope))[0]
        assert claimed_task['status'] == 'awaiting_recruitment'
        assert claimed_task['revision'] == task['revision'] + 1
        assert claimed_recruitment['status'] == 'requested'
        assert claimed_recruitment['revision'] == recruitment['revision'] + 1

        identity = await client.get(
            f'/v1/project-agents/{recruitment["proposed_agent_id"]}',
            params={'personal_space_id': scope['personal_space_id']},
        )
        assert identity.status_code == 404, identity.text

        cancellation = await client.post(
            f'/v1/project-agent-tasks/{task["task_id"]}/events',
            json={**scope, 'task_id': task['task_id'],
                  'expected_revision': claimed_task['revision'],
                  'status': 'cancelled',
                  'idempotency_key': 'synthetic-unexpired-claim-cancel',
                  'source_application': 'codex',
                  'summary': 'Synthetic cancellation during provisioning claim.'},
        )
        assert cancellation.status_code == 409, cancellation.text
        assert (await client.get(
            f'/v1/project-agent-tasks/{task["task_id"]}',
            params=scope,
        )).json() == claimed_task
        assert (await recruitments(client, scope))[0] == claimed_recruitment
        identity = await client.get(
            f'/v1/project-agents/{recruitment["proposed_agent_id"]}',
            params={'personal_space_id': scope['personal_space_id']},
        )
        assert identity.status_code == 404, identity.text


@pytest.mark.asyncio
@pytest.mark.parametrize('hr_status', ['inactive', 'archived'])
async def test_pending_confirmation_can_be_cancelled_when_hr_is_inactive_or_archived(hr_status):
    async with provider_client(fixture_settings()) as (client, _):
        scope, payload = await recruitment_setup(client, confirmation=True)
        submitted = await client.post('/v1/project-agent-tasks', json=payload)
        assert submitted.status_code == 200, submitted.text
        pending = submitted.json()
        recruitment = pending['recruitment']
        assert recruitment['status'] == 'awaiting_confirmation'

        await hr_profile(client, scope, hr_status)
        decision = await client.post(
            f'/v1/project-agent-recruitments/{recruitment["recruitment_id"]}/decision',
            json={**scope, 'recruitment_id': recruitment['recruitment_id'],
                  'decision': 'cancel', 'expected_revision': recruitment['revision'],
                  'reason': f'Synthetic cancellation while HR status is {hr_status}.'},
        )
        assert decision.status_code == 200, decision.text
        cancelled = decision.json()
        assert cancelled['status'] == 'cancelled'
        assert cancelled['revision'] == recruitment['revision'] + 1

        current_task = (await client.get(
            f'/v1/project-agent-tasks/{pending["task"]["task_id"]}',
            params=scope,
        )).json()
        assert current_task['status'] == 'blocked'
        assert current_task['revision'] == pending['task']['revision'] + 1
        assert current_task['lead_agent_id'] is None
        assert (await recruitments(client, scope))[0] == cancelled
        identity = await client.get(
            f'/v1/project-agents/{recruitment["proposed_agent_id"]}',
            params={'personal_space_id': scope['personal_space_id']},
        )
        assert identity.status_code == 404, identity.text


@pytest.mark.asyncio
async def test_failed_fulfillment_guard_rolls_back_identity_and_assignment(monkeypatch):
    async with provider_client(fixture_settings(), raise_app_exceptions=False) as (client, _):
        scope, payload = await recruitment_setup(client, confirmation=False)
        agents_before = await agents(client, scope)
        fired = False

        def stale_fulfillment_claim(query, kwargs):
            nonlocal fired
            if (not fired and "SET recruitment.status = 'fulfilled'" in query
                    and kwargs.get('provisioning_claim_id')):
                fired = True
                return {**kwargs, 'provisioning_claim_id': 'synthetic-stale-claim'}
            return kwargs

        graph_fault(monkeypatch, stale_fulfillment_claim)
        failed = await client.post('/v1/project-agent-tasks', json=payload)
        assert fired and failed.status_code == 409, failed.text
        assert await recruitments(client, scope) == []
        assert await agents(client, scope) == agents_before
        tasks = await client.get('/v1/project-agent-tasks', params=scope)
        assert tasks.json() == []


@pytest.mark.asyncio
async def test_expired_claim_cancellation_serializes_with_inflight_provisioning(monkeypatch):
    async with provider_client(fixture_settings(), raise_app_exceptions=False) as (client, _):
        from fuli_graph import store_project_agent_task_activity as activity_module
        from fuli_graph.store_transactions import TransactionQueryDriver
        scope, payload = await recruitment_setup(client, confirmation=True)
        submitted = await client.post('/v1/project-agent-tasks', json=payload)
        assert submitted.status_code == 200, submitted.text
        recruitment, task = submitted.json()['recruitment'], submitted.json()['task']
        provisioning, cancelling, proceed = asyncio.Event(), asyncio.Event(), asyncio.Event()
        execute = TransactionQueryDriver.execute_query

        async def barrier(driver, query, **kwargs):
            if kwargs.get('recruitment_id') and 'SET agent.profile_json' in query:
                provisioning.set()
                await asyncio.wait_for(proceed.wait(), timeout=10)
            if 'SET task._activity_write_lock' in query:
                cancelling.set()
            return await execute(driver, query, **kwargs)

        monkeypatch.setattr(TransactionQueryDriver, 'execute_query', barrier)
        approval = asyncio.create_task(client.post(
            f'/v1/project-agent-recruitments/{recruitment["recruitment_id"]}/decision',
            json={**scope, 'recruitment_id': recruitment['recruitment_id'],
                  'decision': 'approve', 'expected_revision': recruitment['revision'],
                  'reason': 'Synthetic concurrent approval.'},
        ))
        cancellation = None
        try:
            await asyncio.wait_for(provisioning.wait(), timeout=10)
            # Expiration is simulated; HTTP requests and database locks are real.
            later = activity_module.now_utc() + timedelta(minutes=3)
            monkeypatch.setattr(activity_module, 'now_utc', lambda: later)
            cancellation = asyncio.create_task(client.post(
                f'/v1/project-agent-tasks/{task["task_id"]}/events',
                json={**scope, 'task_id': task['task_id'], 'status': 'cancelled',
                      'idempotency_key': 'synthetic-expired-claim-cancel',
                      'source_application': 'codex', 'summary': 'Synthetic concurrent cancellation.'},
            ))
            await asyncio.wait_for(cancelling.wait(), timeout=10)
            assert not cancellation.done()
            proceed.set()
            approved, cancelled = await asyncio.wait_for(
                asyncio.gather(approval, cancellation), timeout=15)
            assert approved.status_code == 200, approved.text
            assert cancelled.status_code == 200, cancelled.text
        finally:
            proceed.set()
            await asyncio.gather(approval, *([cancellation] if cancellation else []),
                                 return_exceptions=True)
        current = await client.get(f'/v1/project-agent-tasks/{task["task_id"]}',
                                   params={'personal_space_id': scope['personal_space_id']})
        assert current.json()['status'] == 'cancelled'
        assert (await recruitments(client, scope))[0]['status'] == 'fulfilled'
        assert [(p['agent_id'], p['status']) for p in current.json()['participants']] == [
            (recruitment['proposed_agent_id'], 'cancelled')]


@pytest.mark.asyncio
@pytest.mark.parametrize('confirmation', [True, False])
async def test_legacy_policy_discloses_that_project_policy_is_effective(confirmation):
    async with provider_client(fixture_settings()) as (client, _):
        scope, payload = await recruitment_setup(client, confirmation=confirmation)
        legacy_mode = 'automatic' if confirmation else 'require_confirmation'
        saved = await client.put('/v1/project-agent-recruitment-policy', json={
            'personal_space_id': scope['personal_space_id'], 'confirmation_mode': legacy_mode,
        })
        assert saved.status_code == 200, saved.text
        loaded = await client.get('/v1/project-agent-recruitment-policy', params={
            'personal_space_id': scope['personal_space_id'],
        })
        for record in [saved.json(), loaded.json()]:
            assert record['confirmation_mode'] == legacy_mode
            assert record['policy_status'] == 'superseded'
            assert record['applies_to_recruitment'] is False
            assert 'update_project_agent_coordination_policy' in record['warning']
        routed = await client.post('/v1/project-agent-tasks', json=payload)
        assert routed.status_code == 200, routed.text
        assert routed.json()['recruitment']['status'] == (
            'awaiting_confirmation' if confirmation else 'fulfilled')
