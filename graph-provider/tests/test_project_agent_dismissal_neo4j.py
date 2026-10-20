"""Bole's dismissal against an explicitly disposable graph.

Every identity, task and memory note is synthetic. The handoff document is
supplied as the Node host renders it; this suite proves what the Provider keeps.
"""

import pytest

from test_project_agent_memory_neo4j import fixture_settings, provider_client
from test_recruitment_guards_neo4j import recruitment_setup

REASON = 'Reported finished work without running the test suite, twice in one week.'
LESSONS = ['Run the relevant test suite before reporting a task as done.']
HANDOFF = {'filename': 'fuli-handoff.md', 'markdown': '# Synthetic handoff\n\nOpen thread: none.\n'}


def dismissal(scope, **changes):
    return {'personal_space_id': scope['personal_space_id'], 'reason': REASON,
            'lessons': LESSONS, 'handoff': HANDOFF, 'source_application': 'codex', **changes}


async def agent(client, scope, agent_id):
    response = await client.get(f'/v1/project-agents/{agent_id}', params={
        'personal_space_id': scope['personal_space_id']})
    assert response.status_code == 200, response.text
    return response.json()


async def member(client, scope, agent_id, *, role='engineering', test_role=False):
    response = await client.put('/v1/project-agents', json={
        **scope, 'agent_id': agent_id, 'occupation': {'role': role},
        'profile': {'name': f'Synthetic {agent_id}', 'responsibility': 'Maintain the sample.',
                    'work_kinds': ['implementation'], 'capabilities': ['coding'],
                    **({'test_source': 'synthetic_dismissal', 'cleanup_eligible': True}
                       if test_role else {})},
    })
    assert response.status_code == 200, response.text
    return response.json()


async def recruited(client):
    scope, payload = await recruitment_setup(client, confirmation=False)
    submitted = await client.post('/v1/project-agent-tasks', json={
        **payload, 'recruitment_occupation': {'role': 'engineering'}})
    assert submitted.status_code == 200, submitted.text
    task = submitted.json()['task']
    agent_id = submitted.json()['recruitment']['recruited_agent_id']
    # A cancelled task is real terminal history, not invented successful work.
    for participant in task['participants']:
        if participant['agent_id'] != agent_id:
            continue
        cancelled = await client.post(f"/v1/project-agent-tasks/{task['task_id']}/events", json={
            **scope, 'task_id': task['task_id'], 'agent_id': agent_id,
            'expected_revision': task['revision'], 'status': 'cancelled',
            'idempotency_key': 'synthetic-dismissal-cancel', 'source_application': 'codex',
            'summary': 'Synthetic cancellation before dismissal.'})
        assert cancelled.status_code == 200, cancelled.text
    # The recruit became the project lead; it hands the lead off before leaving.
    await member(client, scope, 'new-lead')
    handoff = await client.put('/v1/project-agent-coordination-policy', json={
        **scope, 'ask_before_recruitment': False, 'auto_reuse_previous_agent': True,
        'team_lead_agent_id': 'new-lead'})
    assert handoff.status_code == 200, handoff.text
    return scope, agent_id, task['task_id']


async def lessons(client, scope, **params):
    response = await client.get('/v1/project-agent-dismissal-lessons', params={
        'personal_space_id': scope['personal_space_id'], **params})
    assert response.status_code == 200, response.text
    return response.json()


@pytest.mark.asyncio
async def test_upsert_cannot_archive_and_dismissal_requires_a_reason():
    async with provider_client(fixture_settings(), raise_app_exceptions=False) as (client, _):
        scope, _payload = await recruitment_setup(client, confirmation=False)
        await member(client, scope, 'reasonless')
        bypass = await client.put('/v1/project-agents', json={
            **scope, 'agent_id': 'reasonless',
            'profile': {'name': 'Synthetic reasonless', 'responsibility': 'Maintain the sample.',
                        'status': 'archived'}})
        assert bypass.status_code == 422, bypass.text
        url = '/v1/project-agents/reasonless/dismissal'
        missing = dismissal(scope)
        del missing['reason']
        for body in [missing, dismissal(scope, reason='   '), dismissal(scope, reason='ok'),
                     dismissal(scope, reason='none', lessons=[]),
                     dismissal(scope, reason='Archived by user.', lessons=[])]:
            rejected = await client.post(url, json=body)
            assert rejected.status_code == 422, rejected.text
        assert (await agent(client, scope, 'reasonless'))['profile']['status'] == 'active'
        assert (await lessons(client, scope, occupation='engineering'))['total'] == 0


