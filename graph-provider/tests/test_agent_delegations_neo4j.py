"""Real Provider capability isolation on an explicitly disposable graph."""

import asyncio
from hashlib import sha256
from secrets import token_urlsafe
from datetime import UTC, datetime
import json

import pytest

from fuli_graph.runtime import ManagedNeo4jDriver
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
    execute = ManagedNeo4jDriver.execute_query

    async def expire_fixture(driver, query, **kwargs):
        if 'CREATE (:FuliAgentDelegation' in query:
            kwargs['lifetime'] = -1  # Fast expiry only in this disposable test graph.
        return await execute(driver, query, **kwargs)

    async with provider_client(fixture_settings()) as (client, _):
        scope, request = await setup_delegation(client)
        with monkeypatch.context() as patch:
            patch.setattr(ManagedNeo4jDriver, 'execute_query', expire_fixture)
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
    execute = ManagedNeo4jDriver.execute_query

    async def pause_claim(driver, query, **kwargs):
        if 'grant.redeemed = true' in query:
            reached.set()
            await proceed.wait()
        return await execute(driver, query, **kwargs)

    async with provider_client(fixture_settings()) as (client, _):
        scope, request = await setup_delegation(client)
        token = await issue(client, request)
        with monkeypatch.context() as patch:
            patch.setattr(ManagedNeo4jDriver, 'execute_query', pause_claim)
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


async def worker_run_fixture(client):
    from test_project_agent_team_lifecycle_neo4j import binding_fixture, binding_parent, binding_task, binding_policy, bind
    from test_project_agent_activity_atomicity_neo4j import seed_executor
    scope = await binding_fixture(client)
    await binding_policy(client, scope)
    await seed_executor(client, scope['personal_space_id'])
    parent = 'fuli-task-worker-parent'
    await binding_parent(client, scope, parent, 'worker-parent-session')
    task_id = await binding_task(client, scope, 'synthetic-worker-run-task')
    assert (await bind(client, scope, parent, task_id)).status_code == 200
    task = (await client.get(f'/v1/project-agent-tasks/{task_id}', params=scope)).json()
    secret = token_urlsafe(32)
    payload = {**scope, 'task_context_token': parent, 'source_application': 'codex',
        'task_id': task_id, 'agent_id': 'specialist', 'worker_id': 'synthetic-worker',
        'executor_id': 'synthetic-executor', 'target_application': 'codex',
        'provider': 'synthetic', 'model': 'synthetic-model',
        'model_strategy': task['effective_model_strategy'],
        'idempotency_key': 'synthetic-worker-run-attempt',
        'runtime_capability_hash': sha256(secret.encode()).hexdigest()}
    return scope, payload, {'x-fuli-worker-capability': secret}


