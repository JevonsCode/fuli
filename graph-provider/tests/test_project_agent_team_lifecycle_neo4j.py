"""Synthetic lifecycle acceptance over a disposable real graph, without models."""

import asyncio
import json
from uuid import uuid4

import pytest
from neo4j import AsyncGraphDatabase

from test_project_agent_memory_neo4j import fixture_settings, provider_client, seed_agent
from test_recruitment_guards_neo4j import recruitment_setup


async def policy(client, scope):
    response = await client.get('/v1/project-agent-coordination-policy', params=scope)
    assert response.status_code == 200, response.text
    return response.json()


async def recruit(client, payload, key):
    response = await client.post('/v1/project-agent-tasks', json={
        **payload, 'idempotency_key': key,
    })
    assert response.status_code == 200, response.text
    assert response.json()['recruitment']['status'] == 'fulfilled'
    return response.json()


@pytest.mark.asyncio
async def test_recruitment_grows_a_durable_team_and_respects_manual_policy():
    async with provider_client(fixture_settings()) as (client, _):
        scope, payload = await recruitment_setup(client, confirmation=False)
        first = await recruit(client, payload, 'synthetic-team-first')
        lead = first['task']['lead_agent_id']
        saved = await policy(client, scope)
        assert saved['team_lead_agent_id'] == lead
        assert saved['team_member_agent_ids'] == []
        second = await recruit(client, payload, 'synthetic-team-second')
        member = second['task']['lead_agent_id']
        assert member != lead
        saved = await policy(client, scope)
        assert saved['team_lead_agent_id'] == lead
        assert saved['team_member_agent_ids'] == [member]
        replay = await recruit(client, payload, 'synthetic-team-second')
        assert replay['task']['task_id'] == second['task']['task_id']
        assert (await policy(client, scope)) == saved
        disabled = await client.put('/v1/project-agent-coordination-policy', json={
            **scope, 'ask_before_recruitment': False, 'auto_reuse_previous_agent': True,
            'auto_grow_team': False, 'expected_updated_at': saved['updated_at'],
            'team_lead_agent_id': member, 'team_member_agent_ids': [lead],
        })
        assert disabled.status_code == 200, disabled.text
        await recruit(client, payload, 'synthetic-team-third')
        unchanged = await policy(client, scope)
        assert unchanged == disabled.json()


@pytest.mark.asyncio
async def test_recruited_lead_adopts_first_task_and_recovers_work_without_memory():
    settings = fixture_settings()
    async with provider_client(settings) as (client, access_token):
        scope, payload = await recruitment_setup(client, confirmation=False)
        token = 'fuli-task-synthetic-first-adoption'
        begin = await client.put('/v1/task-contexts', json={
            **scope, 'source_application': 'codex', 'session_id': 'synthetic-first-session',
            'token': token, 'turn_id': 'synthetic-turn-one',
        })
        assert begin.status_code == 200, begin.text
        await binding_parent(client, scope, 'fuli-task-legacy-other-parent', 'legacy-other-session', owner=None)
        first = await recruit(client, payload, 'synthetic-adopt-first')
        lead = first['task']['lead_agent_id']
        claim = {**scope, 'source_application': 'codex',
                 'task_id': first['task']['task_id'], 'agent_id': lead}
        wrong_task = await client.put(f'/v1/task-contexts/{token}/agent', json={
            **claim, 'task_id': 'unrelated-synthetic-task',
        })
        assert wrong_task.status_code == 409, wrong_task.text
        adopted = await client.put(f'/v1/task-contexts/{token}/agent', json=claim)
        assert adopted.status_code == 200, adopted.text
        assert adopted.json()['project_agent_id'] == lead
        assert adopted.json()['memory_revision'] == 0
        assert adopted.json()['work_log_required'] is True
        assert adopted.json()['coordination_task_id'] == first['task']['task_id']
        assert adopted.json()['coordination_task_ids'] == [first['task']['task_id']]
        repeated = await client.put(f'/v1/task-contexts/{token}/agent', json=claim)
        assert repeated.json() == adopted.json()
        # Simulate the previous release's sole adoption pointer without a link.
        async with AsyncGraphDatabase.driver(settings.neo4j_uri, auth=('neo4j', settings.neo4j_password)) as driver:
            await driver.execute_query('''MATCH (context:FuliTaskContext {token: $token})-
                [link:COORDINATES_TASK]->(:FuliProjectAgentTask) DELETE link''', token=token)
        legacy = await client.get(f'/v1/task-contexts/{token}', params={
            'personal_space_id': scope['personal_space_id'], 'source_application': 'codex'})
        assert legacy.json()['coordination_task_ids'] == [first['task']['task_id']]
        continued = await bind(client, scope, 'fuli-task-legacy-other-parent', first['task']['task_id'])
        assert continued.status_code == 200, continued.text
        assert (await client.put(f'/v1/task-contexts/{token}/agent', json=claim)).json() == adopted.json()
        summary = 'Verified the synthetic first task; resume the remaining UI checks.'
        checkpoint = {'personal_space_id': scope['personal_space_id'],
            'source_application': 'codex', 'disposition': 'retain_nothing',
            'reason': 'No confirmed knowledge changed.', 'fingerprint': 'a' * 64}
        for phase in ['prepare', 'complete']:
            missing = await client.put(f'/v1/task-contexts/{token}/checkpoint', json={
                **checkpoint, 'phase': phase,
            })
            assert missing.status_code == 422, missing.text
        checkpoint['work_log'] = {'status': 'incomplete', 'summary': summary}
        for phase in ['prepare', 'complete', 'complete']:
            saved = await client.put(f'/v1/task-contexts/{token}/checkpoint', json={
                **checkpoint, 'phase': phase,
            })
            assert saved.status_code == 200, saved.text
        changed = await client.put(f'/v1/task-contexts/{token}/checkpoint', json={
            **checkpoint, 'work_log': {'status': 'completed', 'summary': summary},
        })
        assert changed.status_code == 409, changed.text

    async with provider_client(settings, access_token) as (client, _):
        restored = await client.get(f'/v1/task-contexts/{token}', params={
            'personal_space_id': scope['personal_space_id'], 'source_application': 'codex'})
        assert restored.json()['coordination_task_ids'] == [first['task']['task_id']]
        memory = await client.get(f'/v1/project-agents/{lead}/memory', params=scope)
        assert memory.status_code == 200, memory.text
        assert memory.json()['revision'] == 0
        assert memory.json()['current'] is None
        log = memory.json()['work_log']
        assert len(log) == 1
        assert log[0]['summary'] == summary
        assert log[0]['status'] == 'incomplete'
        assert log[0]['memory_updated'] is False
        assert log[0]['source_application'] == 'codex'


