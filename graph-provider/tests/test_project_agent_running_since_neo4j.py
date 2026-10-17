"""A participant's run start is stamped on entry into running, never inferred."""

import pytest

from test_project_agent_activity_atomicity_neo4j import seed_executor
from test_project_agent_memory_neo4j import fixture_settings, provider_client, seed_agent


async def post_status(client, scope, task, status, key):
    response = await client.post(
        f'/v1/project-agent-tasks/{task["task_id"]}/events',
        json={
            **scope, 'task_id': task['task_id'], 'agent_id': 'engineer',
            'expected_revision': task['revision'], 'idempotency_key': key,
            'status': status, 'summary': f'Synthetic {status} transition.',
            'source_application': 'codex',
            **({
                'actual_executor_id': 'synthetic-executor',
                'actual_model_provider': 'synthetic',
                'actual_model': 'synthetic-model',
            } if status == 'running' else {}),
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def participant(task):
    [value] = [item for item in task['participants'] if item['agent_id'] == 'engineer']
    return value


@pytest.mark.asyncio
async def test_running_since_follows_real_transitions_and_reaches_the_roster():
    async with provider_client(fixture_settings(), raise_app_exceptions=False) as (client, _):
        space = await client.post('/v1/spaces', json={
            'name': 'Synthetic running-since acceptance', 'kind': 'personal',
        })
        assert space.status_code == 200, space.text
        scope = {'personal_space_id': space.json()['id'],
                 'personal_project_id': 'sample-project'}
        await seed_agent(client, scope['personal_space_id'])
        await seed_executor(client, scope['personal_space_id'])
        created = await client.post('/v1/project-agent-tasks', json={
            **scope, 'idempotency_key': 'synthetic-running-since-task',
            'title': 'Synthetic running-since task',
            'objective': 'Record when the participant actually starts running.',
            'work_kind': 'implementation', 'lead_agent_id': 'engineer',
            'source_application': 'codex',
            'routing_reason': 'Use the assigned synthetic engineer.',
        })
        assert created.status_code == 200, created.text
        task = created.json()['task']
        if task['status'] != 'running':
            assert participant(task)['running_since'] is None

        first = await post_status(client, scope, task, 'running', 'synthetic-run-1')
        started = participant(first)['running_since']
        assert started is not None

        again = await post_status(client, scope, first, 'running', 'synthetic-run-2')
        # Staying in running keeps the original start.
        assert participant(again)['running_since'] == started

        roster = await client.get('/v1/project-agents', params={
            'personal_space_id': scope['personal_space_id'],
        })
        assert roster.status_code == 200, roster.text
        [engineer] = [item for item in roster.json() if item['agent_id'] == 'engineer']
        assert engineer['work_status'] == 'running'
        assert engineer['current_task_running_since'] == started

        blocked = await post_status(client, scope, again, 'blocked', 'synthetic-block')
        assert participant(blocked)['running_since'] is None

        resumed = await post_status(client, scope, blocked, 'running', 'synthetic-run-3')
        restarted = participant(resumed)['running_since']
        assert restarted is not None and restarted > started

        roster = await client.get('/v1/project-agents', params={
            'personal_space_id': scope['personal_space_id'],
        })
        [engineer] = [item for item in roster.json() if item['agent_id'] == 'engineer']
        assert engineer['current_task_running_since'] == restarted