@pytest.mark.asyncio
async def test_worker_run_claim_seal_and_own_context_survive_retries_and_parent_next_turn(monkeypatch):
    from fuli_graph.store_transactions import TransactionQueryDriver
    from fuli_graph.store_project_agent_memory import StoreProjectAgentMemory
    from test_project_agent_team_lifecycle_neo4j import binding_parent
    settings = fixture_settings()
    async with provider_client(settings, raise_app_exceptions=False) as (client, access_token):
        scope, payload, headers = await worker_run_fixture(client)
        response = await client.put('/v1/project-agent-worker-runs', json=payload)
        assert response.status_code == 200, response.text
        run = response.json()
        path = f'/v1/project-agent-worker-runs/{run["run_id"]}'
        assert run['state'] == 'prepared'
        assert datetime.fromisoformat(run['created_at']).tzinfo is not None
        assert headers['x-fuli-worker-capability'] not in response.text
        assert 'runtime_capability_hash' not in response.text
        claims = await asyncio.gather(*(client.post(path + '/start-claim', json=scope, headers=headers)
                                        for _ in range(2)))
        assert [item.status_code for item in claims] == [200, 200]
        assert sorted(item.json()['start_claimed'] for item in claims) == [False, True]
        replay = await client.put('/v1/project-agent-worker-runs', json=payload)
        assert replay.json()['run_id'] == run['run_id'] and replay.json()['state'] == 'claimed'
        session = {**scope, 'source_application': 'codex', 'session_id': 'synthetic-worker-' + scope['personal_space_id']}
        for _ in range(2):
            sealed = await client.put(path + '/session', json=session, headers=headers)
            assert sealed.status_code == 200, sealed.text
        changed = await client.put(path + '/session', json={**session, 'session_id': 'another-session'}, headers=headers)
        assert changed.status_code == 409, changed.text
        memory_reads = []
        read_memory = StoreProjectAgentMemory.get_project_agent_memory

        async def count_memory_reads(store, *args, **kwargs):
            memory_reads.append(args)
            return await read_memory(store, *args, **kwargs)

        monkeypatch.setattr(StoreProjectAgentMemory, 'get_project_agent_memory', count_memory_reads)
        guarded, release, second_entering = asyncio.Event(), asyncio.Event(), asyncio.Event()
        execute = TransactionQueryDriver.execute_query

        async def pause_first_admission(driver, statement, **kwargs):
            if guarded.is_set() and 'SET session.write_serial' in statement:
                second_entering.set()
            result = await execute(driver, statement, **kwargs)
            if 'SET run.write_serial' in statement and not guarded.is_set():
                guarded.set()
                await release.wait()
            return result

        monkeypatch.setattr(TransactionQueryDriver, 'execute_query', pause_first_admission)
        first_admission = asyncio.create_task(client.post(path + '/contexts', json=session, headers=headers))
        second_admission = None
        try:
            await asyncio.wait_for(guarded.wait(), 10)
            second_admission = asyncio.create_task(client.post(path + '/contexts', json=session, headers=headers))
            await asyncio.wait_for(second_entering.wait(), 10)
            await asyncio.wait({second_admission}, timeout=0.1)
            assert not second_admission.done()
        finally:
            release.set()
            admitted = await asyncio.wait_for(asyncio.gather(first_admission, second_admission), 15)
        assert [item.status_code for item in admitted] == [200, 200]
        own = admitted[0].json()['task_context']
        assert admitted[1].json()['task_context']['token'] == own['token'] != payload['task_context_token']
        assert own['project_agent_id'] == 'specialist' and own['turn_id'] == 'worker-run:' + run['run_id']
        assert own['preference_scope'] == {'version': 1, 'work_kind': 'implementation', 'workflow': None}
        assert len(memory_reads) == 1
        assert admitted[1].json()['task_context']['memory_revision'] == own['memory_revision']
        # Change only this synthetic coordination task and its legitimate
        # assignment. Future authority is rechecked, but the admitted scope is immutable.
        from neo4j import AsyncGraphDatabase
        async with AsyncGraphDatabase.driver(settings.neo4j_uri, auth=('neo4j', settings.neo4j_password)) as driver:
            await driver.execute_query('''
                MATCH (task:FuliProjectAgentTask {task_id: $task_id, personal_space_id: $space_id})
                SET task.work_kind = 'review'
                WITH task
                MATCH (:FuliSpace {id: $space_id})-[:CONTAINS_PROJECT]->
                  (:FuliPersonalProject {project_id: $project_id})-[:HAS_PROJECT_AGENT_ASSIGNMENT]->
                  (assignment:FuliProjectAgentAssignment)-[:ASSIGNED_AGENT]->(:FuliProjectAgent {agent_id: 'specialist'})
                SET assignment.work_kinds = ['implementation', 'review']
                ''', task_id=payload['task_id'], space_id=scope['personal_space_id'], project_id=scope['personal_project_id'])
        await binding_parent(client, scope, 'fuli-task-worker-parent-next', 'worker-parent-session')
        retried = await client.post(path + '/contexts', json=session, headers=headers)
        assert retried.status_code == 200, retried.text
        assert retried.json()['task_context']['token'] == own['token']
        assert retried.json()['task_context']['preference_scope'] == own['preference_scope']
        assert retried.json()['task_context']['memory_revision'] == own['memory_revision']
        assert len(memory_reads) == 1
        visible = (await client.get(f'/v1/project-agent-tasks/{payload["task_id"]}', params=scope)).json()
        assert visible['execution_summary'] == [] and visible['actual_run_id'] is None
    async with provider_client(settings, access_token) as (client, _):
        recovered = await client.get(path, params=scope, headers=headers)
        assert recovered.status_code == 200, recovered.text
        assert recovered.json()['state'] == 'admitted'
        assert recovered.json()['own_context_token'] == own['token']
        resumed = await client.post(path + '/contexts', json=session, headers=headers)
        assert resumed.status_code == 200 and resumed.json()['task_context']['preference_scope'] == own['preference_scope'], resumed.text
        assert resumed.json()['task_context']['memory_revision'] == own['memory_revision']
        assert len(memory_reads) == 1
        assert (await client.post(path + '/start-claim', json=scope, headers=headers)).json()['start_claimed'] is False


