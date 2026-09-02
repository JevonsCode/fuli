from contextlib import asynccontextmanager
from datetime import UTC, date, datetime
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

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
        self.activation_stale = False
        self.activation_failures_remaining = 0

    @asynccontextmanager
    async def transaction(self):
        yield self

    async def run(self, query, **parameters):
        records, _, _ = await self.execute_query(query, **parameters)

        async def result():
            for record in records:
                yield record
        return result()

    async def execute_query(self, query, **parameters):
        self.calls.append((query, parameters))
        if 'RETURN true AS payload_matches' in query:
            return ([{
                'payload_matches': True,
                'participant_plan_json': parameters['participant_plan_json'],
                'recruitment_plan_json': parameters['recruitment_plan_json'],
                'persisted_status': parameters['status'],
                'persisted_created_at': parameters['created_at'],
            }], None, None)
        if 'AS linked_count' in query:
            return ([{'linked_count': 1}], None, None)
        if (
            "WHERE recruitment.status = 'requested'" in query
            and 'RETURN recruitment' in query
        ):
            return ([{'recruitment': {}}], None, None)
        if (
            'RETURN task' in query
            and '$expected_task_revision' in query
        ):
            if self.activation_failures_remaining:
                self.activation_failures_remaining -= 1
                return [], None, None
            if self.activation_stale:
                return [], None, None
            return ([{'task': {}}], None, None)
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
        request = task_request(space_id).model_copy(
            update={'executor_capability_hints': ['testing']}
        )
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
        assert_query_contains(
            create_query,
            "MERGE (task:FuliProjectAgentTask {id: $task_id})",
        )
        assert_query_contains(
            create_query,
            "WHERE task.payload_hash = $payload_hash",
        )
        assert create_parameters['personal_space_id'] == space_id
        assert create_parameters['required_capabilities'] == [
            'test execution'
        ]
        assert create_parameters['executor_capability_hints'] == ['testing']

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
async def test_task_replay_repairs_edges_from_the_persisted_link_plan():
    created_at = datetime.now(UTC)
    driver = SequentialDriver([
        [{'task': {'status': 'queued', 'created_at': created_at}}],
        [{'linked_count': 1}],
        [{'linked_count': 1}],
    ])
    store = StoreProjectAgentTasks()
    store.runtime = SimpleNamespace(driver=driver)
    request = task_request('space-a')

    await store._repair_task_persistence(
        request,
        {
            'task_id': 'task-repair',
            'status': 'queued',
            'created_at': created_at,
            'participant_plan_json': (
                '[{"agent_id":"agent-a","role":"lead",'
                '"assignment_summary":"Verify work."}]'
            ),
            'recruitment_plan_json': (
                '[{"recruitment_id":"recruitment-a",'
                '"is_primary":true}]'
            ),
        },
    )

    assert len(driver.calls) == 3
    participant_query, participant_parameters = driver.calls[1]
    recruitment_query, recruitment_parameters = driver.calls[2]
    assert 'MERGE (task)-[participant:HAS_PARTICIPANT]->(agent)' in participant_query
    assert 'agent._task_lifecycle_lock' in participant_query
    assert "agent.status = 'active'" in participant_query
    assert "$status IN ['completed', 'failed', 'cancelled']" in participant_query
    assert participant_parameters['agent_id'] == 'agent-a'
    assert 'MERGE (task)-[:TRIGGERED_RECRUITMENT]->(recruitment)' in recruitment_query
    assert recruitment_parameters['recruitment_id'] == 'recruitment-a'
    assert recruitment_parameters['is_primary'] is True


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


