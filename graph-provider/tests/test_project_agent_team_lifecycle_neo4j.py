"""Synthetic lifecycle acceptance over a disposable real graph, without models."""

import pytest

from test_project_agent_memory_neo4j import fixture_settings, provider_client
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
        repeated = await client.put(f'/v1/task-contexts/{token}/agent', json=claim)
        assert repeated.json() == adopted.json()
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