@pytest.mark.asyncio
@pytest.mark.parametrize('terminal_action', ['close', 'revoke'])
@pytest.mark.parametrize('checkpointed', [False, True])
async def test_worker_run_rejects_old_grants_and_existing_sessions_and_closed_context_use(terminal_action, checkpointed):
    async with provider_client(fixture_settings(), raise_app_exceptions=False) as (client, _):
        scope, payload, headers = await worker_run_fixture(client)
        created = await client.put('/v1/project-agent-worker-runs', json=payload)
        assert created.status_code == 200, created.text
        path = f'/v1/project-agent-worker-runs/{created.json()["run_id"]}'
        old_grant = await issue(client, {'personal_space_id': scope['personal_space_id'], 'task_context_token': payload['task_context_token'],
            'source_application': 'codex', 'agent_id': 'specialist', 'target_application': 'codex'})
        refused = await client.post(path + '/start-claim', json=scope,
                                   headers={'x-fuli-worker-capability': old_grant})
        assert refused.status_code == 403 and old_grant not in refused.text
        assert (await client.post(path + '/start-claim', json=scope, headers=headers)).json()['start_claimed'] is True
        ordinary = await client.put('/v1/task-contexts', json={**scope, 'source_application': 'codex',
            'session_id': 'synthetic-human-session', 'token': 'fuli-task-existing-human'})
        assert ordinary.status_code == 200, ordinary.text
        session = {**scope, 'source_application': 'codex', 'session_id': 'synthetic-human-session'}
        assert (await client.put(path + '/session', json=session, headers=headers)).status_code == 409
        assert (await client.put(path + '/session', json={**session, 'session_id': 'worker-parent-session'}, headers=headers)).status_code == 409
        session['session_id'] = 'synthetic-isolated-worker-' + scope['personal_space_id']
        assert (await client.put(path + '/session', json=session, headers=headers)).status_code == 200
        forged = await client.put('/v1/task-contexts', json={**session,
            'token': 'fuli-task-forged-worker-turn', 'turn_id': 'other-turn', 'project_agent_id': 'owner'})
        assert forged.status_code == 409, forged.text
        own = (await client.post(path + '/contexts', json=session, headers=headers)).json()['task_context']
        checkpoint = {'personal_space_id': scope['personal_space_id'], 'source_application': 'codex',
            'disposition': 'retain_nothing', 'reason': 'Synthetic worker metadata only.',
            'fingerprint': 'e' * 64, 'work_log': {'status': 'completed', 'summary': 'Synthetic worker checkpoint.'}}
        if checkpointed:
            for phase in ['prepare', 'complete']:
                saved = await client.put(f'/v1/task-contexts/{own["token"]}/checkpoint', json={**checkpoint, 'phase': phase})
                assert saved.status_code == 200, saved.text
        closed = await client.post(path + '/' + terminal_action, json={**scope, 'reason': 'Synthetic attempt ended.'}, headers=headers)
        assert closed.status_code == 200, closed.text
        verification = await client.get('/v1/task-context-sessions/checkpoint', params={
            'personal_space_id': scope['personal_space_id'], 'source_application': 'codex',
            'session_id': session['session_id']})
        assert verification.status_code == 200, verification.text
        expected = 'checkpointed' if checkpointed else 'worker_run_' + closed.json()['state']
        assert verification.json()['status'] == expected, verification.text
        assert 'task_context_token' not in verification.json() and 'decision' not in verification.json()
        if checkpointed:
            assert verification.json()['disposition'] == 'retain_nothing'
        refused = await client.put(f'/v1/task-contexts/{own["token"]}/checkpoint', json={**checkpoint, 'phase': 'complete'})
        assert refused.status_code == 409, refused.text
        assert (await client.post(path + '/contexts', json=session, headers=headers)).status_code == 409
        denied = await client.get(f'/v1/task-contexts/{own["token"]}', params={
            'personal_space_id': scope['personal_space_id'], 'source_application': 'codex'})
        assert denied.status_code == 409, denied.text
        assert (await client.post(path + '/start-claim', json=scope, headers=headers)).status_code == 409
        other = await client.post('/v1/spaces', json={'name': 'Synthetic worker session reuse', 'kind': 'personal'})
        reused = await client.put('/v1/task-contexts', json={
            'personal_space_id': other.json()['id'], 'source_application': 'codex',
            'session_id': session['session_id'], 'token': 'fuli-task-cross-space-worker-reuse'})
        assert reused.status_code == 409, reused.text
        assert scope['personal_space_id'] not in reused.text