@pytest.mark.asyncio
async def test_recovery_claim_locks_the_awaiting_task_revision():
    driver = RecordingDriver()
    store = StoreProjectAgentTaskRecruitment()
    store.runtime = SimpleNamespace(driver=driver)

    await store._claim_requested_recruitment(
        SimpleNamespace(
            personal_space_id='space-a',
            personal_project_id='shared-project-id',
        ),
        'recruitment-a',
        task_id='task-a',
        expected_task_revision=7,
    )

    query, parameters = driver.calls[0]
    assert_query_contains(
        query,
        "task.status = 'awaiting_recruitment' AND "
        'coalesce(task.revision, 0) = $expected_task_revision',
    )
    assert 'task.recruitment_provisioning_claim_id =' in query
    assert 'task.revision = coalesce(task.revision, 0) + 1' in query
    assert parameters['task_id'] == 'task-a'
    assert parameters['expected_task_revision'] == 7


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
    assert 'agent._task_lifecycle_lock' in query
    assert query.index('agent._task_lifecycle_lock') < query.index(
        "SET agent.status = 'archived'"
    )
    assert 'agent.archive_reason = coalesce(' in query
    assert 'agent.archived_at = coalesce(' in query
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
        "(event_task:FuliProjectAgentTask)-[:HAS_TASK_EVENT]-> "
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


@pytest.mark.asyncio
async def test_activity_heatmap_carries_forward_latest_worker_evidence():
    earlier = datetime(2026, 8, 20, 9, 0, tzinfo=UTC)
    terminal = datetime(2026, 8, 20, 9, 5, tzinfo=UTC)
    evidence_url = 'codex://threads/01234567-89ab-cdef-0123-456789abcdef'
    terminal_event = {
        'event_id': 'event-terminal',
        'task_id': 'task-a',
        'status': 'completed',
        'summary': 'Task completed.',
        'created_at': terminal,
    }
    driver = SequentialDriver([[{
        'event': terminal_event,
        'title': 'Evidence task',
        'evidence_events': [
            {
                'event_id': 'event-worker',
                'task_id': 'task-a',
                'status': 'running',
                'summary': 'Worker verified the slice.',
                'created_at': earlier,
                'source_session_url': evidence_url,
                'tools_used': ['pytest', 'rg'],
                'worker_id': 'worker-a',
                'worker_status': 'completed',
                'worker_runtime_json': '{"application":"claude_code","session_id":"worker-session"}',
            },
            terminal_event,
        ],
    }]])
    store = AuthorizedTaskStore(driver)

    result = await store.get_project_agent_activity(
        {'id': 'principal-a'},
        'space-a',
        'shared-agent-id',
        date(2026, 8, 1),
        date(2026, 8, 31),
    )

    activity = result.days[0].tasks[0]
    assert activity.source_session_url == evidence_url
    assert activity.tools_used == ['pytest', 'rg']
    assert activity.worker_id == 'worker-a'
    assert activity.worker_runtime.application == 'claude_code'
    assert activity.worker_runtime.session_id == 'worker-session'
    assert activity.worker_runtime.session_url is None
    assert 'collect(evidence_event) AS evidence_events' in driver.calls[0][0]


class RecruitmentActivationStore(AuthorizedTaskStore):
    async def _find_task_row(self, personal_space_id, task_id):
        return {
            'task': {
                'task_id': task_id,
                'personal_space_id': personal_space_id,
                'personal_project_id': 'shared-project-id',
                'work_kind': 'verification',
                'required_capabilities': ['test execution'],
                'executor_capability_hints': ['testing'],
                'complexity': 'simple',
                'complexity_basis': ['bounded task shape'],
                'status': 'awaiting_recruitment',
                'revision': 0,
            }
        }

    async def resolve_project_agent_executor(self, actor, **values):
        self.resolved_executor_values = values
        return None


class MultiRecruitmentActivationStore(RecruitmentActivationStore):
    def __init__(self, driver, task_recruitments, *, lead=None):
        super().__init__(driver)
        self.recruitment_records = task_recruitments
        self.lead = lead

    async def _find_task_row(self, personal_space_id, task_id):
        row = await super()._find_task_row(personal_space_id, task_id)
        if self.lead:
            row['task']['lead_agent_id'] = self.lead['agent_id']
        return row

    async def _task_recruitments(self, personal_space_id, task_id):
        return self.recruitment_records

    async def _assignment_candidates(self, *args, **kwargs):
        return [self.lead] if self.lead else []