@pytest.mark.asyncio
async def test_dismissal_keeps_history_lesson_and_handoff_and_never_reuses_the_number():
    async with provider_client(fixture_settings(), raise_app_exceptions=False) as (client, _):
        scope, agent_id, task_id = await recruited(client)
        before = await agent(client, scope, agent_id)
        assert before['assignments'][0]['status'] == 'active'
        receipt = await client.post(f'/v1/project-agents/{agent_id}/dismissal', json=dismissal(scope))
        assert receipt.status_code == 200, receipt.text
        value = receipt.json()
        assert value['agent_id'] == agent_id and value['replayed'] is False
        assert value['employee_number'] == before['employee_number']
        assert value['occupation_role'] == 'engineering'
        assert value['project_ids'] == [scope['personal_project_id']]
        assert value['lesson_count'] == 1
        assert 'markdown' not in str(value) and 'handoff' not in value

        after = await agent(client, scope, agent_id)
        assert after['profile']['status'] == 'archived'
        assert after['archive_reason'] == REASON and after['archived_at']
        assert after['employee_number'] == before['employee_number']
        assert [item['status'] for item in after['assignments']] == ['ended']
        tasks = await client.get('/v1/project-agent-tasks', params={**scope, 'agent_id': agent_id})
        assert task_id in [item['task_id'] for item in tasks.json()]
        recruitments = await client.get('/v1/project-agent-recruitments', params=scope)
        assert agent_id in [item['recruited_agent_id'] for item in recruitments.json()]

        record = await client.get(f'/v1/project-agents/{agent_id}/dismissal', params={
            'personal_space_id': scope['personal_space_id']})
        assert record.status_code == 200, record.text
        assert record.json()['handoff'] == HANDOFF
        assert record.json()['reason'] == REASON

        by_occupation = await lessons(client, scope, occupation='engineering')
        by_project = await lessons(client, scope, personal_project_id=scope['personal_project_id'])
        for found, basis in [(by_occupation, 'occupation'), (by_project, 'project')]:
            assert found['total'] == 1
            assert found['items'][0]['lessons'] == LESSONS
            assert found['items'][0]['reason'] == REASON
            assert found['items'][0]['matched_by'] == [basis]
        assert (await lessons(client, scope, occupation='engineering', limit=0)) == {'total': 1, 'items': []}
        assert (await lessons(client, scope, occupation='design'))['total'] == 0
        assert (await lessons(client, scope, occupation='engineering', query='deploy'))['total'] == 0
        assert (await lessons(client, scope, occupation='engineering', query='TEST SUITE'))['total'] == 1
        unscoped = await client.get('/v1/project-agent-dismissal-lessons', params={
            'personal_space_id': scope['personal_space_id']})
        assert unscoped.status_code == 422, unscoped.text

        successor = await member(client, scope, 'successor')
        assert int(successor['employee_number']) > int(before['employee_number'])
        replayed = await client.post(f'/v1/project-agents/{agent_id}/dismissal', json=dismissal(scope))
        assert replayed.status_code == 200, replayed.text
        assert replayed.json()['replayed'] is True
        assert replayed.json()['dismissal_id'] == value['dismissal_id']
        changed = await client.post(f'/v1/project-agents/{agent_id}/dismissal',
                                    json=dismissal(scope, reason='A different later reason entirely.'))
        assert changed.status_code == 409, changed.text
        revived = await client.put('/v1/project-agents', json={
            **scope, 'agent_id': agent_id,
            'profile': {'name': 'Synthetic revived', 'responsibility': 'Maintain the sample.'}})
        assert revived.status_code == 409, revived.text


@pytest.mark.asyncio
async def test_dismissal_still_refuses_system_roles_open_work_and_project_leads():
    async with provider_client(fixture_settings(), raise_app_exceptions=False) as (client, _):
        scope, payload = await recruitment_setup(client, confirmation=False)
        system = await client.post('/v1/project-agents/system-hr', params={
            'personal_space_id': scope['personal_space_id']})
        assert system.status_code == 200, system.text
        for system_id in ['employee.assistant', 'employee.jefa', 'employee.bole']:
            refused = await client.post(f'/v1/project-agents/{system_id}/dismissal', json=dismissal(scope))
            assert refused.status_code == 422, refused.text

        await member(client, scope, 'busy')
        queued = await client.post('/v1/project-agent-tasks', json={
            **payload, 'idempotency_key': 'synthetic-dismissal-open-work',
            'staffing_intent': 'reuse_preferred', 'lead_agent_id': 'busy'})
        assert queued.status_code == 200, queued.text
        busy = await client.post('/v1/project-agents/busy/dismissal', json=dismissal(scope))
        assert busy.status_code == 409, busy.text
        assert 'open task' in busy.json()['detail']

        await member(client, scope, 'lead')
        policy = await client.put('/v1/project-agent-coordination-policy', json={
            **scope, 'ask_before_recruitment': False, 'auto_reuse_previous_agent': True,
            'team_lead_agent_id': 'lead'})
        assert policy.status_code == 200, policy.text
        lead = await client.post('/v1/project-agents/lead/dismissal', json=dismissal(scope))
        assert lead.status_code == 409, lead.text
        assert 'hand off' in lead.json()['detail']
        assert (await lessons(client, scope, occupation='engineering'))['total'] == 0
        for agent_id in ['busy', 'lead']:
            assert (await agent(client, scope, agent_id))['profile']['status'] == 'active'


@pytest.mark.asyncio
async def test_plain_archive_is_only_for_test_roles():
    async with provider_client(fixture_settings(), raise_app_exceptions=False) as (client, _):
        scope, _payload = await recruitment_setup(client, confirmation=False)
        await member(client, scope, 'durable-role')
        await member(client, scope, 'probe-role', test_role=True)
        params = {'personal_space_id': scope['personal_space_id'], 'reason': 'archived test role'}
        refused = await client.delete('/v1/project-agents/durable-role', params=params)
        assert refused.status_code == 409, refused.text
        assert 'dismissal' in refused.json()['detail']
        archived = await client.delete('/v1/project-agents/probe-role', params=params)
        assert archived.status_code == 200, archived.text
        assert archived.json()['profile']['status'] == 'archived'
        assert archived.json()['archive_reason'] == 'archived test role'
        assert (await agent(client, scope, 'durable-role'))['profile']['status'] == 'active'
