from datetime import UTC, datetime
from types import SimpleNamespace

import pytest

from fuli_graph.project_agent_context_models import ProjectAgentContextRequest
from fuli_graph.project_agent_models import ProjectAgentProfile, ProjectAgentRecord
from fuli_graph.project_agent_task_models import ProjectAgentTaskSubmit
from fuli_graph.store_project_agent_context import StoreProjectAgentContext
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


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ('work_kind', 'history'),
    [
        ('implementation', False),
        ('implementation', True),
        ('project_context', False),
    ],
)
async def test_management_peer_is_not_implicit_owner_of_unrelated_work(work_kind, history):
    peer = peer_assignment('employee.jefa')
    store = StaffingStore(SelectionDriver([peer], history=history))
    request = task_request().model_copy(
        update={'work_kind': work_kind, 'required_capabilities': []},
    )

    selected, _, reason, _ = await store._select_agents(
        {'id': 'principal'},
        {'id': 'personal-space'},
        request,
    )

    assert selected == []
    assert reason == 'no_match'


def test_assignment_peer_capability_marker_is_detected_without_profile():
    row = {
        'agent_id': 'assignment-only-peer',
        'work_kinds': ['project_management'],
        'capabilities': ['fuli.employee:jefa'],
    }
    request = task_request().model_copy(update={
        'work_kind': 'implementation',
        'required_capabilities': [],
    })

    assert StaffingStore._is_implicit_peer(row)
    assert not StaffingStore._implicit_owner_allowed(row, request)


@pytest.mark.asyncio
async def test_context_project_fallback_skips_management_peer_and_keeps_durable_candidates():
    assignments = [
        peer_assignment('employee.jefa'),
        peer_assignment('developer-a', work_kinds=['implementation'], capabilities=['coding']),
        peer_assignment('developer-b', work_kinds=['implementation'], capabilities=['coding']),
    ]
    store = ContextStaffingStore(SelectionDriver(assignments))
    request = ProjectAgentContextRequest(
        personal_space_id='personal-space',
        personal_project_id='project-a',
        work_kind='architecture',
        source_application='codex',
    )

    result = await store.resolve_project_agent_context({'id': 'principal'}, request)

    assert result.status == 'ready'
    assert result.agent.agent_id == 'developer-a'
    assert result.reason == 'project_context_fallback'


@pytest.mark.asyncio
async def test_context_session_peer_owner_does_not_override_unrelated_work():
    assignments = [
        peer_assignment('employee.jefa'),
        peer_assignment('developer-a', work_kinds=['implementation'], capabilities=['coding']),
        peer_assignment('developer-b', work_kinds=['implementation'], capabilities=['coding']),
    ]
    store = ContextStaffingStore(
        SelectionDriver(assignments, session_owner='employee.jefa'),
    )
    request = ProjectAgentContextRequest(
        personal_space_id='personal-space',
        personal_project_id='project-a',
        session_id='session-jefa',
        turn_id='turn-one',
        work_kind='architecture',
        source_application='codex',
    )

    result = await store.resolve_project_agent_context({'id': 'principal'}, request)

    assert result.status == 'ready'
    assert result.agent.agent_id == 'developer-a'
    assert result.reason == 'project_context_fallback'


@pytest.mark.asyncio
async def test_explicit_management_peer_selection_remains_authoritative():
    peer = peer_assignment('employee.jefa')
    store = StaffingStore(SelectionDriver([peer]))
    request = task_request().model_copy(update={
        'lead_agent_id': 'employee.jefa',
        'required_capabilities': ['unrelated-capability'],
    })

    selected, _, reason, _ = await store._select_agents(
        {'id': 'principal'},
        {'id': 'personal-space', 'kind': 'personal'},
        request,
    )

    assert selected[0]['agent_id'] == 'employee.jefa'
    assert reason == 'explicit_agent'


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ('agent_id', 'work_kinds', 'capabilities', 'work_kind', 'required_capabilities'),
    [
        ('employee.jefa', ['project_management'], ['fuli.employee:jefa'],
         'project_management', []),
        ('employee.bole', ['staffing-review'], ['fuli.employee:bole'],
         'staffing-review', []),
        ('hr-peer', ['staffing-review'], ['staffing'],
         'implementation', ['staffing']),
    ],
)
async def test_management_peer_remains_eligible_for_its_matched_role(
    agent_id, work_kinds, capabilities, work_kind, required_capabilities,
):
    store = StaffingStore(SelectionDriver([
        peer_assignment(
            agent_id,
            work_kinds=work_kinds,
            capabilities=capabilities,
            agent_type='hr' if agent_id == 'hr-peer' else 'durable',
        ),
    ]))
    request = task_request().model_copy(update={
        'work_kind': work_kind,
        'required_capabilities': required_capabilities,
    })

    selected, _, reason, _ = await store._select_agents(
        {'id': 'principal'},
        {'id': 'personal-space'},
        request,
    )

    assert selected[0]['agent_id'] == agent_id
    assert reason in {'exact_work_kind', 'exact_capability'}


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