async def sealed_worker_run(client):
    scope, payload, headers = await worker_run_fixture(client)
    response = await client.put('/v1/project-agent-worker-runs', json=payload)
    assert response.status_code == 200, response.text
    path = f'/v1/project-agent-worker-runs/{response.json()["run_id"]}'
    assert (await client.post(path + '/start-claim', json=scope, headers=headers)).status_code == 200
    session = {**scope, 'source_application': 'codex', 'session_id': 'synthetic-worker-' + scope['personal_space_id']}
    assert (await client.put(path + '/session', json=session, headers=headers)).status_code == 200
    return scope, payload, headers, path, session


@pytest.mark.asyncio
async def test_worker_run_current_parent_expiry_and_immutable_prepare_payload():
    from neo4j import AsyncGraphDatabase
    from test_project_agent_team_lifecycle_neo4j import binding_parent
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        scope, payload, headers, path, session = await sealed_worker_run(client)
        for change in [{'worker_id': 'other-worker'}, {'runtime_capability_hash': 'b' * 64}]:
            refused = await client.put('/v1/project-agent-worker-runs', json={**payload, **change})
            assert refused.status_code == 409, refused.text
        malformed = await client.put('/v1/project-agent-worker-runs', json={**payload,
            'runtime_capability': headers['x-fuli-worker-capability']})
        assert malformed.status_code == 422 and headers['x-fuli-worker-capability'] not in malformed.text
        await binding_parent(client, scope, 'fuli-task-worker-parent-next', 'worker-parent-session')
        stale_parent = await client.post(path + '/contexts', json=session, headers=headers)
        assert stale_parent.status_code == 409 and 'current unfinished parent' in stale_parent.text
        # Prepare replay neither refreshes the deadline nor claims another start.
        replay = await client.put('/v1/project-agent-worker-runs', json=payload)
        assert replay.status_code == 200 and replay.json()['state'] == 'sealed'
        async with AsyncGraphDatabase.driver(settings.neo4j_uri, auth=('neo4j', settings.neo4j_password)) as driver:
            await driver.execute_query('''MATCH (run:FuliProjectAgentWorkerRun {id: $run_id})
                SET run.bootstrap_expires_at = datetime() - duration({seconds: 1})''', run_id=replay.json()['run_id'])
        expired = await client.post(path + '/contexts', json=session, headers=headers)
        assert expired.status_code == 409 and 'expired' in expired.text
        revoked = await client.post(path + '/revoke', json={**scope, 'reason': 'Lost or expired bootstrap.'})
        assert revoked.status_code == 200 and revoked.json()['state'] == 'revoked'


@pytest.mark.asyncio
async def test_worker_context_checks_permission_and_exact_max_model_after_admission():
    from neo4j import AsyncGraphDatabase
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        scope, payload, headers, path, session = await sealed_worker_run(client)
        admitted = await client.post(path + '/contexts', json=session, headers=headers)
        assert admitted.status_code == 200, admitted.text
        own = admitted.json()['task_context']
        params = {'personal_space_id': scope['personal_space_id'], 'source_application': 'codex'}
        async with AsyncGraphDatabase.driver(settings.neo4j_uri, auth=('neo4j', settings.neo4j_password)) as driver:
            await driver.execute_query('''MATCH (:FuliSpace {id: $space})-[permission:HAS_EXECUTOR_PERMISSION]->
                (:FuliProjectAgentExecutor {executor_id: 'synthetic-executor'}) SET permission.status='revoked' ''',
                space=scope['personal_space_id'])
            assert (await client.get(f'/v1/task-contexts/{own["token"]}', params=params)).status_code == 409
            assert (await client.post(path + '/contexts', json=session, headers=headers)).status_code == 409
            await driver.execute_query('''MATCH (:FuliSpace {id: $space})-[permission:HAS_EXECUTOR_PERMISSION]->
                (executor:FuliProjectAgentExecutor {executor_id: 'synthetic-executor'})
                SET permission.status='authorized', executor.available_models_json=$models''',
                space=scope['personal_space_id'], models=json.dumps([{'provider': 'synthetic', 'model': 'other-model'}]))
            assert (await client.post(path + '/contexts', json=session, headers=headers)).status_code == 409
            # Another model's max support cannot authorize the requested model.
            strategy = {**payload['model_strategy'], 'reasoning_effort': 'max'}
            await driver.execute_query('''MATCH (task:FuliProjectAgentTask {task_id: $task_id})
                SET task.task_model_strategy_override_json=$strategy
                WITH task MATCH (:FuliSpace {id: $space})-[:HAS_EXECUTOR_PERMISSION]->
                (executor:FuliProjectAgentExecutor {executor_id: 'synthetic-executor'})
                SET executor.available_models_json=$models''', task_id=payload['task_id'],
                space=scope['personal_space_id'], strategy=json.dumps(strategy), models=json.dumps([
                    {'provider': 'synthetic', 'model': 'synthetic-model', 'reasoning_efforts': ['high']},
                    {'provider': 'synthetic', 'model': 'other-model', 'reasoning_efforts': ['max']}]))
            request = {**payload, 'idempotency_key': 'synthetic-max-worker-attempt',
                'runtime_capability_hash': sha256(token_urlsafe(32).encode()).hexdigest(), 'model_strategy': strategy}
            assert (await client.put('/v1/project-agent-worker-runs', json=request)).status_code == 409
        closed = await client.post(path + '/close', json={**scope, 'reason': 'Synthetic permissions withdrawn.'}, headers=headers)
        assert closed.status_code == 200, closed.text