async def binding_fixture(client):
    space = await client.post('/v1/spaces', json={'name': 'Synthetic parent bindings', 'kind': 'personal'})
    scope = {'personal_space_id': space.json()['id'], 'personal_project_id': 'binding-' + uuid4().hex[:10]}
    for agent in ['owner', 'specialist']:
        await seed_agent(client, scope['personal_space_id'], project=scope['personal_project_id'],
                         agent=agent, allowed_clients=['codex', 'claude_code'])
    return scope


async def binding_parent(client, scope, token, session, owner='owner', source='codex'):
    response = await client.put('/v1/task-contexts', json={**scope, 'token': token,
        'source_application': source, 'session_id': session, 'project_agent_id': owner})
    assert response.status_code == 200, response.text


async def binding_task(client, scope, key, *, coordinator='owner', lead='specialist'):
    response = await client.post('/v1/project-agent-tasks', json={**scope,
        'idempotency_key': key, 'title': 'Synthetic parent binding', 'objective': 'Verify scope metadata only.',
        'work_kind': 'implementation', 'source_application': 'codex', 'staffing_intent': 'reuse_preferred',
        'lead_agent_id': lead, 'coordinator_agent_id': coordinator, 'routing_reason': 'Synthetic binding acceptance.'})
    assert response.status_code == 200, response.text
    task = response.json()['task']
    assert task['execution_summary'] == []
    return task['task_id']


async def bind(client, scope, token, task_id, **changes):
    return await client.put(f'/v1/task-contexts/{token}/coordination-tasks', json={**scope,
        'source_application': 'codex', 'task_id': task_id, **changes})


async def binding_policy(client, scope):
    response = await client.put('/v1/project-agent-coordination-policy', json={**scope,
        'team_lead_agent_id': 'owner', 'team_member_agent_ids': ['specialist']})
    assert response.status_code == 200, response.text


