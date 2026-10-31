import pytest
import hashlib
import json
from pydantic import ValidationError
from fuli_graph.project_agent_task_models import ProjectAgentTaskActivityCreate
from test_project_agent_memory_neo4j import fixture_settings, provider_client, seed_agent


def activity(**changes):
    return dict(personal_space_id='space', personal_project_id='project', task_id='task',
                idempotency_key='synthetic-plan-event', agent_id='engineer', status='running',
                summary='Synthetic plan progress.', source_application='codex', **changes)


def test_optional_plan_has_stable_unique_steps_and_explicit_status():
    assert ProjectAgentTaskActivityCreate(**activity()).execution_plan is None
    step = dict(id='verify', title='Verify the result', status='in_progress')
    saved = ProjectAgentTaskActivityCreate(**activity(execution_plan={'steps': [step]}))
    assert saved.execution_plan.steps[0].id == 'verify'
    for steps in [[step, step], [{**step, 'status': 'invented'}], [{**step, 'title': ' '}]]:
        with pytest.raises(ValidationError):
            ProjectAgentTaskActivityCreate(**activity(execution_plan={'steps': steps}))


def test_a_step_owner_is_optional_and_an_unowned_step_serializes_as_before():
    step = dict(id='verify', title='Verify the result', status='in_progress')
    unowned = ProjectAgentTaskActivityCreate(**activity(execution_plan={'steps': [step]}))
    assert json.loads(unowned.execution_plan.model_dump_json())['steps'] == [{**step, 'detail': None}]
    assert 'agent_id' not in unowned.model_dump(mode='json')['execution_plan']['steps'][0]
    owned = ProjectAgentTaskActivityCreate(**activity(execution_plan={'steps': [{**step, 'agent_id': 'engineer'}]}))
    assert owned.execution_plan.steps[0].agent_id == 'engineer'
    assert json.loads(owned.execution_plan.model_dump_json())['steps'][0]['agent_id'] == 'engineer'
    with pytest.raises(ValidationError):
        ProjectAgentTaskActivityCreate(**activity(execution_plan={'steps': [{**step, 'agent_id': ''}]}))


def test_absent_plan_preserves_pre_upgrade_activity_fingerprint():
    from fuli_graph.store import GraphStore
    request = ProjectAgentTaskActivityCreate(**activity())
    legacy_payload = request.model_dump(mode='json', exclude={'idempotency_key', 'execution_plan'})
    legacy_hash = hashlib.sha256(json.dumps(legacy_payload, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    assert GraphStore._payload_hash(request) == legacy_hash
    withdrawn = ProjectAgentTaskActivityCreate(**activity(execution_plan={'steps': []}))
    assert GraphStore._payload_hash(withdrawn) != legacy_hash


@pytest.mark.asyncio
async def test_plan_round_trip_updates_and_withdrawal_preserve_history():
    async with provider_client(fixture_settings()) as (client, _):
        space = (await client.post('/v1/spaces', json={'name': 'Synthetic plan test', 'kind': 'personal'})).json()
        await seed_agent(client, space['id'])
        scope = dict(personal_space_id=space['id'], personal_project_id='sample-project')
        created = await client.post('/v1/project-agent-tasks', json={**scope,
            'idempotency_key': 'synthetic-plan-task', 'title': 'Verify plan progress',
            'objective': 'Expose actual optional steps.', 'work_kind': 'implementation',
            'lead_agent_id': 'engineer', 'source_application': 'codex', 'routing_reason': 'Use assigned engineer.'})
        assert created.status_code == 200, created.text
        task = created.json()['task']
        original_status = task['status']
        path = f'/v1/project-agent-tasks/{task["task_id"]}/events'
        plans = [
            {'steps': [{'id': 'verify', 'title': 'Verify result', 'status': 'in_progress'}]},
            {'steps': [{'id': 'verify', 'title': 'Verify result', 'status': 'completed', 'detail': 'Synthetic test passed.'}]},
            {'steps': []},
        ]
        for index, plan in enumerate(plans):
            body = {**activity(), **scope, 'task_id': task['task_id'], 'expected_revision': task['revision'],
                    'status': original_status, 'idempotency_key': f'synthetic-plan-event-{index}', 'execution_plan': plan}
            response = await client.post(path, json=body)
            assert response.status_code == 200, response.text
            task = response.json()
            assert task['status'] == original_status, 'Step completion must not accept the entire task'
            current = task['events'][-1]['execution_plan']
            assert current['steps'] == [{**step, 'detail': step.get('detail')} for step in plan['steps']]
            replay = await client.post(path, json=body)
            assert replay.json() == task
        listed = await client.get('/v1/project-agent-tasks', params=scope)
        persisted = next(item for item in listed.json() if item['task_id'] == task['task_id'])
        assert [event['execution_plan']['steps'][0]['status'] for event in persisted['events']
                if (event.get('execution_plan') or {}).get('steps')] == ['in_progress', 'completed']
        assert persisted['events'][-1]['execution_plan'] == {'steps': []}