@pytest.mark.asyncio
async def test_worker_prepare_rejects_malformed_stored_agent_and_assignment_authority():
    from neo4j import AsyncGraphDatabase
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        scope, payload, _ = await worker_run_fixture(client)
        async with AsyncGraphDatabase.driver(settings.neo4j_uri, auth=('neo4j', settings.neo4j_password)) as driver:
            for label, field in [('agent', 'executor_policy_json'), ('agent', 'default_model_strategy_json'),
                                 ('assignment', 'executor_policy_json'), ('assignment', 'model_strategy_json')]:
                match = '''MATCH (:FuliSpace {id: $space})-[:HAS_PROJECT_AGENT_IDENTITY]->
                    (agent:FuliProjectAgent {agent_id: 'specialist'})'''
                if label == 'assignment':
                    match += ''' MATCH (:FuliSpace {id: $space})-[:CONTAINS_PROJECT]->
                        (:FuliPersonalProject {project_id: $project})-[:HAS_PROJECT_AGENT_ASSIGNMENT]->
                        (assignment:FuliProjectAgentAssignment {status: 'active'})-[:ASSIGNED_AGENT]->(agent)'''
                await driver.execute_query(match + f' SET {label}.{field}=$invalid',
                    space=scope['personal_space_id'], project=scope['personal_project_id'], invalid='{"mode":"invalid-authority"}')
                refused = await client.put('/v1/project-agent-worker-runs', json=payload)
                assert refused.status_code == 409, (label, field, refused.text)
                await driver.execute_query(match + f' REMOVE {label}.{field}',
                    space=scope['personal_space_id'], project=scope['personal_project_id'])
        # Rejected validation has not reserved this idempotency key.
        assert (await client.put('/v1/project-agent-worker-runs', json=payload)).status_code == 200


@pytest.mark.asyncio
async def test_worker_session_seal_and_ordinary_begin_share_the_same_session_lock(monkeypatch):
    from fuli_graph.store_transactions import TransactionQueryDriver
    from fuli_graph.provider_values import stable_uuid
    async with provider_client(fixture_settings(), raise_app_exceptions=False) as (client, _):
        scope, payload, headers = await worker_run_fixture(client)
        created = await client.put('/v1/project-agent-worker-runs', json=payload)
        path = f'/v1/project-agent-worker-runs/{created.json()["run_id"]}'
        await client.post(path + '/start-claim', json=scope, headers=headers)
        locked, release = asyncio.Event(), asyncio.Event()
        execute = TransactionQueryDriver.execute_query
        session = {**scope, 'source_application': 'codex', 'session_id': 'synthetic-seal-race-' + scope['personal_space_id']}
        target_id = stable_uuid(fixture_settings().provider_id, scope['personal_space_id'], 'codex',
                                session['session_id'], 'task-context-session')

        async def pause_seal(driver, statement, **kwargs):
            result = await execute(driver, statement, **kwargs)
            if 'SET session.write_serial' in statement and kwargs.get('id') == target_id and not locked.is_set():
                locked.set()
                await release.wait()
            return result

        monkeypatch.setattr(TransactionQueryDriver, 'execute_query', pause_seal)
        sealing = asyncio.create_task(client.put(path + '/session', json=session, headers=headers))
        ordinary = None
        try:
            await asyncio.wait_for(locked.wait(), 10)
            ordinary = asyncio.create_task(client.put('/v1/task-contexts', json={**session,
                'token': 'fuli-task-human-racing-seal', 'turn_id': 'human-turn'}))
            await asyncio.wait({ordinary}, timeout=0.1)
            assert not ordinary.done(), 'ordinary begin bypassed the held new-session lock'
        finally:
            release.set()
            responses = await asyncio.wait_for(asyncio.gather(sealing, ordinary), 15)
        assert [item.status_code for item in responses] == [200, 409]