@pytest.mark.asyncio
async def test_a_flat_member_dispatching_from_its_task_coordinates_links_and_lists_it():
    async with provider_client(fixture_settings()) as (client, _):
        scope = await binding_fixture(client)
        await seed_agent(client, scope['personal_space_id'], project=scope['personal_project_id'],
                         agent='member', allowed_clients=['codex', 'claude_code'])
        await binding_policy(client, scope)
        token = 'fuli-task-member-dispatch'
        await binding_parent(client, scope, token, 'member-session', owner='member')
        created = await client.post('/v1/project-agent-tasks', json={**scope,
            'idempotency_key': 'synthetic-member-dispatch', 'title': 'Synthetic member dispatch',
            'objective': 'Verify the dispatcher keeps its task record.', 'work_kind': 'implementation',
            'source_application': 'codex', 'staffing_intent': 'reuse_preferred', 'lead_agent_id': 'specialist',
            'routing_reason': 'Synthetic dispatch acceptance.', 'task_context_token': token})
        assert created.status_code == 200, created.text
        task = created.json()['task']
        assert task['coordinator_agent_id'] == 'member'
        assert (await bind(client, scope, token, task['task_id'])).status_code == 200
        listed = await client.get('/v1/project-agent-tasks', params={**scope, 'agent_id': 'member'})
        assert listed.status_code == 200, listed.text
        assert task['task_id'] in {item['task_id'] for item in listed.json()}


@pytest.mark.asyncio
async def test_parent_retains_multiple_links_owner_and_checkpoint_across_provider_restart():
    settings = fixture_settings()
    async with provider_client(settings) as (client, access_token):
        scope = await binding_fixture(client)
        await binding_policy(client, scope)
        # Legacy submit payload omitted coordinator. The configured project
        # owner may continue its specialist task without changing that hash.
        old = await binding_task(client, scope, 'synthetic-binding-old', coordinator=None)
        token = 'fuli-task-binding-parent'
        await binding_parent(client, scope, token, 'parent-one')
        await binding_parent(client, scope, 'fuli-task-binding-other', 'parent-other')
        continued = await bind(client, scope, token, old)
        assert continued.status_code == 200, continued.text
        assert await binding_task(client, scope, 'synthetic-binding-old', coordinator=None) == old
        first = await binding_task(client, scope, 'synthetic-binding-first')
        second = await binding_task(client, scope, 'synthetic-binding-second', lead='owner')
        parallel = await asyncio.gather(bind(client, scope, token, first), bind(client, scope, token, second))
        assert [response.status_code for response in parallel] == [200, 200]
        for task_id in [first, second, first]:
            linked = await bind(client, scope, token, task_id)
            assert linked.status_code == 200, linked.text
            assert linked.json()['project_agent_id'] == 'owner'
        expected = sorted([old, first, second])
        assert linked.json()['coordination_task_ids'] == expected
        assert (await bind(client, scope, 'fuli-task-binding-other', first)).status_code == 200
        # First association anchors remain stable after task progress and retry.
        async with AsyncGraphDatabase.driver(settings.neo4j_uri, auth=('neo4j', settings.neo4j_password)) as driver:
            statement = '''MATCH (:FuliTaskContext {token: $token})-[binding:COORDINATES_TASK]->
                (task:FuliProjectAgentTask {task_id: $task})
                RETURN binding.bound_at AS at, binding.task_revision AS revision, task.revision AS current'''
            before = (await driver.execute_query(statement, token=token, task=first))[0][0]
            assert before['at'] is not None and before['revision'] == before['current']
            await driver.execute_query('''MATCH (task:FuliProjectAgentTask {task_id: $task})
                SET task.revision=task.revision+1''', task=first)
            assert (await bind(client, scope, token, first)).status_code == 200
            after = (await driver.execute_query(statement, token=token, task=first))[0][0]
            assert after['at'] == before['at'] and after['revision'] == before['revision']
        for changes, status in [({'source_application': 'cursor'}, 404),
                                ({'personal_project_id': 'foreign-project'}, 409),
                                ({'agent_id': 'specialist'}, 422)]:
            assert (await bind(client, scope, token, first, **changes)).status_code == status
        foreign = (await client.post('/v1/spaces', json={'name': 'Synthetic foreign binding', 'kind': 'personal'})).json()['id']
        assert (await bind(client, scope, token, first, personal_space_id=foreign)).status_code == 404
        third = await binding_task(client, scope, 'synthetic-binding-third', lead='owner')
        # A binding must not let the old adoption endpoint forge a new owner;
        # its preceding link is rolled back with the rejected employee claim.
        bad_adopt = await client.put(f'/v1/task-contexts/{token}/agent', json={**scope,
            'source_application': 'codex', 'task_id': third, 'agent_id': 'owner'})
        assert bad_adopt.status_code == 409, bad_adopt.text
        checkpoint = {'personal_space_id': scope['personal_space_id'], 'source_application': 'codex',
            'disposition': 'retain_nothing', 'reason': 'No real worker ran.', 'fingerprint': 'c' * 64,
            'work_log': {'status': 'incomplete', 'summary': 'Binding metadata only; workers not executed.'}}
        for phase in ['prepare', 'complete']:
            saved = await client.put(f'/v1/task-contexts/{token}/checkpoint', json={**checkpoint, 'phase': phase})
            assert saved.status_code == 200 and saved.json()['coordination_task_ids'] == expected
            assert (await bind(client, scope, token, first)).status_code == 200
            assert (await bind(client, scope, token, third)).status_code == 409
    async with provider_client(settings, access_token) as (client, _):
        params = {'personal_space_id': scope['personal_space_id'], 'source_application': 'codex'}
        restored = await client.get(f'/v1/task-contexts/{token}', params=params)
        current = await client.get('/v1/task-context-sessions/current', params={**params, 'session_id': 'parent-one'})
        assert restored.json()['coordination_task_ids'] == current.json()['coordination_task_ids'] == expected
        assert restored.json()['project_agent_id'] == 'owner'
        await binding_parent(client, scope, 'fuli-task-binding-next-turn', 'parent-one')
        assert (await bind(client, scope, token, first)).status_code == 404
        assert (await bind(client, scope, 'fuli-task-binding-next-turn', first)).status_code == 200
        await binding_parent(client, scope, 'fuli-task-binding-cross-client', 'other-client', source='claude_code')
        assert (await bind(client, scope, 'fuli-task-binding-cross-client', first,
                           source_application='claude_code')).status_code == 200


