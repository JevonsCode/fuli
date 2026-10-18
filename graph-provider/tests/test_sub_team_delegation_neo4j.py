import pytest
from neo4j import AsyncGraphDatabase

from test_agent_delegations_neo4j import setup_delegation, issue, resolve
from test_project_agent_memory_neo4j import fixture_settings, provider_client, seed_agent


async def grouped(client):
    scope, request = await setup_delegation(client)
    await seed_agent(client, scope['personal_space_id'], agent='sub')
    groups = [{'id': 'backend', 'name': 'Backend', 'lead_agent_id': 'sub', 'member_agent_ids': ['member']}]
    response = await client.put('/v1/project-agent-coordination-policy', json={**scope,
        'team_lead_agent_id': 'lead', 'team_member_agent_ids': ['sub', 'member', 'other'], 'sub_teams': groups})
    assert response.status_code == 200, response.text
    return scope, request, groups, response.json()


async def task(client, scope, agent):
    token = f'fuli-task-{scope["personal_space_id"]}-{agent}'
    response = await client.put('/v1/task-contexts', json={**scope, 'token': token,
        'project_agent_id': agent, 'source_application': 'codex', 'session_id': f'synthetic-{agent}'})
    assert response.status_code == 200, response.text
    return token


@pytest.mark.asyncio
async def test_root_to_sublead_to_member_and_reports_never_skip_a_level():
    async with provider_client(fixture_settings()) as (client, _):
        scope, request, _, _ = await grouped(client)
        denied = await client.post('/v1/project-agent-context/delegations', json=request)
        assert denied.status_code == 403, denied.text
        grant = await issue(client, {**request, 'agent_id': 'sub'})
        sub = await resolve(client, scope, grant, 'sub-native', agent_id='sub')
        assert sub['status'] == 'ready', sub
        assert sub['agent']['agent_id'] == 'sub' and sub['reporting_lead_agent_id'] == 'lead'
        sub_token = await task(client, scope, 'sub')
        grant = await issue(client, {**request, 'task_context_token': sub_token})
        member = await resolve(client, scope, grant, 'member-native')
        assert member['agent']['agent_id'] == 'member'
        assert member['reporting_lead_agent_id'] == 'sub'
        child_token = await task(client, scope, 'member')
        for target in ['lead', 'other']:
            denied = await client.post('/v1/project-agent-context/delegations', json={**request,
                'task_context_token': child_token, 'agent_id': target})
            assert denied.status_code == 403, denied.text
        grant = await issue(client, {**request, 'task_context_token': child_token, 'agent_id': 'sub'})
        assert (await resolve(client, scope, grant, 'report-sub', agent_id='sub'))['status'] == 'ready'


@pytest.mark.asyncio
async def test_regrouping_invalidates_existing_capability_without_rewriting_task_history():
    async with provider_client(fixture_settings()) as (client, _):
        scope, request, groups, saved = await grouped(client)
        grant = await issue(client, {**request, 'agent_id': 'sub'})
        assert (await resolve(client, scope, grant, 'sub-native', agent_id='sub'))['status'] == 'ready'
        response = await client.put('/v1/project-agent-coordination-policy', json={**scope,
            'sub_teams': [{**groups[0], 'name': 'Renamed Backend'}], 'expected_updated_at': saved['updated_at']})
        assert response.status_code == 200, response.text
        denied = await resolve(client, scope, grant, 'sub-native', agent_id='sub')
        assert denied['status'] == 'agent_unavailable'
        stale = await client.put('/v1/project-agent-coordination-policy', json={**scope,
            'sub_teams': [], 'expected_updated_at': saved['updated_at']})
        assert stale.status_code == 409, stale.text


@pytest.mark.asyncio
@pytest.mark.parametrize('change', ['archived', 'ended', 'client'])
async def test_sender_must_remain_active_assigned_and_client_authorized(change):
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        scope, request, _, _ = await grouped(client)
        child_token = await task(client, scope, 'member')
        grant = await issue(client, {**request, 'task_context_token': child_token, 'agent_id': 'sub'})
        if change == 'client':
            await seed_agent(client, scope['personal_space_id'], agent='member', allowed_clients=['claude_code'])
        else:
            async with AsyncGraphDatabase.driver(settings.neo4j_uri, auth=('neo4j', settings.neo4j_password)) as driver:
                mutation = "SET agent.status = 'archived'" if change == 'archived' else "SET assignment.status = 'ended'"
                await driver.execute_query('''MATCH (:FuliSpace {id: $space})-[:CONTAINS_PROJECT]->
                    (:FuliPersonalProject {project_id: $project})-[:HAS_PROJECT_AGENT_ASSIGNMENT]->
                    (assignment:FuliProjectAgentAssignment)-[:ASSIGNED_AGENT]->(agent:FuliProjectAgent {agent_id: 'member'})
                    ''' + mutation, space=scope['personal_space_id'], project=scope['personal_project_id'])
        denied = await resolve(client, scope, grant, 'report-sub', agent_id='sub')
        assert denied['status'] == 'agent_unavailable', denied