@pytest.mark.asyncio
async def test_approved_recruitment_transition_is_space_anchored_and_cas_guarded():
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
    link_query = next(
        query
        for query, _ in driver.calls
        if 'TRIGGERED_RECRUITMENT' in query
        and 'HAS_PARTICIPANT' in query
    )
    assert 'agent._task_lifecycle_lock' in link_query
    assert 'task._task_lifecycle_lock' in link_query
    assert link_query.index(
        'task._task_lifecycle_lock'
    ) < link_query.index('agent._task_lifecycle_lock')
    assert "WHERE agent.status = 'active'" in link_query
    assert 'agent._task_lifecycle_lock' in approved_query
    assert 'task._task_lifecycle_lock' in approved_query
    assert approved_query.index(
        'task._task_lifecycle_lock'
    ) < approved_query.index('lifecycle_agent._task_lifecycle_lock')
    assert 'ORDER BY lifecycle_agent.agent_id' in approved_query
    assert approved_query.index(
        'ORDER BY lifecycle_agent.agent_id'
    ) < approved_query.index('lifecycle_agent._task_lifecycle_lock')
    assert "locked_agent.status = 'active'" in approved_query
    assert_query_contains(
        approved_query,
        "MATCH (space:FuliSpace {id: $personal_space_id, kind: 'personal'})-"
        "[:HAS_PROJECT_AGENT_TASK]->"
        "(task:FuliProjectAgentTask {task_id: $task_id})",
    )
    assert_query_contains(
        approved_query,
        "MATCH (space)-[:HAS_PROJECT_AGENT_IDENTITY]->"
        "(agent:FuliProjectAgent {agent_id: $agent_id})",
    )
    assert_query_contains(
        approved_query,
        "AND coalesce(task.revision, 0) = $expected_task_revision",
    )
    assert driver.calls[-1][1]['expected_task_revision'] == 0
    assert store.resolved_executor_values['required_capabilities'] == [
        'testing'
    ]


@pytest.mark.asyncio
async def test_ready_recruitment_locks_task_then_agent_before_active_assignment_read():
    driver = RecordingDriver()
    store = StoreProjectAgentTaskRecruitment()
    store.runtime = SimpleNamespace(driver=driver)

    result = await store._finalize_ready_recruitment(
        SimpleNamespace(
            personal_space_id='space-a',
            personal_project_id='shared-project-id',
        ),
        'shared-recruitment-id',
        task_id='shared-task-id',
        expected_task_revision=0,
    )

    assert result is None
    query = driver.calls[-1][0]
    assert 'task._task_lifecycle_lock' in query
    assert 'agent._task_lifecycle_lock' in query
    assert query.index(
        'task._task_lifecycle_lock'
    ) < query.index('agent._task_lifecycle_lock')
    assert query.index(
        'agent._task_lifecycle_lock'
    ) < query.index("WHERE agent.status = 'active'")
    assert query.index(
        "WHERE agent.status = 'active'"
    ) < query.index("FuliProjectAgentAssignment {status: 'active'}")


@pytest.mark.asyncio
async def test_approved_recruitment_does_not_overwrite_a_changed_task():
    driver = RecordingDriver()
    driver.activation_stale = True
    store = RecruitmentActivationStore(driver)
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

    with pytest.raises(HTTPException, match='changed before activation'):
        await store._activate_approved_recruitment(
            {'id': 'principal-a'},
            {
                'recruitment_id': 'recruitment-a',
                'personal_space_id': 'space-a',
                'personal_project_id': 'shared-project-id',
                'task_id': 'shared-task-id',
                'coordinator_agent_id': 'shared-coordinator-id',
                'reason_code': 'no_match',
            },
            selected,
            'Approved after task state changed.',
        )


@pytest.mark.asyncio
async def test_approved_recruitment_retries_a_transient_task_revision_race():
    driver = RecordingDriver()
    driver.activation_failures_remaining = 1
    store = RecruitmentActivationStore(driver)
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
        {
            'recruitment_id': 'recruitment-a',
            'personal_space_id': 'space-a',
            'personal_project_id': 'shared-project-id',
            'task_id': 'shared-task-id',
            'coordinator_agent_id': 'shared-coordinator-id',
            'reason_code': 'no_match',
        },
        selected,
        'Approved while task metadata changed once.',
    )

    activation_calls = [
        (query, parameters)
        for query, parameters in driver.calls
        if '$expected_task_revision' in query and 'RETURN task' in query
    ]
    assert len(activation_calls) == 2
    assert driver.activation_failures_remaining == 0