@pytest.mark.asyncio
async def test_binding_requires_owner_role_and_concurrent_legal_parents_keep_their_associations():
    async with provider_client(fixture_settings()) as (client, _):
        scope = await binding_fixture(client)
        tokens = ['fuli-task-binding-race-one', 'fuli-task-binding-race-two']
        for index, token in enumerate(tokens):
            await binding_parent(client, scope, token, f'race-session-{index}')
        unrelated = await binding_task(client, scope, 'synthetic-binding-unrelated', coordinator='specialist')
        assert (await bind(client, scope, tokens[0], unrelated)).status_code == 409
        task_id = await binding_task(client, scope, 'synthetic-binding-race')
        results = await asyncio.gather(*(bind(client, scope, token, task_id) for token in tokens))
        assert [result.status_code for result in results] == [200, 200]
        for token, result in zip(tokens, results):
            assert result.json()['project_agent_id'] == 'owner'
            assert result.json()['coordination_task_ids'] == [task_id]
            saved = await client.get(f'/v1/task-contexts/{token}', params={
                'personal_space_id': scope['personal_space_id'], 'source_application': 'codex'})
            assert saved.json()['coordination_task_ids'] == [task_id]


@pytest.mark.asyncio
async def test_unowned_adoption_does_not_block_an_owned_binding_on_policy(monkeypatch):
    from fuli_graph.store_transactions import TransactionQueryDriver
    async with provider_client(fixture_settings(), raise_app_exceptions=False) as (client, _):
        scope = await binding_fixture(client)
        await binding_policy(client, scope)
        adopting, owned = 'fuli-task-adopting-parent', 'fuli-task-owned-specialist'
        await binding_parent(client, scope, adopting, 'adopting-session', owner=None)
        await binding_parent(client, scope, owned, 'owned-session', owner='specialist')
        first = await binding_task(client, scope, 'synthetic-adoption-lock-order')
        second = await binding_task(client, scope, 'synthetic-owned-lock-order',
                                    coordinator='specialist', lead='owner')
        locked, release = asyncio.Event(), asyncio.Event()
        execute = TransactionQueryDriver.execute_query

        async def pause_after_unowned_binding(driver, statement, **kwargs):
            result = await execute(driver, statement, **kwargs)
            if 'collect(assignment) AS assignments' in statement and kwargs.get('token') == adopting:
                locked.set()
                await release.wait()
            return result

        monkeypatch.setattr(TransactionQueryDriver, 'execute_query', pause_after_unowned_binding)
        adoption = asyncio.create_task(client.put(f'/v1/task-contexts/{adopting}/agent', json={
            **scope, 'source_application': 'codex', 'task_id': first, 'agent_id': 'specialist'}))
        try:
            await asyncio.wait_for(locked.wait(), 10)
            # This request locks the future adoption owner before the policy.
            # It must finish while adoption is paused, rather than form a cycle.
            linked = await asyncio.wait_for(bind(client, scope, owned, second), 10)
            assert linked.status_code == 200, linked.text
            assert linked.json()['project_agent_id'] == 'specialist'
            assert linked.json()['coordination_task_ids'] == [second]
        finally:
            release.set()
            adopted = await asyncio.wait_for(adoption, 10)
        assert adopted.status_code == 200, adopted.text
        assert adopted.json()['project_agent_id'] == 'specialist'
        assert adopted.json()['coordination_task_ids'] == [first]


