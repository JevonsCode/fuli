from datetime import UTC, date, datetime
from types import SimpleNamespace

import pytest

from fuli_graph.project_agent_access import authorize_project_agent
from fuli_graph.project_agent_models import (
    ProjectAgentModelStrategy,
    ProjectAgentProfile,
)
from fuli_graph.project_agent_task_models import ProjectAgentTaskSubmit
from fuli_graph.store_project_agent_executor_routing import (
    StoreProjectAgentExecutorRouting,
)
from fuli_graph.store_project_agent_task_recruitment import (
    StoreProjectAgentTaskRecruitment,
)
from fuli_graph.store_project_agent_tasks import StoreProjectAgentTasks
from fuli_graph.store_project_agents import StoreProjectAgents


class RecordingDriver:
    def __init__(self):
        self.calls = []

    async def execute_query(self, query, **parameters):
        self.calls.append((query, parameters))
        return [], None, None


class SequentialDriver(RecordingDriver):
    def __init__(self, responses):
        super().__init__()
        self.responses = list(responses)

    async def execute_query(self, query, **parameters):
        self.calls.append((query, parameters))
        response = self.responses.pop(0) if self.responses else []
        return response, None, None


class DecisionStub:
    def __init__(self, task_id):
        self.decision_id = f'decision-{task_id}'
        self.task_id = task_id

    def model_dump(self, *, mode=None):
        return {
            'decision_id': self.decision_id,
            'task_id': self.task_id,
        }


def assert_query_contains(query, fragment):
    assert ''.join(fragment.split()) in ''.join(query.split())


def task_request(space_id):
    return ProjectAgentTaskSubmit(
        personal_space_id=space_id,
        personal_project_id='shared-project-id',
        idempotency_key=f'task-{space_id}',
        title='Verify space isolation',
        objective='Prove that duplicate business IDs remain in the current space.',
        work_kind='verification',
        required_capabilities=['test execution'],
        routing_reason='Cross-space regression coverage.',
    )


@pytest.mark.asyncio
async def test_task_persistence_with_duplicate_business_ids_stays_in_each_space():
    driver = RecordingDriver()
    store = StoreProjectAgentTasks()
    store.runtime = SimpleNamespace(driver=driver)
    store.settings = SimpleNamespace(provider_id='provider-1')
    created_at = datetime.now(UTC)

    for space_id in ('space-a', 'space-b'):
        request = task_request(space_id)
        task_id = f'task-{space_id}'
        await store._persist_task(
            request,
            task_id=task_id,
            payload_hash=f'payload-{space_id}',
            coordinator_agent_id='shared-coordinator-id',
            lead_agent_id='shared-agent-id',
            status='queued',
            routing_outcome='assigned_existing',
            routing_reason='exact_work_kind',
            routing_explanation='matched current-space assignment',
            match_basis=['exact work kind: verification'],
            complexity='simple',
            complexity_basis=['bounded task shape'],
            model_strategy=ProjectAgentModelStrategy(),
            model_source='agent',
            participants=[{
                'agent_id': 'shared-agent-id',
                'role': 'lead',
                'assignment_summary': 'Verify current-space work.',
            }],
            decision=DecisionStub(task_id),
            recruitment=SimpleNamespace(
                recruitment_id=f'recruitment-{space_id}'
            ),
            executor_decision=None,
            created_at=created_at,
        )

    assert len(driver.calls) == 6
    for offset, space_id in ((0, 'space-a'), (3, 'space-b')):
        create_query, create_parameters = driver.calls[offset]
        participant_query, participant_parameters = driver.calls[offset + 1]
        recruitment_query, recruitment_parameters = driver.calls[offset + 2]

        assert_query_contains(
            create_query,
            "MATCH (space:FuliSpace {id: $personal_space_id, kind: 'personal'}) "
            "MATCH (space)-[:CONTAINS_PROJECT]-> "
            "(project:FuliPersonalProject {project_id: $personal_project_id})",
        )
        assert_query_contains(
            create_query,
            "MATCH (space)-[:HAS_PROJECT_AGENT_IDENTITY]-> "
            "(coordinator:FuliProjectAgent {agent_id: $coordinator_agent_id})",
        )
        assert create_parameters['personal_space_id'] == space_id

        assert_query_contains(
            participant_query,
            "MATCH (space:FuliSpace { id: $personal_space_id, "
            "kind: 'personal' })-[:HAS_PROJECT_AGENT_TASK]-> "
            "(task:FuliProjectAgentTask {task_id: $task_id})",
        )
        assert_query_contains(
            participant_query,
            "MATCH (space)-[:HAS_PROJECT_AGENT_IDENTITY]-> "
            "(agent:FuliProjectAgent {agent_id: $agent_id})",
        )
        assert participant_parameters['personal_space_id'] == space_id

        assert_query_contains(
            recruitment_query,
            "MATCH (space:FuliSpace { id: $personal_space_id, "
            "kind: 'personal' })-[:HAS_PROJECT_AGENT_TASK]-> "
            "(task:FuliProjectAgentTask {task_id: $task_id})",
        )
        assert_query_contains(
            recruitment_query,
            "MATCH (space)-[:HAS_PROJECT_AGENT_RECRUITMENT]-> "
            "(recruitment:FuliProjectAgentRecruitment { "
            "recruitment_id: $recruitment_id })",
        )
        assert recruitment_parameters['personal_space_id'] == space_id


