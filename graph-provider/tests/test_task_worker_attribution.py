"""Frozen checkpoint owner names, without a graph."""

import json
from types import SimpleNamespace

import pytest

from fuli_graph.project_agent_names import agent_display_name
from fuli_graph.task_worker_attribution import checkpoint_collaboration


def store_with_owner(profile):
    async def execute_query(*_args, **_kwargs):
        return [{'profile_json': json.dumps(profile)}], None, None
    return SimpleNamespace(runtime=SimpleNamespace(driver=SimpleNamespace(execute_query=execute_query)))


@pytest.mark.asyncio
async def test_owner_role_title_is_kept_as_role_not_as_name():
    store = store_with_owner({'name': 'Synthetic Framework 负责人'})
    snapshot = await checkpoint_collaboration(store, 'space', {'project_agent_id': 'lead-a'})
    assert snapshot['owner'] == {'agent_id': 'lead-a', 'role': 'Synthetic Framework 负责人',
        'name': agent_display_name('lead-a', 'Synthetic Framework 负责人')}
    assert '负责人' not in snapshot['owner']['name']


@pytest.mark.asyncio
async def test_owner_configured_name_stays_the_name():
    store = store_with_owner({'name': 'Synthetic Framework 负责人', 'display_name': 'Lumi'})
    snapshot = await checkpoint_collaboration(store, 'space', {'project_agent_id': 'lead-a'})
    assert snapshot['owner'] == {'agent_id': 'lead-a', 'name': 'Lumi', 'role': 'Synthetic Framework 负责人'}


def store_with_host_workers(rows, calls):
    async def execute_query(query, **params):
        calls.append((query, params))
        if 'owner.profile_json' in query:
            return [{'profile_json': json.dumps({'name': 'Synthetic backup lead', 'display_name': 'Lead'})}], None, None
        if 'COORDINATES_TASK' in query:
            return rows, None, None
        return [], None, None
    return SimpleNamespace(runtime=SimpleNamespace(driver=SimpleNamespace(execute_query=execute_query)))


def host_row(agent_id, worker_id, status='completed'):
    return {'task_id': 'task-backup', 'work_kind': 'implementation', 'agent_id': agent_id,
        'profile_json': json.dumps({'name': f'Synthetic {agent_id}', 'responsibility': 'Synthetic slice.'}),
        'event': {'event_id': f'event-{worker_id}', 'worker_id': worker_id, 'worker_status': status,
                  'worker_label': f'{agent_id} slice', 'source_application': 'claude_code',
                  'worker_runtime_json': None}}


CONTEXT = {'project_agent_id': 'lead-a', 'personal_project_id': 'backup', 'token': 'fuli-task-backup',
           'source_application': 'claude_code', 'session_id': 'lead-session', 'source_session_id': 'lead-mcp'}


@pytest.mark.asyncio
async def test_members_who_ran_inside_the_lead_session_are_collaborators_not_only_the_lead():
    calls = []
    store = store_with_host_workers([host_row('member-b', 'subagent-1'),
                                     host_row('member-c', 'subagent-2', 'failed')], calls)
    snapshot = await checkpoint_collaboration(store, 'space', CONTEXT)
    assert snapshot['owner']['agent_id'] == 'lead-a'
    assert [item['agent_id'] for item in snapshot['collaborators']] == ['member-b', 'member-c']
    assert snapshot['collaborators'][1]['runs'] == [{'run_id': None, 'worker_id': 'subagent-2',
        'task_id': 'task-backup', 'work_kind': 'implementation', 'worker_label': 'member-c slice',
        'application': 'claude_code', 'session_id': None, 'session_url': None, 'status': 'failed',
        'event_id': 'event-subagent-2', 'observation_ids': []}]
    query, params = next(call for call in calls if 'COORDINATES_TASK' in call[0])
    # Scoped to this context's own session and coordinated tasks; launched runs stay run-proven.
    assert params['sessions'] == ['lead-mcp', 'lead-session']
    assert params['application'] == 'claude_code' and params['owner_id'] == 'lead-a'
    assert 'HAS_WORKER_RUN' in query and 'event.worker_status IN $terminal' in query


@pytest.mark.asyncio
async def test_a_context_without_a_session_reads_no_host_worker_evidence():
    calls = []
    store = store_with_host_workers([host_row('member-b', 'subagent-1')], calls)
    snapshot = await checkpoint_collaboration(store, 'space', {**CONTEXT, 'session_id': None, 'source_session_id': None})
    assert snapshot['collaborators'] == []
    assert not any('COORDINATES_TASK' in query for query, _ in calls)