@pytest.mark.asyncio
@pytest.mark.parametrize('withdrawal', ['client', 'assignment', 'policy'])
@pytest.mark.parametrize('stage', ['before_lock', 'after_lock'])
async def test_permission_withdrawal_cannot_bypass_binding_locks(monkeypatch, withdrawal, stage):
    from fuli_graph.store_transactions import TransactionQueryDriver
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        scope = await binding_fixture(client)
        if withdrawal == 'policy':
            await binding_policy(client, scope)
        token = 'fuli-task-binding-withdrawal'
        await binding_parent(client, scope, token, 'withdrawal-session')
        task_id = await binding_task(client, scope, 'synthetic-binding-withdrawal',
                                     coordinator='specialist' if withdrawal == 'policy' else 'owner')
        locked, release = asyncio.Event(), asyncio.Event()
        async with AsyncGraphDatabase.driver(settings.neo4j_uri, auth=('neo4j', settings.neo4j_password)) as driver:
            if withdrawal == 'client':
                rows, _, _ = await driver.execute_query('''MATCH (:FuliSpace {id: $space})-
                    [:HAS_PROJECT_AGENT_IDENTITY]->(owner:FuliProjectAgent {agent_id: 'owner'})
                    RETURN owner.profile_json AS profile''', space=scope['personal_space_id'])
                profile = json.loads(rows[0]['profile'])
                profile['allowed_clients'] = ['claude_code']
                query = '''MATCH (:FuliSpace {id: $space})-[:HAS_PROJECT_AGENT_IDENTITY]->
                    (owner:FuliProjectAgent {agent_id: 'owner'}) SET owner.profile_json=$profile'''
                changes = {'space': scope['personal_space_id'], 'profile': json.dumps(profile)}
            elif withdrawal == 'assignment':
                query = '''MATCH (:FuliSpace {id: $space})-[:CONTAINS_PROJECT]->
                    (:FuliPersonalProject {project_id: $project})-[:HAS_PROJECT_AGENT_ASSIGNMENT]->
                    (assignment:FuliProjectAgentAssignment {status: 'active'})-[:ASSIGNED_AGENT]->
                    (:FuliProjectAgent {agent_id: 'owner'}) SET assignment.status='ended' '''
                changes = {'space': scope['personal_space_id'], 'project': scope['personal_project_id']}
            else:
                query = '''MATCH (:FuliSpace {id: $space})-[:CONTAINS_PROJECT]->
                    (:FuliPersonalProject {project_id: $project})-[:HAS_PROJECT_AGENT_COORDINATION_POLICY]->
                    (policy:FuliProjectAgentCoordinationPolicy) SET policy.team_lead_agent_id='specialist' '''
                changes = {'space': scope['personal_space_id'], 'project': scope['personal_project_id']}
            execute = TransactionQueryDriver.execute_query
            async def intercept_binding(scoped_driver, statement, **kwargs):
                binding_lock = 'collect(assignment) AS assignments' in statement
                if binding_lock and stage == 'before_lock':
                    await driver.execute_query(query, **changes)
                result = await execute(scoped_driver, statement, **kwargs)
                if binding_lock and stage == 'after_lock':
                    locked.set()
                    await release.wait()
                return result
            monkeypatch.setattr(TransactionQueryDriver, 'execute_query', intercept_binding)
            if stage == 'before_lock':
                rejected = await bind(client, scope, token, task_id)
                assert rejected.status_code == 409, rejected.text
                restored = await client.get(f'/v1/task-contexts/{token}', params={
                    'personal_space_id': scope['personal_space_id'], 'source_application': 'codex'})
                assert restored.json().get('coordination_task_ids', []) == []
                return
            pending = asyncio.create_task(bind(client, scope, token, task_id))
            await asyncio.wait_for(locked.wait(), 10)
            revocation = asyncio.create_task(driver.execute_query(query, **changes))
            try:
                await asyncio.sleep(0.1)
                assert not revocation.done(), 'permission withdrawal bypassed the held owner/assignment lock'
            finally:
                release.set()
            linked = await asyncio.wait_for(pending, 10)
            await asyncio.wait_for(revocation, 10)
        assert linked.status_code == 200, linked.text
        retry = await bind(client, scope, token, task_id)
        assert retry.status_code in {403, 404, 409}, retry.text