@pytest.mark.asyncio
async def test_recruitment_persistence_scopes_duplicate_project_and_hr_ids():
    driver = RecordingDriver()
    store = StoreProjectAgentTaskRecruitment()
    store.runtime = SimpleNamespace(driver=driver)

    for space_id in ('space-a', 'space-b'):
        await store._persist_recruitment({
            'id': f'recruitment-{space_id}',
            'personal_space_id': space_id,
            'personal_project_id': 'shared-project-id',
            'hr_agent_id': 'shared-hr-id',
        })

    assert len(driver.calls) == 2
    for (query, parameters), space_id in zip(
        driver.calls,
        ('space-a', 'space-b'),
        strict=True,
    ):
        assert_query_contains(
            query,
            "MATCH (space:FuliSpace {id: $personal_space_id, kind: 'personal'}) "
            "MATCH (space)-[:CONTAINS_PROJECT]-> "
            "(project:FuliPersonalProject {project_id: $personal_project_id})",
        )
        assert_query_contains(
            query,
            "OPTIONAL MATCH (space)-[:HAS_PROJECT_AGENT_IDENTITY]-> "
            "(hr:FuliProjectAgent {agent_id: $hr_agent_id})",
        )
        assert parameters['personal_space_id'] == space_id


def test_task_reads_start_from_the_current_space_task_edge():
    query = StoreProjectAgentTasks._task_read_query(
        'WHERE task.task_id = $task_id'
    )

    assert_query_contains(
        query,
        "MATCH (space:FuliSpace {id: $personal_space_id, kind: 'personal'})-"
        "[:HAS_PROJECT_AGENT_TASK]-> "
        "(task:FuliProjectAgentTask {personal_space_id: $personal_space_id})",
    )


@pytest.mark.asyncio
async def test_terminal_temporary_cleanup_only_ends_current_space_assignments():
    driver = RecordingDriver()
    store = StoreProjectAgentTasks()
    store.runtime = SimpleNamespace(driver=driver)

    await store._archive_finished_temporary_agent(
        SimpleNamespace(
            status='completed',
            task_id='shared-task-id',
            personal_space_id='space-a',
        ),
        {'personal_space_id': 'space-a'},
        datetime.now(UTC),
    )

    query, parameters = driver.calls[0]
    assert_query_contains(
        query,
        "MATCH (space:FuliSpace {id: $personal_space_id, kind: 'personal'})-"
        "[:HAS_PROJECT_AGENT_TASK]-> "
        "(task:FuliProjectAgentTask {task_id: $task_id})",
    )
    assert_query_contains(
        query,
        "MATCH (space)-[:CONTAINS_PROJECT]-> (:FuliPersonalProject)-"
        "[:HAS_PROJECT_AGENT_ASSIGNMENT]-> "
        "(assignment:FuliProjectAgentAssignment {status: 'active'})",
    )
    assert parameters['personal_space_id'] == 'space-a'


@pytest.mark.asyncio
async def test_agent_authorization_scopes_project_assignment_to_the_same_space():
    driver = SequentialDriver([
        [{'project': {'project_id': 'shared-project-id'}}],
        [{
            'agent': {'agent_id': 'shared-agent-id', 'status': 'active'},
            'assignment_id': 'assignment-a',
        }],
    ])
    store = SimpleNamespace(
        settings=SimpleNamespace(provider_mode='personal'),
        runtime=SimpleNamespace(driver=driver),
    )

    result = await authorize_project_agent(
        store,
        {'id': 'principal-a'},
        {'id': 'space-a', 'kind': 'personal'},
        'shared-project-id',
        'shared-agent-id',
    )

    assert result['agent_id'] == 'shared-agent-id'
    query, parameters = driver.calls[1]
    assert_query_contains(
        query,
        "MATCH (space:FuliSpace {id: $space_id, kind: 'personal'})-"
        "[:HAS_PROJECT_AGENT_IDENTITY]-> "
        "(agent:FuliProjectAgent {agent_id: $agent_id})",
    )
    assert_query_contains(
        query,
        "OPTIONAL MATCH (space)-[:CONTAINS_PROJECT]-> "
        "(:FuliPersonalProject {project_id: $project_id})-"
        "[:HAS_PROJECT_AGENT_ASSIGNMENT]->",
    )
    assert parameters['space_id'] == 'space-a'