class ContextStaffingStore(StoreProjectAgentContext, StaffingStore):
    def _require_personal(self):
        return None

    async def authorize(self, actor, personal_space_id, role):
        return {'id': personal_space_id, 'kind': 'personal'}

    @staticmethod
    def _task_session_id(personal_space_id, source_application, session_id):
        return session_id

    async def get_project_agent(self, actor, personal_space_id, personal_project_id, agent_id):
        profile = self.runtime.driver.profiles[agent_id]
        timestamp = datetime(2026, 8, 30, tzinfo=UTC)
        return ProjectAgentRecord(
            agent_id=agent_id,
            personal_space_id=personal_space_id,
            personal_project_id=personal_project_id,
            profile=profile,
            created_at=timestamp,
            updated_at=timestamp,
        )


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


class SelectionDriver:
    def __init__(self, assignments, *, history=False, session_owner=None):
        self.assignments = assignments
        self.history = history
        self.session_owner = session_owner
        self.profiles = {
            row['agent_id']: row['profile'] for row in assignments
        }

    async def execute_query(self, query, **parameters):
        if 'RETURN context.project_agent_id AS agent_id' in query:
            return ([{'agent_id': self.session_owner}] if self.session_owner else []), None, None
        if 'RETURN assignment, agent, memory_revision' in query:
            return [
                {
                    'assignment': row['assignment'],
                    'agent': row['agent'],
                    'memory_revision': 0,
                    'active_task_count': 0,
                }
                for row in self.assignments
            ], None, None
        if 'RETURN project' in query:
            return [{'project': {'project_id': parameters['project_id']}}], None, None
        if 'RETURN agent, head(assignment_ids) AS assignment_id' in query:
            row = next(
                (item for item in self.assignments
                 if item['agent_id'] == parameters['agent_id']),
                None,
            )
            return ([{
                'agent': row['agent'],
                'assignment_id': row['assignment']['assignment_id'],
            }] if row else []), None, None
        if 'FuliProjectAgentTask' in query and self.history:
            return [{
                'agent_id': 'employee.jefa',
                'participation_count': 1,
                'completed_count': 1,
                'failed_count': 0,
                'cancelled_count': 0,
                'last_task_at': '2026-08-30T10:00:00Z',
                'last_completed_at': '2026-08-30T10:00:00Z',
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


def peer_assignment(agent_id, *, work_kinds=None, capabilities=None, agent_type='durable'):
    profile = ProjectAgentProfile(
        name=agent_id,
        responsibility='Manage the synthetic project role.',
        agent_type=agent_type,
        work_kinds=work_kinds or ['project_management'],
        capabilities=capabilities or ['fuli.employee:jefa'],
        allowed_clients=['codex'],
    )
    if agent_id == 'employee.bole':
        profile = profile.model_copy(update={
            'name': 'Bole',
            'agent_type': 'hr',
            'work_kinds': work_kinds or ['staffing-review'],
            'capabilities': capabilities or ['fuli.employee:bole'],
        })
    timestamp = datetime(
        2026, 8, 30, 0, 0, 0 if agent_id == 'employee.jefa' else 1, tzinfo=UTC,
    )
    return {
        'agent_id': agent_id,
        'profile': profile,
        'agent': {
            'id': f'node-{agent_id}',
            'agent_id': agent_id,
            'profile_json': profile.model_dump_json(),
            'status': 'active',
            'created_at': timestamp,
            'updated_at': timestamp,
        },
        'assignment': {
            'id': f'assignment-{agent_id}',
            'assignment_id': f'assignment-{agent_id}',
            'responsibility': 'Manage the synthetic project role.',
            'work_kinds': list(profile.work_kinds),
            'capabilities': list(profile.capabilities),
            'status': 'active',
            'revision': 0,
            'assigned_at': timestamp,
            'updated_at': timestamp,
        },
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
