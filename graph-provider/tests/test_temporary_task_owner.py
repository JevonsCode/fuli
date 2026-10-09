from datetime import UTC, datetime
from types import SimpleNamespace

import pytest

from fuli_graph.project_agent_context_models import ProjectAgentContextRequest
from fuli_graph.project_agent_models import ProjectAgentProfile, ProjectAgentRecord
from fuli_graph.task_context_temporary_owner import temporary_task_owner


def fixture():
    context = {'personal_space_id': 'space-a', 'personal_project_id': 'project-a',
        'project_agent_id': 'temporary-agent', 'source_application': 'codex',
        'session_id': 'session-a', 'turn_id': 'turn-a', 'agent_memory_scope': 'task_only',
        'coordination_task_id': 'task-a'}
    agent = ProjectAgentRecord(agent_id='temporary-agent', personal_space_id='space-a',
        personal_project_id='project-a', temporary_task_id='task-a', memory_scope='task_only',
        profile=ProjectAgentProfile(name='Task reviewer', responsibility='Review one task.',
            agent_type='temporary', allowed_clients=['codex']),
        created_at=datetime.now(UTC), updated_at=datetime.now(UTC))
    calls = []

    async def current(*args):
        return context

    async def get_agent(*args):
        calls.append(args)
        return agent

    store = SimpleNamespace(current_task_context=current, get_project_agent=get_agent)
    request = ProjectAgentContextRequest(personal_space_id='space-a', personal_project_id='project-a',
        agent_id='temporary-agent', source_application='codex', session_id='session-a', turn_id='turn-a')
    return store, request, context, agent, calls


@pytest.mark.asyncio
async def test_bound_temporary_owner_restores_without_worker_or_long_term_memory_claim():
    store, request, _, _, calls = fixture()
    result = await temporary_task_owner(store, {}, request)
    assert result.status == 'ready'
    assert result.agent.memory_scope == 'task_only'
    assert result.worker_started is False
    assert len(calls) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize('field,value', [
    ('personal_project_id', 'other-project'), ('project_agent_id', 'other-agent'),
    ('turn_id', 'other-turn'), ('agent_memory_scope', 'reviewed_agent'),
])
async def test_other_scope_turn_or_owner_is_not_implicitly_reused(field, value):
    store, request, context, _, calls = fixture()
    context[field] = value
    assert await temporary_task_owner(store, {}, request) is None
    assert calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize('mismatch', ['task', 'client', 'status'])
async def test_bound_owner_still_requires_task_identity_active_status_and_client(mismatch):
    store, request, _, agent, _ = fixture()
    if mismatch == 'task':
        agent.temporary_task_id = 'another-task'
    elif mismatch == 'client':
        agent.profile.allowed_clients = ['cursor']
    else:
        agent.profile.status = 'archived'
    result = await temporary_task_owner(store, {}, request)
    assert result.status == 'agent_unavailable'
    assert result.agent is None