@pytest.mark.asyncio
async def test_agent_directory_projects_tasks_and_events_are_space_anchored():
    driver = RecordingDriver()
    store = StoreProjectAgents()
    store.runtime = SimpleNamespace(driver=driver)

    await store._project_agent_rows(
        'space-a',
        personal_project_id='shared-project-id',
        agent_id='shared-agent-id',
        status=None,
        capability='verification',
    )

    query = driver.calls[0][0]
    assert_query_contains(
        query,
        "MATCH (space)-[:CONTAINS_PROJECT]-> "
        "(:FuliPersonalProject {project_id: $personal_project_id})-"
        "[:HAS_PROJECT_AGENT_ASSIGNMENT]->",
    )
    assert_query_contains(
        query,
        "OPTIONAL MATCH (space)-[:CONTAINS_PROJECT]-> "
        "(project:FuliPersonalProject)-[:HAS_PROJECT_AGENT_ASSIGNMENT]->",
    )
    assert_query_contains(
        query,
        "OPTIONAL MATCH (space)-[:HAS_PROJECT_AGENT_TASK]-> "
        "(task:FuliProjectAgentTask)-[participant:HAS_PARTICIPANT]->(agent)",
    )
    assert_query_contains(
        query,
        "OPTIONAL MATCH (space)-[:HAS_PROJECT_AGENT_TASK]-> "
        "(:FuliProjectAgentTask)-[:HAS_TASK_EVENT]-> "
        "(event:FuliProjectAgentTaskEvent)-[:EVENT_AGENT]->(agent)",
    )


class ExecutorSelectionStub:
    selection_id = 'selection-a'
    task_id = 'shared-task-id'
    personal_space_id = 'space-a'
    payload_fingerprint = 'payload-a'
    model_strategy_key = 'strategy-a'
    created_at = datetime.now(UTC)
    selected_executor_id = 'shared-executor-id'
    matched_rule_id = None
    status = 'selected'
    fallback_outcome = 'not_needed'
    blocked_reason = None
    selection_reason = 'current-space executor'
    fallback_reason = None

    def model_dump(self, *, mode=None):
        return {
            'selection_id': self.selection_id,
            'task_id': self.task_id,
            'personal_space_id': self.personal_space_id,
        }


@pytest.mark.asyncio
async def test_executor_selection_projects_only_to_the_current_space_task():
    driver = SequentialDriver([[{'decision': {'id': 'selection-a'}}]])
    store = StoreProjectAgentExecutorRouting()
    store.runtime = SimpleNamespace(driver=driver)

    await store._persist_executor_selection(ExecutorSelectionStub())

    query, parameters = driver.calls[0]
    assert 'decision.personal_space_id = $personal_space_id' in query
    assert_query_contains(
        query,
        "OPTIONAL MATCH (:FuliSpace {id: $personal_space_id, kind: 'personal'})-"
        "[:HAS_PROJECT_AGENT_TASK]->(task:FuliProjectAgentTask {"
        "personal_space_id: $personal_space_id, task_id: $task_id})",
    )
    assert parameters['personal_space_id'] == 'space-a'


class AuthorizedTaskStore(StoreProjectAgentTasks):
    def __init__(self, driver):
        self.runtime = SimpleNamespace(driver=driver)
        self.settings = SimpleNamespace(
            provider_id='provider-1',
            provider_mode='personal',
        )

    def _require_personal(self):
        return None

    async def authorize(self, actor, personal_space_id, role):
        return {'id': personal_space_id, 'kind': 'personal'}


@pytest.mark.asyncio
async def test_activity_heatmap_uses_current_space_task_and_event_path():
    driver = RecordingDriver()
    store = AuthorizedTaskStore(driver)

    result = await store.get_project_agent_activity(
        {'id': 'principal-a'},
        'space-a',
        'shared-agent-id',
        date(2026, 8, 1),
        date(2026, 8, 31),
    )

    assert result.days == []
    query = driver.calls[0][0]
    assert_query_contains(
        query,
        "MATCH (space:FuliSpace {id: $personal_space_id, kind: 'personal'})-"
        "[:HAS_PROJECT_AGENT_IDENTITY]->"
        "(agent:FuliProjectAgent {agent_id: $agent_id}) "
        "MATCH (space)-[:HAS_PROJECT_AGENT_TASK]->"
        "(task:FuliProjectAgentTask)-[:HAS_TASK_EVENT]->"
        "(event:FuliProjectAgentTaskEvent)-[:EVENT_AGENT]->(agent)",
    )