@pytest.mark.asyncio
async def test_partial_parallel_approval_keeps_task_waiting():
    driver = RecordingDriver()
    store = MultiRecruitmentActivationStore(
        driver,
        [
            SimpleNamespace(status='fulfilled'),
            SimpleNamespace(status='awaiting_confirmation'),
        ],
    )
    selected = {
        'agent_id': 'new-lead',
        'responsibility': 'Lead the work.',
        'profile': ProjectAgentProfile(
            name='Lead',
            responsibility='Lead the work.',
        ),
    }

    await store._activate_approved_recruitment(
        {'id': 'principal-a'},
        {
            'recruitment_id': 'lead-recruitment',
            'personal_space_id': 'space-a',
            'personal_project_id': 'shared-project-id',
            'task_id': 'shared-task-id',
            'coordinator_agent_id': 'shared-coordinator-id',
            'reason_code': 'no_match',
            'participant_role': 'lead',
        },
        selected,
        'Approved the lead slot first.',
    )

    assert any('TRIGGERED_RECRUITMENT' in query for query, _ in driver.calls)
    assert not any(
        '$expected_task_revision' in query for query, _ in driver.calls
    )


@pytest.mark.asyncio
async def test_collaborator_approval_preserves_the_existing_lead():
    driver = RecordingDriver()
    lead = {
        'agent_id': 'existing-lead',
        'assignment_id': 'lead-assignment',
        'responsibility': 'Lead the work.',
        'profile': ProjectAgentProfile(
            name='Existing Lead',
            responsibility='Lead the work.',
        ),
    }
    store = MultiRecruitmentActivationStore(
        driver,
        [SimpleNamespace(status='fulfilled')],
        lead=lead,
    )
    collaborator = {
        'agent_id': 'new-collaborator',
        'responsibility': 'Review the work.',
        'profile': ProjectAgentProfile(
            name='Reviewer',
            responsibility='Review the work.',
        ),
    }

    await store._activate_approved_recruitment(
        {'id': 'principal-a'},
        {
            'recruitment_id': 'collaborator-recruitment',
            'personal_space_id': 'space-a',
            'personal_project_id': 'shared-project-id',
            'task_id': 'shared-task-id',
            'coordinator_agent_id': 'shared-coordinator-id',
            'reason_code': 'no_match',
            'participant_role': 'collaborator',
        },
        collaborator,
        'Approved the collaborator slot.',
    )

    link_parameters = next(
        parameters
        for query, parameters in driver.calls
        if 'TRIGGERED_RECRUITMENT' in query
    )
    activation_parameters = next(
        parameters
        for query, parameters in driver.calls
        if '$expected_task_revision' in query
    )
    assert link_parameters['agent_id'] == 'new-collaborator'
    assert activation_parameters['agent_id'] == 'existing-lead'


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
            'provisioning_claim_id': 'claim-a',
            'work_kind': 'verification',
            'reason': 'Fill a durable responsibility gap.',
        },
    )

    assert selected['agent_id'] == 'shared-agent-id'
    claim_query, claim_parameters = driver.calls[0]
    assert_query_contains(
        claim_query,
        "MATCH (:FuliSpace {id: $personal_space_id, kind: 'personal'})-"
        "[:HAS_PROJECT_AGENT_RECRUITMENT]->"
        "(recruitment:FuliProjectAgentRecruitment "
        "{recruitment_id: $recruitment_id})",
    )
    assert claim_parameters['personal_space_id'] == 'space-a'
    assert claim_parameters['provisioning_claim_id'] == 'claim-a'
    query, parameters = next(
        (query, parameters)
        for query, parameters in driver.calls
        if "SET recruitment.status = 'fulfilled'" in query
    )
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
    assert parameters['provisioning_claim_id'] == 'claim-a'