@pytest.mark.asyncio
async def test_worker_checkpoint_without_memory_and_close_keep_session_before_run(monkeypatch):
    from fuli_graph.store_transactions import TransactionQueryDriver
    async with provider_client(fixture_settings(), raise_app_exceptions=False) as (client, _):
        scope, _, headers, path, session = await sealed_worker_run(client)
        admitted = await client.post(path + '/contexts', json=session, headers=headers)
        own = admitted.json()['task_context']
        locked, release = asyncio.Event(), asyncio.Event()
        execute = TransactionQueryDriver.execute_query

        async def pause_checkpoint_guard(driver, statement, **kwargs):
            result = await execute(driver, statement, **kwargs)
            if 'SET run.write_serial' in statement and not locked.is_set():
                locked.set()
                await release.wait()
            return result

        monkeypatch.setattr(TransactionQueryDriver, 'execute_query', pause_checkpoint_guard)
        checkpoint = {'personal_space_id': scope['personal_space_id'], 'source_application': 'codex',
            'phase': 'prepare', 'disposition': 'retain_nothing', 'reason': 'Synthetic worker metadata only.',
            'fingerprint': 'd' * 64, 'work_log': {'status': 'incomplete', 'summary': 'Synthetic worker context guard.'}}
        saving = asyncio.create_task(client.put(f'/v1/task-contexts/{own["token"]}/checkpoint', json=checkpoint))
        closing = None
        try:
            await asyncio.wait_for(locked.wait(), 10)
            closing = asyncio.create_task(client.post(path + '/close', json={**scope,
                'reason': 'Synthetic attempt ended after checkpoint.'}, headers=headers))
            await asyncio.wait({closing}, timeout=0.1)
            assert not closing.done(), 'close bypassed the checkpoint session/run lock order'
        finally:
            release.set()
            responses = await asyncio.wait_for(asyncio.gather(saving, closing), 15)
        assert [item.status_code for item in responses] == [200, 200]
        for phase in ['prepare', 'complete']:
            refused = await client.put(f'/v1/task-contexts/{own["token"]}/checkpoint', json={**checkpoint, 'phase': phase})
            assert refused.status_code == 409, refused.text