class RecruitmentActivationStore(AuthorizedTaskStore):
    async def _find_task_row(self, personal_space_id, task_id):
        return {
            'task': {
                'task_id': task_id,
                'personal_space_id': personal_space_id,
                'personal_project_id': 'shared-project-id',
                'work_kind': 'verification',
                'required_capabilities': ['test execution'],
                'complexity': 'simple',
                'complexity_basis': ['bounded task shape'],
            }
        }


@pytest.mark.asyncio
async def test_recruitment_task_transitions_and_recruited_agent_are_space_anchored():
    driver = RecordingDriver()
    store = RecruitmentActivationStore(driver)
    recruitment = {
        'recruitment_id': 'shared-recruitment-id',
        'personal_space_id': 'space-a',
        'personal_project_id': 'shared-project-id',
        'task_id': 'shared-task-id',
        'coordinator_agent_id': 'shared-coordinator-id',
        'reason_code': 'no_match',
    }

    await store._mark_recruitment_task_blocked(
        recruitment,
        'Recruitment cancelled.',
        datetime.now(UTC),
    )
    blocked_query = driver.calls[-1][0]
    assert_query_contains(
        blocked_query,
        "MATCH (space:FuliSpace {id: $personal_space_id, kind: 'personal'})-"
        "[:HAS_PROJECT_AGENT_TASK]->"
        "(task:FuliProjectAgentTask {task_id: $task_id}) "
        "MATCH (space)-[:HAS_PROJECT_AGENT_RECRUITMENT]->"
        "(recruitment:FuliProjectAgentRecruitment "
        "{recruitment_id: $recruitment_id})",
    )

    selected = {
        'agent_id': 'shared-agent-id',
        'responsibility': 'Verify project work.',
        'profile': ProjectAgentProfile(
            name='Verifier',
            responsibility='Verify project work.',
            work_kinds=['verification'],
            capabilities=['test execution'],
        ),
    }
    await store._activate_approved_recruitment(
        {'id': 'principal-a'},
        recruitment,
        selected,
        'Approved for the durable responsibility.',
    )
    approved_query = driver.calls[-1][0]
    assert_query_contains(
        approved_query,
        "MATCH (space:FuliSpace {id: $personal_space_id, kind: 'personal'})-"
        "[:HAS_PROJECT_AGENT_TASK]->"
        "(task:FuliProjectAgentTask {task_id: $task_id}) "
        "MATCH (space)-[:HAS_PROJECT_AGENT_IDENTITY]->"
        "(agent:FuliProjectAgent {agent_id: $agent_id})",
    )


class RecruitmentProvisionStore(StoreProjectAgentTaskRecruitment):
    def __init__(self, driver):
        self.runtime = SimpleNamespace(driver=driver)

    async def upsert_project_agent(self, actor, request, **kwargs):
        return None

    async def create_project_agent_assignment(self, actor, request):
        return None

    async def _assignment_candidates(self, *args, **kwargs):
        return [{'agent_id': 'shared-agent-id'}]


@pytest.mark.asyncio
async def test_recruitment_fulfillment_links_only_the_current_space_agent():
    driver = RecordingDriver()
    store = RecruitmentProvisionStore(driver)
    profile = ProjectAgentProfile(
        name='Verifier',
        responsibility='Verify project work.',
        work_kinds=['verification'],
        capabilities=['test execution'],
    )

    selected = await store._provision_recruitment(
        {'id': 'principal-a'},
        {
            'recruitment_id': 'shared-recruitment-id',
            'personal_space_id': 'space-a',
            'personal_project_id': 'shared-project-id',
            'proposed_agent_id': 'shared-agent-id',
            'proposed_profile_json': profile.model_dump_json(),
            'work_kind': 'verification',
            'reason': 'Fill a durable responsibility gap.',
        },
    )

    assert selected['agent_id'] == 'shared-agent-id'
    query, parameters = driver.calls[0]
    assert_query_contains(
        query,
        "MATCH (space:FuliSpace {id: $personal_space_id, kind: 'personal'})-"
        "[:HAS_PROJECT_AGENT_RECRUITMENT]->"
        "(recruitment:FuliProjectAgentRecruitment "
        "{recruitment_id: $recruitment_id}) "
        "MATCH (space)-[:HAS_PROJECT_AGENT_IDENTITY]->"
        "(agent:FuliProjectAgent {agent_id: $agent_id})",
    )
    assert parameters['personal_space_id'] == 'space-a'
