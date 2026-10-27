"""Task status write-back and owner task records, without a graph."""

import pytest
from fastapi import HTTPException

from fuli_graph.project_agent_task_models import ProjectAgentTaskActivityCreate
from test_project_agent_tasks import ActivityStore


def late_worker_store(task_status):
    return ActivityStore({
        'task': {'task_id': 'task-a', 'personal_project_id': 'project-a',
                 'status': task_status, 'revision': 7, 'lead_agent_id': 'lead-a'},
        'participant_rows': [{'agent_id': 'lead-a', 'role': 'lead'},
                             {'agent_id': 'member-b', 'role': 'collaborator'}],
        'event_rows': [],
    }, event_rows=[{'same_payload': True, 'applied_transition': True}])


def late_worker_report(**changes):
    return ProjectAgentTaskActivityCreate(**{
        'personal_space_id': 'personal-space', 'personal_project_id': 'project-a',
        'task_id': 'task-a', 'idempotency_key': 'late-worker-terminal',
        'status': 'awaiting_review', 'worker_status': 'completed',
        'summary': 'Synthetic worker finished its slice.', 'agent_id': 'member-b',
        'worker_id': 'worker-b', 'source_application': 'codex', **changes})


@pytest.mark.asyncio
@pytest.mark.parametrize('task_status', ['completed', 'cancelled', 'paused'])
async def test_a_late_worker_report_is_recorded_without_moving_the_task(task_status):
    # The lead already accepted, cancelled or paused the task; the worker's own
    # terminal report must still land, or its participation disappears.
    store = late_worker_store(task_status)
    assert await store.record_project_agent_task_activity({'id': 'principal'}, late_worker_report()) == 'updated-task'
    query, params = store.runtime.driver.event_calls[0]
    assert params['worker_only'] is True
    assert params['status'] == task_status
    assert params['worker_status'] == 'completed'
    assert params['terminal_at'] is None
    assert 'WHEN same_payload AND applied_transition AND NOT $worker_only' in query
    assert 'AND NOT $worker_only\n                AND participant IS NOT NULL' in query


@pytest.mark.asyncio
async def test_a_worker_report_on_a_running_task_still_moves_the_task():
    store = late_worker_store('running')
    await store.record_project_agent_task_activity({'id': 'principal'}, late_worker_report())
    _, params = store.runtime.driver.event_calls[0]
    assert params['worker_only'] is False
    assert params['status'] == 'awaiting_review'


@pytest.mark.asyncio
async def test_a_worker_report_on_a_blocked_task_is_refused_with_its_reason():
    store = late_worker_store('blocked')
    with pytest.raises(HTTPException, match='blocked -> awaiting_review'):
        await store.record_project_agent_task_activity({'id': 'principal'}, late_worker_report())
    assert store.runtime.driver.event_calls == []


@pytest.mark.asyncio
async def test_a_stale_status_update_names_both_revisions():
    store = late_worker_store('running')
    with pytest.raises(HTTPException, match='expected 5, current 7') as error:
        await store.record_project_agent_task_activity({'id': 'principal'}, late_worker_report(expected_revision=5))
    assert error.value.status_code == 409
    assert store.runtime.driver.event_calls == []


@pytest.mark.asyncio
async def test_an_agents_task_list_includes_tasks_it_dispatched_from_its_own_context():
    # Tasks dispatched before the dispatcher became their coordinator carry the
    # system coordinator; the dispatching context's link is the owner's record.
    store = ActivityStore({})
    await store.list_project_agent_tasks({'id': 'principal'}, 'personal-space',
                                         personal_project_id='project-a', agent_id='lead-a')
    query, params = next(call for call in store.runtime.driver.calls if 'ORDER BY task.updated_at' in call[0])
    normalized = ' '.join(query.split())
    assert ('MATCH (:FuliTaskContext {personal_space_id: $personal_space_id, '
            'project_agent_id: $agent_id})-[:COORDINATES_TASK]->(task)') in normalized
    assert params['agent_id'] == 'lead-a'