@pytest.mark.asyncio
async def test_worker_mcp_stdio_uses_own_identity_and_rechecks_provider_after_close(tmp_path):
    """Real stdio + HTTP + Neo4j, synthetic sessions only; no native model runs."""
    import os
    from pathlib import Path
    import shutil
    import socket
    import uvicorn

    async with provider_client(fixture_settings()) as (client, access_token):
        scope, payload, headers, path, session = await sealed_worker_run(client)
        project = scope['personal_project_id']
        histories = {}
        for label, agent, project_id in [('project', 'specialist', project), ('global', 'specialist', None),
                                         ('foreign', 'owner', project)]:
            own_scope = {**scope, 'personal_project_id': project_id, 'agent_id': agent, 'source_application': 'codex'}
            token, native_session = 'fuli-task-history-' + label, 'synthetic-history-' + label
            created = await client.put('/v1/task-contexts', json={**scope, 'personal_project_id': project_id,
                'project_agent_id': agent, 'source_application': 'codex', 'session_id': native_session, 'token': token})
            assert created.status_code == 200, created.text
            history = await client.post('/v1/agent-conversations/append', json={**own_scope,
                'session_id': native_session, 'task_context_token': token,
                'events': [{'event_id': label, 'role': 'user', 'kind': 'message', 'content': 'SYNTHETIC_' + label}]})
            assert history.status_code == 200, history.text
            histories[label] = history.json()['conversation_id']
            if agent == 'specialist':
                saved = await client.put('/v1/project-agents/specialist/memory', json={**own_scope,
                    'expected_revision': 0, 'idempotency_key': 'synthetic-memory-' + label,
                    'memory': {'summary': 'SYNTHETIC_MEMORY_' + label}})
                assert saved.status_code == 200, saved.text
        foreign = await client.post('/v1/agent-conversations/query', json={**scope,
            'agent_id': 'specialist', 'source_application': 'codex', 'mode': 'events',
            'conversation_id': histories['foreign']})
        assert foreign.status_code == 404, foreign.text
        listener = socket.socket()
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
        config_path = tmp_path / 'graph-runtime.json'
        config_path.write_text(json.dumps({'version': 1, 'workspaces': [], 'personal': {
            'providerUrl': f'http://127.0.0.1:{port}', 'accessToken': access_token,
            'principalId': 'synthetic-worker-host', 'spaceId': scope['personal_space_id']}}), encoding='utf-8')
        server = uvicorn.Server(uvicorn.Config(client._transport.app, lifespan='off', log_level='error'))
        serving = asyncio.create_task(server.serve(sockets=[listener]))
        try:
            for _ in range(100):
                if server.started:
                    break
                await asyncio.sleep(0.01)
            assert server.started
            fixture = {'configPath': str(config_path), 'providerUrl': f'http://127.0.0.1:{port}',
                'accessToken': access_token, 'scope': scope, 'path': path, 'histories': histories,
                'parentToken': payload['task_context_token'], 'actualSession': session['session_id'],
                'descriptor': {'runId': path.rsplit('/', 1)[1], 'personalProjectId': project,
                    'capability': headers['x-fuli-worker-capability'], 'projectPath': str(tmp_path),
                    'taskPrompt': 'Implement the bounded synthetic worker fixture.',
                    'toolNames': ['begin_task_context', 'get_collaboration_preferences', 'verify_task_checkpoint',
                        'checkpoint_task_knowledge', 'get_project_agent_memory',
                        'search_current_project_knowledge', 'list_agent_conversations', 'read_agent_conversation']}}
            script = r'''
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const fixture = JSON.parse(process.env.FULI_WORKER_MCP_FIXTURE);
async function request(path, body, method = 'POST', capability = false) {
  const response = await fetch(fixture.providerUrl + path, { method,
    headers: {authorization: `Bearer ${fixture.accessToken}`, 'content-type':'application/json',
      ...(capability ? {'x-fuli-worker-capability': fixture.descriptor.capability} : {})},
    ...(body ? {body: JSON.stringify(body)} : {}) });
  assert.equal(response.ok, true, `Synthetic HTTP ${response.status}`);
  return response.json();
}
async function connect() {
  const client = new Client({name:'synthetic-worker-host',version:'1'});
  const transport = new StdioClientTransport({ command:process.execPath,
    args:[resolve('src/cli.js'),'mcp','--worker','--runtime-config',fixture.configPath], cwd:process.cwd(), stderr:'pipe',
    env:{...process.env, CODEX_THREAD_ID:'019fc6ed-02a5-7832-8821-68e3b03e7ce3',
      FULI_WORKER_DESCRIPTOR:JSON.stringify(fixture.descriptor)} });
  let stderr = ''; transport.stderr?.on('data', chunk => {stderr += chunk;});
  await client.connect(transport);
  return {client, close: async () => {await client.close(); assert.equal(stderr.includes(fixture.descriptor.capability),false);}};
}
const call = async (client,name,args) => (await client.callTool({name,arguments:args}));
const own = {personalSpaceId:fixture.scope.personal_space_id, agentId:'specialist'};
const entryArgs = {sessionId:'forged-parent-session',projectPath:'/forged/path',
  taskPrompt:'Forged model prompt',workKind:'forged',workflow:'forged'};
const first = await connect(); let ownToken;
try {
  assert.equal((await first.client.listTools()).tools.length,8);
  const run = await request(fixture.path + '?' + new URLSearchParams(fixture.scope), null, 'GET', true);
  assert.equal(run.state,'sealed','initialization must not admit');
  const entry = await call(first.client,'get_collaboration_preferences',entryArgs);
  assert.notEqual(entry.isError,true,JSON.stringify(entry));
  const data = entry.structuredContent;
  ownToken = data.taskContextToken;
  assert.notEqual(ownToken,fixture.parentToken);
  assert.equal(data.context.project_agent_id,'specialist');
  assert.equal(data.project_agent_context.memory.current.memory.summary,'SYNTHETIC_MEMORY_project');
  assert.equal(data.project_agent_context.global_memory.current.memory.summary,'SYNTHETIC_MEMORY_global');
  // A new native worker chat does not implicitly resume an older conversation
  // (#159). Explicit own-project/global history reads below remain available.
  assert.equal(data.conversation.recovery,null);
  const admitted = await request(fixture.path + '?' + new URLSearchParams(fixture.scope), null, 'GET', true);
  const context = await request('/v1/task-contexts/' + ownToken + '?' + new URLSearchParams({
    personal_space_id:fixture.scope.personal_space_id,source_application:'codex'}), null,'GET');
  assert.equal(admitted.actual_session_id,fixture.actualSession);
  assert.equal(context.session_id,fixture.actualSession);
  assert.equal(context.source_session_id,fixture.actualSession);
  assert.equal(context.turn_id,'worker-run:' + fixture.descriptor.runId);
  for (const [layer,project] of [['project',fixture.scope.personal_project_id],['global',null]]) {
    const scope = {...own,personalProjectId:project};
    const memory = await call(first.client,'get_project_agent_memory',scope);
    assert.equal(memory.structuredContent.current.memory.summary,'SYNTHETIC_MEMORY_' + layer);
    const list = await call(first.client,'list_agent_conversations',scope);
    assert.ok(list.structuredContent.conversations.some(item => item.id === fixture.histories[layer]));
    const history = await call(first.client,'read_agent_conversation',{...scope,conversationId:fixture.histories[layer]});
    assert.equal(history.structuredContent.events[0].content,'SYNTHETIC_' + layer);
  }
  const foreign = await call(first.client,'read_agent_conversation',{...own,
    personalProjectId:fixture.scope.personal_project_id,conversationId:fixture.histories.foreign});
  assert.equal(foreign.isError,true);
  const checkpoint = await call(first.client,'checkpoint_task_knowledge',{taskContextToken:fixture.parentToken,
    disposition:'retain_nothing',reason:'Synthetic worker boundary only.',
    workLog:{status:'reported',summary:'Synthetic own worker MCP checkpoint.'},
    agentMemory:{expectedRevision:1,memory:{summary:'SYNTHETIC_WORKER_UPDATED'}}});
  assert.notEqual(checkpoint.isError,true,JSON.stringify(checkpoint));
  assert.equal(checkpoint.structuredContent.agent_memory.revision,2);
  const parent = await request('/v1/task-contexts/' + fixture.parentToken + '?' + new URLSearchParams({
    personal_space_id:fixture.scope.personal_space_id,source_application:'codex'}), null,'GET');
  assert.equal(parent.checkpoint,null);
} finally {await first.close();}
const restarted = await connect();
try {
  const entry = await call(restarted.client,'begin_task_context',entryArgs);
  assert.equal(entry.structuredContent.taskContextToken,ownToken);
  await request(fixture.path + '/close',{...fixture.scope,reason:'Synthetic host closes its attempt.'},'POST',true);
  assert.equal((await call(restarted.client,'read_agent_conversation',{...own,
    personalProjectId:fixture.scope.personal_project_id,conversationId:fixture.histories.project})).isError,true);
  assert.equal((await call(restarted.client,'checkpoint_task_knowledge',{taskContextToken:ownToken,
    disposition:'retain_nothing',reason:'Must reject after close.',
    workLog:{status:'reported',summary:'Must not save.'},
    agentMemory:{expectedRevision:2,memory:{summary:'MUST_NOT_WRITE'}}})).isError,true);
} finally {await restarted.close();}
console.log(JSON.stringify({stdio:true,ownIdentity:true,projectAndGlobal:true,foreignHistoryDenied:true,
  parentUnchanged:true,restartTokenStable:true,closedReadAndWriteDenied:true}));
'''
            process = await asyncio.create_subprocess_exec(shutil.which('node'), '--input-type=module', '-e', script,
                cwd=Path(__file__).resolve().parents[2], env={**os.environ, 'FULI_WORKER_MCP_FIXTURE': json.dumps(fixture)},
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            try:
                stdout, stderr = await asyncio.wait_for(process.communicate(), 120)
            except BaseException:
                process.kill()
                await process.wait()
                raise
            assert headers['x-fuli-worker-capability'] not in stderr.decode()
            assert process.returncode == 0, stderr.decode()
            assert all(json.loads(stdout.decode()).values())
            memory = await client.get('/v1/project-agents/specialist/memory', params={**scope, 'limit': 1})
            assert memory.json()['revision'] == 2
            assert memory.json()['current']['memory']['summary'] == 'SYNTHETIC_WORKER_UPDATED'
        finally:
            server.should_exit = True
            await asyncio.wait_for(serving, 10)
            listener.close()
