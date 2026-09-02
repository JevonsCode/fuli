from datetime import UTC, datetime
from types import SimpleNamespace

import pytest

from fuli_graph.project_agent_models import ProjectAgentProfile
from fuli_graph.project_agent_task_models import ProjectAgentTaskSubmit
from fuli_graph.store_project_agent_tasks import StoreProjectAgentTasks


@pytest.mark.asyncio
async def test_project_b_load_does_not_change_project_a_agent_selection():
    driver = SharedProjectLoadDriver()
    store = StaffingStore(driver)

    selected, _, _, _ = await store._select_agents(
        {'id': 'principal'},
        {'id': 'personal-space'},
        task_request(),
    )

    assert selected[0]['agent_id'] == 'shared-agent'
    assignment_query = driver.assignment_query
    assert 'active_task.personal_project_id = $personal_project_id' in assignment_query
    assert (
        'personal_project_id: $personal_project_id,\n'
        '                    project_agent_id: agent.agent_id'
        in assignment_query
    )


@pytest.mark.asyncio
async def test_terminal_participant_history_counts_without_terminal_agent_event():
    driver = MissingEventHistoryDriver()
    store = StaffingStore(driver)

    history = await store._historical_agent_outcomes(
        'personal-space',
        'project-a',
        'implementation',
        ['shared-agent'],
    )

    assert history == {
        'shared-agent': {
            'participation_count': 1,
            'completed_count': 1,
            'failed_count': 0,
            'cancelled_count': 0,
            'last_outcome_at': '2026-08-30T10:00:00Z',
        },
    }
    query = driver.history_query
    assert 'count(DISTINCT CASE' in query
    assert "participant.status IN\n                       ['completed', 'failed', 'cancelled']" in query
    assert 'THEN task.task_id END' in query
    assert 'THEN coalesce(event.created_at, task.updated_at) END' in query


def task_request():
    return ProjectAgentTaskSubmit(
        personal_space_id='personal-space',
        personal_project_id='project-a',
        idempotency_key='staffing-isolation-test',
        title='Synthetic staffing isolation',
        objective='Verify project-specific load selection.',
        work_kind='implementation',
        required_capabilities=['coding'],
        source_application='codex',
        routing_reason='Synthetic staffing regression.',
    )


class StaffingStore(StoreProjectAgentTasks):
    def __init__(self, driver):
        self.runtime = SimpleNamespace(driver=driver)
        self.settings = SimpleNamespace(provider_id='provider', provider_mode='personal')

    async def get_project_agent_coordination_policy(
        self, actor, personal_space_id, personal_project_id
    ):
        return SimpleNamespace(auto_reuse_previous_agent=True)


class SharedProjectLoadDriver:
    def __init__(self):
        self.assignment_query = None

    async def execute_query(self, query, **parameters):
        if 'RETURN assignment, agent, memory_revision' in query:
            self.assignment_query = query
            scoped = (
                'active_task.personal_project_id = $personal_project_id' in query
                and (
                    'personal_project_id: $personal_project_id,\n'
                    '                    project_agent_id: agent.agent_id'
                ) in query
            )
            return [
                {
                    'assignment': raw_assignment('shared-agent'),
                    'agent': raw_agent('shared-agent'),
                    'memory_revision': 0,
                    'active_task_count': 0 if scoped else 2,
                },
                {
                    'assignment': raw_assignment('a-only-agent'),
                    'agent': raw_agent('a-only-agent'),
                    'memory_revision': 0,
                    'active_task_count': 0,
                },
            ], None, None
        return [], None, None


class MissingEventHistoryDriver:
    def __init__(self):
        self.history_query = None

    async def execute_query(self, query, **parameters):
        if 'FuliProjectAgentTaskEvent' in query:
            self.history_query = query
            if 'WHERE event.status IN' in query:
                return [], None, None
            return [{
                'agent_id': 'shared-agent',
                'participation_count': 1,
                'completed_count': 1,
                'failed_count': 0,
                'cancelled_count': 0,
                'last_outcome_at': '2026-08-30T10:00:00Z',
            }], None, None
        return [], None, None


def raw_agent(agent_id):
    profile = ProjectAgentProfile(
        name=agent_id,
        responsibility='Maintain the synthetic project.',
        work_kinds=['implementation'],
        capabilities=['coding'],
        allowed_clients=['codex'],
    )
    timestamp = datetime(2026, 8, 30, tzinfo=UTC)
    return {
        'id': f'node-{agent_id}',
        'agent_id': agent_id,
        'profile_json': profile.model_dump_json(),
        'status': 'active',
        'created_at': timestamp,
        'updated_at': timestamp,
    }


def raw_assignment(agent_id):
    timestamp = datetime(2026, 8, 30, 0, 0, 29 if agent_id == 'shared-agent' else 30, tzinfo=UTC)
    return {
        'id': f'assignment-{agent_id}',
        'assignment_id': f'assignment-{agent_id}',
        'responsibility': 'Maintain the synthetic project.',
        'work_kinds': ['implementation'],
        'capabilities': ['coding'],
        'status': 'active',
        'revision': 0,
        'assigned_at': timestamp,
        'updated_at': timestamp,
    }