@pytest.mark.asyncio
async def test_tasks_use_the_immediate_coordinator_without_changing_legacy_assignments():
    async with provider_client(fixture_settings()) as (client, _):
        scope, _, _, _ = await grouped(client)
        payload = {**scope, 'idempotency_key': 'synthetic-group-task', 'title': 'Synthetic grouped task',
            'objective': 'Check reporting only', 'work_kind': 'implementation', 'source_application': 'codex',
            'staffing_intent': 'reuse_preferred', 'lead_agent_id': 'member',
            'routing_reason': 'Synthetic immediate reporting chain acceptance.'}
        for coordinator in ['lead', 'member']:
            skipped = await client.post('/v1/project-agent-tasks', json={**payload, 'coordinator_agent_id': coordinator})
            assert skipped.status_code == 403, skipped.text
        cross_group = await client.post('/v1/project-agent-tasks', json={**payload,
            'coordinator_agent_id': 'sub', 'collaborator_agent_ids': ['other']})
        assert cross_group.status_code == 403, cross_group.text
        reversed_chain = await client.post('/v1/project-agent-tasks', json={**payload,
            'lead_agent_id': 'lead', 'coordinator_agent_id': 'sub'})
        assert reversed_chain.status_code == 403, reversed_chain.text
        saved = await client.post('/v1/project-agent-tasks', json=payload)
        assert saved.status_code == 200, saved.text
        assert saved.json()['task']['coordinator_agent_id'] == 'sub'
        assert saved.json()['task']['lead_agent_id'] == 'member'
        assert saved.json()['task']['execution_summary'] == []
        # A sub-lead cannot use a local skill gap to recruit around its parent.
        held = await client.post('/v1/project-agent-tasks', json={**payload,
            'idempotency_key': 'synthetic-subteam-gap', 'lead_agent_id': None,
            'work_kind': 'unmatched-kind', 'coordinator_agent_id': 'sub'})
        assert held.status_code == 200, held.text
        assert held.json()['task']['status'] == 'blocked'
        assert held.json()['task']['routing_reason'] == 'project_sub_team_gap'
        assert held.json()['recruitment'] is None
        sub_token = await task(client, scope, 'sub')
        forged = await client.post('/v1/project-agent-tasks', json={**payload,
            'idempotency_key': 'synthetic-forged-coordinator', 'lead_agent_id': 'other',
            'coordinator_agent_id': 'lead', 'task_context_token': sub_token})
        assert forged.status_code == 403, forged.text
        member_token = await task(client, scope, 'member')
        sibling = await client.post('/v1/project-agent-tasks', json={**payload,
            'idempotency_key': 'synthetic-child-dispatch', 'lead_agent_id': 'other',
            'coordinator_agent_id': 'lead', 'task_context_token': member_token})
        assert sibling.status_code == 403, sibling.text
        own = await client.post('/v1/project-agent-tasks', json={**payload,
            'idempotency_key': 'synthetic-child-own-task', 'task_context_token': member_token})
        assert own.status_code == 200, own.text
        assert own.json()['task']['coordinator_agent_id'] == 'sub'


@pytest.mark.asyncio
async def test_worker_runs_reject_old_policy_then_bind_current_hierarchy_until_regrouping():
    from hashlib import sha256
    from secrets import token_urlsafe
    from test_agent_delegations_neo4j import sealed_worker_run
    async with provider_client(fixture_settings()) as (client, _):
        scope, payload, old_headers, old_path, _ = await sealed_worker_run(client)
        groups = [{'id': 'one', 'name': 'One', 'lead_agent_id': 'specialist', 'member_agent_ids': []}]
        saved = await client.put('/v1/project-agent-coordination-policy', json={**scope,
            'team_lead_agent_id': 'owner', 'team_member_agent_ids': ['specialist'], 'sub_teams': groups})
        assert saved.status_code == 200, saved.text
        stale = await client.post(old_path + '/start-claim', json=scope, headers=old_headers)
        assert stale.status_code == 409, stale.text
        capability = token_urlsafe(32)
        fresh = await client.put('/v1/project-agent-worker-runs', json={**payload,
            'idempotency_key': 'synthetic-current-hierarchy-worker',
            'runtime_capability_hash': sha256(capability.encode()).hexdigest()})
        assert fresh.status_code == 200, fresh.text
        path = '/v1/project-agent-worker-runs/' + fresh.json()['run_id']
        headers = {'x-fuli-worker-capability': capability}
        assert (await client.post(path + '/start-claim', json=scope, headers=headers)).status_code == 200
        renamed = await client.put('/v1/project-agent-coordination-policy', json={**scope,
            'sub_teams': [{**groups[0], 'name': 'Renamed'}], 'expected_updated_at': saved.json()['updated_at']})
        assert renamed.status_code == 200, renamed.text
        denied = await client.post(path + '/start-claim', json=scope, headers=headers)
        assert denied.status_code == 409, denied.text


@pytest.mark.asyncio
@pytest.mark.parametrize('change', ['ended', 'client'])
async def test_grouped_staffing_rechecks_the_sending_sublead_before_persistence(change):
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        scope, _, _, _ = await grouped(client)
        sub_token = await task(client, scope, 'sub')
        if change == 'client':
            await seed_agent(client, scope['personal_space_id'], agent='sub', allowed_clients=['claude_code'])
        else:
            async with AsyncGraphDatabase.driver(settings.neo4j_uri, auth=('neo4j', settings.neo4j_password)) as driver:
                await driver.execute_query('''MATCH (:FuliSpace {id: $space})-[:CONTAINS_PROJECT]->
                    (:FuliPersonalProject {project_id: $project})-[:HAS_PROJECT_AGENT_ASSIGNMENT]->
                    (assignment:FuliProjectAgentAssignment)-[:ASSIGNED_AGENT]->(:FuliProjectAgent {agent_id: 'sub'})
                    SET assignment.status = 'ended' ''', space=scope['personal_space_id'], project=scope['personal_project_id'])
        denied = await client.post('/v1/project-agent-tasks', json={**scope,
            'task_context_token': sub_token, 'idempotency_key': 'synthetic-revoked-sub-staffing',
            'title': 'Synthetic revoked sender', 'objective': 'Must not staff a child',
            'work_kind': 'implementation', 'source_application': 'codex', 'lead_agent_id': 'member',
            'coordinator_agent_id': 'sub', 'routing_reason': 'Synthetic source authority boundary'})
        assert denied.status_code in {403, 404}, denied.text
