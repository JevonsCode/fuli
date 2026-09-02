from contextlib import asynccontextmanager
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from fuli_graph.project_agent_models import (
    ProjectAgentExecutorPolicy,
    ProjectAgentModelStrategy,
    ProjectAgentProfile,
    ProjectAgentRecord,
)
from fuli_graph.project_agent_task_models import (
    ProjectAgentParallelPlan,
    ProjectAgentRoutingDecisionRecord,
    ProjectAgentTaskActivityCreate,
    ProjectAgentTaskRecord,
    ProjectAgentTaskSubmit,
    ProjectAgentTokenUsage,
)
from fuli_graph.provider_values import stable_uuid
from fuli_graph.store_project_agent_tasks import StoreProjectAgentTasks


def task_request(**updates):
    values = {
        'personal_space_id': 'personal-space',
        'personal_project_id': 'project-a',
        'idempotency_key': 'task-idempotency-1',
        'title': 'Verify activity export',
        'objective': 'Run the project verification and report the real result.',
        'work_kind': 'verification',
        'required_capabilities': ['test execution'],
        'routing_reason': 'The project requires a verified result.',
    }
    values.update(updates)
    return ProjectAgentTaskSubmit(**values)


@pytest.mark.asyncio
async def test_existing_exact_assignment_is_reused_before_recruitment():
    store = SelectionStore([
        candidate('agent-b', ['design'], ['test execution']),
        candidate('agent-a', ['verification'], ['test execution']),
    ])

    selected, candidates, reason, basis = await store._select_agents(
        {'id': 'principal'},
        {'id': 'personal-space'},
        task_request(),
    )

    assert selected[0]['agent_id'] == 'agent-a'
    assert reason == 'exact_work_kind'
    assert [item['agent_id'] for item in candidates] == ['agent-a', 'agent-b']
    assert basis == ['exact work kind: verification',
                     'selected active task count: 0; work-kind fit and load precede history']


@pytest.mark.asyncio
async def test_historical_project_work_kind_continuity_breaks_static_tie():
    store = HistorySelectionStore([
        candidate('agent-a', ['verification'], ['test execution']),
        candidate('agent-b', ['verification'], ['test execution']),
    ], {
        'agent-b': {
            'participation_count': 2,
            'completed_count': 2,
            'failed_count': 0,
            'cancelled_count': 0,
        },
    })

    selected, candidates, reason, basis = await store._select_agents(
        {'id': 'principal'},
        {'id': 'personal-space'},
        task_request(),
    )

    assert selected[0]['agent_id'] == 'agent-b'
    assert [item['agent_id'] for item in candidates] == ['agent-b', 'agent-a']
    assert reason == 'exact_work_kind'
    assert basis[0] == 'exact work kind: verification'
    assert basis[1].startswith('historical continuity for verification:')
    assert store.history_context[:3] == (
        'personal-space',
        'project-a',
        'verification',
    )


@pytest.mark.asyncio
async def test_project_continuity_cannot_override_required_capabilities():
    store = HistorySelectionStore([
        candidate('agent-a', ['past-hotel-work'], ['legacy planning']),
        candidate('agent-b', ['hotel-requirement'], ['hotel planning']),
    ], {}, project_history={
        'agent-a': {
            'participation_count': 2,
            'completed_count': 2,
            'failed_count': 0,
            'cancelled_count': 0,
            'last_completed_at': '2026-08-23T10:00:00Z',
            'last_task_at': '2026-08-23T10:00:00Z',
        },
        'agent-b': {
            'participation_count': 1,
            'completed_count': 1,
            'failed_count': 0,
            'cancelled_count': 0,
            'last_completed_at': '2026-08-20T10:00:00Z',
            'last_task_at': '2026-08-20T10:00:00Z',
        },
    })

    selected, candidates, reason, basis = await store._select_agents(
        {'id': 'principal'},
        {'id': 'personal-space'},
        task_request(
            title='活动承接酒店需求二期',
            work_kind='hotel-requirement',
            required_capabilities=['hotel planning'],
        ),
    )

    assert selected[0]['agent_id'] == 'agent-b'
    assert [item['agent_id'] for item in candidates] == ['agent-b']
    assert reason == 'project_continuity'
    assert basis == [
        'last successful project lead continuity: 1 prior task(s), 1 completed',
        'exact work kind: hotel-requirement',
        'selected active task count: 0; work-kind fit and load precede history',
    ]


@pytest.mark.asyncio
async def test_blocked_or_open_participation_does_not_drive_project_continuity():
    store = HistorySelectionStore([
        candidate('agent-a', ['past-work'], ['legacy planning']),
        candidate('agent-b', ['verification'], ['test execution']),
    ], {}, project_history={
        'agent-a': {
            'participation_count': 2,
            'completed_count': 0,
            'failed_count': 0,
            'cancelled_count': 0,
            'last_task_at': '2026-08-27T10:00:00Z',
        },
    })

    selected, _, reason, basis = await store._select_agents(
        {'id': 'principal'},
        {'id': 'personal-space'},
        task_request(),
    )

    assert selected[0]['agent_id'] == 'agent-b'
    assert reason == 'exact_work_kind'
    assert basis == ['exact work kind: verification',
                     'selected active task count: 0; work-kind fit and load precede history']


@pytest.mark.asyncio
async def test_project_policy_can_require_manual_agent_selection():
    store = SelectionStore([
        candidate('agent-a', ['verification'], ['test execution']),
    ], auto_reuse_previous_agent=False)

    selected, candidates, reason, basis = await store._select_agents(
        {'id': 'principal'},
        {'id': 'personal-space'},
        task_request(),
    )

    assert selected == []
    assert [item['agent_id'] for item in candidates] == ['agent-a']
    assert reason == 'manual_agent_selection'
    assert basis == ['project policy requires an explicit @Agent selection']


@pytest.mark.asyncio
async def test_single_active_assignment_is_the_safe_first_use_fallback():
    store = SelectionStore([
        candidate('agent-a', ['design'], ['visual review']),
    ])

    selected, candidates, reason, basis = await store._select_agents(
        {'id': 'principal'},
        {'id': 'personal-space'},
        task_request(required_capabilities=[]),
    )

    assert selected[0]['agent_id'] == 'agent-a'
    assert candidates == selected
    assert reason == 'sole_active_assignment'
    assert basis[0] == 'the project has one active Agent assignment'
    assert any('no exact work-kind match: verification' in item for item in basis)
    assert any('continuity only' in item for item in basis)


@pytest.mark.asyncio
async def test_explicit_lead_remains_hard_override_over_historical_candidates():
    store = HistorySelectionStore([
        candidate('agent-a', ['verification'], ['test execution']),
        candidate('agent-b', ['verification'], ['test execution']),
    ], {
        'agent-b': {
            'participation_count': 5,
            'completed_count': 5,
            'failed_count': 0,
            'cancelled_count': 0,
        },
    })

    selected, _, reason, basis = await store._select_agents(
        {'id': 'principal'},
        {'id': 'personal-space', 'kind': 'personal'},
        task_request(lead_agent_id='agent-a'),
    )

    assert selected[0]['agent_id'] == 'agent-a'
    assert reason == 'explicit_agent'
    assert basis == ['explicit Agent selected']
    assert store.history_context is None


def test_parallel_plan_can_defer_collaborator_selection_to_coordinator():
    plan = ProjectAgentParallelPlan(
        enabled=True,
        independent_verification=True,
        conflict_free_scopes=True,
        reason='Independent verification paths.',
        workstream_boundaries=['API tests', 'UI tests'],
    )

    request = task_request(parallel_plan=plan)

    assert request.lead_agent_id is None
    assert request.collaborator_agent_ids == []


@pytest.mark.asyncio
async def test_parallel_staffing_uses_qualified_candidates_and_caps_at_boundaries():
    plan = ProjectAgentParallelPlan(
        enabled=True,
        independent_verification=True,
        conflict_free_scopes=True,
        reason='Independent verification paths.',
        workstream_boundaries=['API tests', 'UI tests', 'CLI tests'],
    )
    lead = candidate('agent-lead', ['verification'], ['test execution'])
    store = SelectionStore([
        lead,
        candidate('agent-a', ['verification'], ['test execution']),
        candidate('agent-b', ['verification'], ['test execution']),
        candidate('agent-wrong-kind', ['design'], ['test execution']),
    ])
    participants = [{'agent_id': 'agent-lead', 'role': 'lead'}]

    candidates = await store._parallel_staffing_candidates(
        task_request(parallel_plan=plan),
        [lead],
        participants,
    )
    added = StoreProjectAgentTasks._add_parallel_collaborators(
        plan,
        participants,
        candidates,
    )

    assert [item['agent_id'] for item in candidates] == ['agent-a', 'agent-b']
    assert [item['agent_id'] for item in added] == ['agent-a', 'agent-b']
    assert [item['agent_id'] for item in participants] == [
        'agent-lead',
        'agent-a',
        'agent-b',
    ]
    assert len({item['agent_id'] for item in participants}) == 3


def test_route_result_exposes_the_selected_agent_when_supplied():
    now = datetime.now(UTC)
    task = ProjectAgentTaskRecord(
        task_id='task-a',
        personal_space_id='personal-space',
        personal_project_id='project-a',
        title='Verify activity export',
        objective='Run the project verification and report the real result.',
        work_kind='verification',
        required_capabilities=['test execution'],
        duration='ongoing',
        staffing_intent='reuse_preferred',
        status='queued',
        revision=0,
        routing_outcome='assigned_existing',
        routing_reason='exact_work_kind',
        routing_explanation='exact work kind: verification',
        coordinator_agent_id='coordinator-a',
        complexity='simple',
        routing_decision=ProjectAgentRoutingDecisionRecord(
            decision_id='decision-a',
            task_id='task-a',
            coordinator_agent_id='coordinator-a',
            complexity='simple',
            selected_model_strategy=None,
            model_strategy_source='coordinator',
            outcome='assigned_existing',
            reason='exact_work_kind',
            created_at=now,
        ),
        created_at=now,
        updated_at=now,
    )
    agent = ProjectAgentRecord(
        agent_id='agent-a',
        personal_space_id='personal-space',
        personal_project_id='project-a',
        profile=ProjectAgentProfile(
            name='Verifier',
            responsibility='Verify project work.',
            work_kinds=['verification'],
            capabilities=['test execution'],
        ),
        created_at=now,
        updated_at=now,
    )

    result = StoreProjectAgentTasks()._route_result(
        task,
        None,
        assigned_agent=agent,
    )

    assert result.assigned_agent == agent


@pytest.mark.asyncio
async def test_multiple_non_matching_assignments_report_auditable_no_match():
    store = SelectionStore([
        candidate('agent-a', ['design'], ['visual review']),
        candidate('agent-b', ['copywriting'], ['content review']),
    ])

    selected, candidates, reason, basis = await store._select_agents(
        {'id': 'principal'},
        {'id': 'personal-space'},
        task_request(),
    )

    assert selected == []
    assert [item['agent_id'] for item in candidates] == ['agent-a', 'agent-b']
    assert reason == 'no_match'
    assert basis == ['no active assignment matched exactly']


@pytest.mark.asyncio
async def test_task_routing_skips_agents_that_disallow_the_source_client():
    store = SelectionStore([
        candidate(
            'codex-blocked',
            ['verification'],
            ['test execution'],
            allowed_clients=['claude_code'],
        ),
        candidate(
            'codex-allowed',
            ['verification'],
            ['test execution'],
            allowed_clients=['codex'],
        ),
    ])

    selected, candidates, reason, _ = await store._select_agents(
        {'id': 'principal'},
        {'id': 'personal-space'},
        task_request(source_application='codex'),
    )

    assert selected[0]['agent_id'] == 'codex-allowed'
    assert [item['agent_id'] for item in candidates] == ['codex-allowed']
    assert reason == 'exact_work_kind'


@pytest.mark.asyncio
async def test_only_disallowed_matching_agents_report_client_unavailability():
    store = SelectionStore([
        candidate(
            'claude-only',
            ['verification'],
            ['test execution'],
            allowed_clients=['claude_code'],
        ),
    ])

    selected, candidates, reason, basis = await store._select_agents(
        {'id': 'principal'},
        {'id': 'personal-space'},
        task_request(source_application='codex'),
    )

    assert selected == []
    assert candidates == []
    assert reason == 'agent_unavailable'
    assert basis == ['matching Agent is unavailable to source client: codex']


@pytest.mark.asyncio
async def test_recruitment_cannot_route_a_new_agent_to_a_disallowed_client():
    store = RecruitmentStore()
    request = task_request(
        staffing_intent='new_durable',
        source_application='codex',
        recruitment_profile=ProjectAgentProfile(
            name='Claude-only verifier',
            responsibility='Verify project work.',
            work_kinds=['verification'],
            capabilities=['test execution'],
            allowed_clients=['claude_code'],
        ),
    )

    with pytest.raises(HTTPException, match='not available to this source client'):
        await store._open_recruitment(
            {'id': 'principal'},
            {'id': 'personal-space'},
            request,
            'task-1',
            'coordinator-1',
            'explicit_new_agent',
        )

    assert store.persisted is False


@pytest.mark.asyncio
async def test_project_policy_asks_before_recruiting_a_new_agent_by_default():
    store = RecruitmentStore()

    recruitment, recruited = await store._open_recruitment(
        {'id': 'principal'},
        {'id': 'personal-space'},
        task_request(staffing_intent='new_durable', source_application='codex'),
        'task-1',
        'coordinator-1',
        'explicit_new_agent',
    )

    assert recruitment.status == 'awaiting_confirmation'
    assert recruitment.confirmation_mode == 'require_confirmation'
    assert recruited is None
    assert store.persisted is True


def test_task_model_strategy_precedence_is_task_assignment_agent():
    coordinator = ProjectAgentModelStrategy(mode='fast')
    profile = ProjectAgentProfile(
        name='Verifier',
        responsibility='Verify work.',
        default_model_strategy=ProjectAgentModelStrategy(mode='balanced'),
    )
    selected = {
        'profile': profile,
        'model_strategy_override': ProjectAgentModelStrategy(mode='deep').model_dump_json(),
    }
    request = task_request(
        model_strategy_override=ProjectAgentModelStrategy(mode='adaptive')
    )

    strategy, source = StoreProjectAgentTasks._effective_model_strategy(
        request,
        selected,
        coordinator,
    )

    assert strategy.mode == 'adaptive'
    assert source == 'task'


def test_parallel_work_rejects_less_than_two_real_participants():
    plan = ProjectAgentParallelPlan(
        enabled=True,
        independent_verification=True,
        conflict_free_scopes=True,
        reason='Independent verification paths.',
        workstream_boundaries=['API tests', 'UI tests'],
    )

    with pytest.raises(HTTPException, match='at least two active Agents') as exc_info:
        StoreProjectAgentTasks._verify_parallel_plan(
            plan,
            [{'agent_id': 'agent-a'}],
        )
    assert 'recruit another qualified collaborator' in exc_info.value.detail


def test_task_transition_keeps_terminal_states_immutable_and_requires_evidence_to_unblock():
    with pytest.raises(HTTPException, match='completed -> completed'):
        StoreProjectAgentTasks._validate_task_transition(
            'completed',
            'completed',
        )
    with pytest.raises(HTTPException, match='completed -> running'):
        StoreProjectAgentTasks._validate_task_transition(
            'completed',
            'running',
        )
    with pytest.raises(HTTPException, match='blocked -> running'):
        StoreProjectAgentTasks._validate_task_transition(
            'blocked',
            'running',
        )
    StoreProjectAgentTasks._validate_task_transition(
        'blocked',
        'running',
        has_actual_executor=True,
    )


def test_complexity_records_deterministic_basis():
    request = task_request(
        objective='x' * 1300,
        required_capabilities=['a', 'b', 'c', 'd'],
    )

    complexity, basis = StoreProjectAgentTasks._assess_complexity(request)

    assert complexity == 'complex'
    assert basis == ['long objective', 'four or more required capabilities']


def test_unassigned_task_cannot_also_name_a_lead_agent():
    with pytest.raises(ValueError, match='reuse_preferred'):
        task_request(
            staffing_intent='unassigned',
            lead_agent_id='agent-a',
        )


def test_actual_execution_activity_requires_executor_agent_and_model_together():
    with pytest.raises(ValueError, match='participating Agent'):
        ProjectAgentTaskActivityCreate(
            personal_space_id='personal-space',
            personal_project_id='project-a',
            task_id='task-a',
            idempotency_key='activity-0',
            status='completed',
            summary='Completed.',
        )

    with pytest.raises(ValueError, match='actual executor'):
        ProjectAgentTaskActivityCreate(
            personal_space_id='personal-space',
            personal_project_id='project-a',
            task_id='task-a',
            idempotency_key='activity-1',
            status='running',
            summary='Started.',
            agent_id='agent-a',
            actual_model_provider='openai',
            actual_model='gpt-5',
        )


def test_worker_status_requires_worker_and_participating_agent_identity():
    with pytest.raises(ValueError, match='worker status requires a worker ID'):
        ProjectAgentTaskActivityCreate(
            personal_space_id='personal-space',
            personal_project_id='project-a',
            task_id='task-a',
            idempotency_key='worker-status-without-identity',
            status='running',
            summary='Unattributed worker claim.',
            worker_status='completed',
        )

    with pytest.raises(ValueError, match='participating Agent'):
        ProjectAgentTaskActivityCreate(
            personal_space_id='personal-space',
            personal_project_id='project-a',
            task_id='task-a',
            idempotency_key='activity-2',
            status='running',
            summary='Started.',
            actual_executor_id='codex',
            actual_model_provider='openai',
            actual_model='gpt-5',
        )


@pytest.mark.asyncio
async def test_exact_terminal_event_retry_is_read_only_and_returns_the_task():
    request = ProjectAgentTaskActivityCreate(
        personal_space_id='personal-space',
        personal_project_id='project-a',
        task_id='task-a',
        idempotency_key='terminal-event-1',
        expected_revision=4,
        status='completed',
        summary='Completed.',
        agent_id='agent-a',
        source_application='codex',
    )
    event_id = stable_uuid(
        'provider',
        'personal-space',
        'project-agent-task-event',
        'task-a',
        'terminal-event-1',
    )
    store = ActivityStore({
        'task': {
            'task_id': 'task-a',
            'personal_project_id': 'project-a',
            'status': 'completed',
            'revision': 5,
        },
        'participant_rows': [{
            'agent_id': 'agent-a',
            'role': 'lead',
        }],
        'event_rows': [{
            'event_id': event_id,
            'payload_hash': StoreProjectAgentTasks._payload_hash(request),
        }],
    })

    result = await store.record_project_agent_task_activity(
        {'id': 'principal'},
        request,
    )

    assert result == 'existing-task'
    assert store.runtime.driver.event_calls == []


@pytest.mark.asyncio
async def test_stale_task_activity_does_not_persist_actual_executor_observation():
    store = ActivityStore({
        'task': {
            'task_id': 'task-a',
            'personal_project_id': 'project-a',
            'status': 'queued',
            'revision': 3,
            'model_strategy_source': 'coordinator',
        },
        'participant_rows': [{
            'agent_id': 'agent-a',
            'role': 'lead',
        }],
        'event_rows': [],
    })
    request = ProjectAgentTaskActivityCreate(
        personal_space_id='personal-space',
        personal_project_id='project-a',
        task_id='task-a',
        idempotency_key='activity-stale-1',
        expected_revision=2,
        status='running',
        summary='Started.',
        agent_id='agent-a',
        actual_executor_id='codex',
        actual_model_provider='openai',
        actual_model='gpt-5',
        source_application='codex',
    )

    with pytest.raises(HTTPException, match='revision is stale'):
        await store.record_project_agent_task_activity(
            {'id': 'principal'},
            request,
        )

    assert store.actual_reports == []


@pytest.mark.asyncio
@pytest.mark.parametrize(('allowed_clients', 'worker_runtime'), [
    (['claude_code'], None),
    (['codex'], {'application': 'claude_code', 'session_id': 'worker-session'}),
    (['claude_code'], {'application': 'claude_code', 'session_id': 'worker-session'}),
])
async def test_task_activity_refuses_a_client_outside_the_participant_allow_list(
    allowed_clients, worker_runtime,
):
    profile = ProjectAgentProfile(
        name='Claude-only Agent',
        responsibility='Verify project work.',
        allowed_clients=allowed_clients,
    )
    store = ActivityStore({
        'task': {
            'task_id': 'task-a',
            'personal_project_id': 'project-a',
            'status': 'queued',
            'revision': 1,
        },
        'participant_rows': [{
            'agent_id': 'agent-a',
            'role': 'lead',
            'profile_json': profile.model_dump_json(),
        }],
        'event_rows': [],
    })
    request = ProjectAgentTaskActivityCreate(
        personal_space_id='personal-space',
        personal_project_id='project-a',
        task_id='task-a',
        idempotency_key='activity-client-1',
        expected_revision=1,
        status='running',
        summary='Started.',
        agent_id='agent-a',
        source_application='codex',
        worker_id='worker-a' if worker_runtime else None,
        worker_runtime=worker_runtime,
    )

    with pytest.raises(HTTPException, match='not available to this source client'):
        await store.record_project_agent_task_activity(
            {'id': 'principal'},
            request,
        )

    assert store.runtime.driver.event_calls == []


@pytest.mark.asyncio
async def test_terminal_activity_ends_every_unfinished_task_participant():
    store = ActivityStore(
        {
            'task': {
                'task_id': 'task-a',
                'personal_project_id': 'project-a',
                'status': 'running',
                'revision': 3,
                'work_kind': 'verification',
            },
            'participant_rows': [
                {'agent_id': 'agent-a', 'role': 'lead'},
                {'agent_id': 'agent-b', 'role': 'collaborator'},
            ],
            'event_rows': [],
        },
        event_rows=[{
            'same_payload': True,
            'applied_transition': True,
        }],
    )
    request = ProjectAgentTaskActivityCreate(
        personal_space_id='personal-space',
        personal_project_id='project-a',
        task_id='task-a',
        idempotency_key='terminal-sync-1',
        expected_revision=3,
        status='failed',
        summary='Verification failed.',
        agent_id='agent-b',
        source_application='codex',
    )

    result = await store.record_project_agent_task_activity(
        {'id': 'principal'},
        request,
    )

    assert result == 'updated-task'
    event_query, event_parameters = store.runtime.driver.event_calls[0]
    assert '$terminal_at IS NOT NULL' in event_query
    assert "NOT (coalesce(participant.status, '') IN" in event_query
    assert 'applied_transition' in event_query
    assert '[:HAS_PROJECT_AGENT_TASK]' in event_query
    assert 'MATCH (space)-[:HAS_PROJECT_AGENT_IDENTITY]->' in event_query
    assert 'task.recruitment_provisioning_claimed_at <=' in event_query
    assert 'recruitment_claim_expired_before' in event_parameters


@pytest.mark.asyncio
async def test_activity_normalizes_a_legacy_null_task_revision():
    store = ActivityStore(
        {
            'task': {
                'task_id': 'task-a',
                'personal_project_id': 'project-a',
                'status': 'queued',
                'revision': None,
            },
            'participant_rows': [
                {'agent_id': 'agent-a', 'role': 'lead'},
            ],
            'event_rows': [],
        },
        event_rows=[{
            'same_payload': True,
            'applied_transition': True,
        }],
    )
    request = ProjectAgentTaskActivityCreate(
        personal_space_id='personal-space',
        personal_project_id='project-a',
        task_id='task-a',
        idempotency_key='legacy-null-revision-activity',
        status='running',
        summary='Legacy task resumed.',
        agent_id='agent-a',
        source_application='codex',
    )

    result = await store.record_project_agent_task_activity(
        {'id': 'principal'},
        request,
    )

    assert result == 'updated-task'
    event_query, event_parameters = store.runtime.driver.event_calls[0]
    assert event_parameters['expected_revision'] == 0
    assert 'coalesce(task.revision, 0) = $expected_revision' in event_query
    assert 'task.revision = coalesce(task.revision, 0) + 1' in event_query


@pytest.mark.asyncio
async def test_worker_runtime_is_saved_when_both_clients_are_allowed_without_model_claim():
    profile = ProjectAgentProfile(
        name='Verification Agent', responsibility='Verify project work.',
        allowed_clients=['codex', 'claude_code'],
    )
    store = ActivityStore({
        'task': {'task_id': 'task-a', 'personal_project_id': 'project-a',
                 'status': 'running', 'revision': 3},
        'participant_rows': [{'agent_id': 'agent-a', 'role': 'lead',
                              'profile_json': profile.model_dump_json()}],
        'event_rows': [],
    }, event_rows=[{'same_payload': True, 'applied_transition': True}])
    request = ProjectAgentTaskActivityCreate(
        personal_space_id='personal-space', personal_project_id='project-a',
        task_id='task-a', idempotency_key='worker-session-start',
        expected_revision=3, status='running', summary='Worker process started.',
        agent_id='agent-a', source_application='codex', source_session_id='host-session',
        worker_id='worker-a', worker_runtime={
            'application': 'claude_code', 'session_id': 'worker-session',
        },
    )
    assert await store.record_project_agent_task_activity({'id': 'principal'}, request) == 'updated-task'
    assert store.actual_reports == []
    _, params = store.runtime.driver.event_calls[0]
    assert params['source_application'] == 'codex'
    assert params['source_session_id'] == 'host-session'
    assert params['worker_runtime_json'] == request.worker_runtime.model_dump_json()
    assert params['token_usage_json'] is None


@pytest.mark.asyncio
async def test_worker_completion_does_not_terminalize_the_global_task():
    store = ActivityStore(
        {
            'task': {
                'task_id': 'task-a',
                'personal_project_id': 'project-a',
                'status': 'running',
                'revision': 3,
                'work_kind': 'verification',
            },
            'participant_rows': [
                {'agent_id': 'agent-a', 'role': 'lead'},
                {'agent_id': 'agent-b', 'role': 'collaborator'},
            ],
            'event_rows': [],
        },
        event_rows=[{
            'same_payload': True,
            'applied_transition': True,
        }],
    )
    request = ProjectAgentTaskActivityCreate(
        personal_space_id='personal-space',
        personal_project_id='project-a',
        task_id='task-a',
        idempotency_key='worker-complete-1',
        expected_revision=3,
        status='running',
        summary='Worker completed its slice.',
        agent_id='agent-a',
        source_application='codex',
        actual_executor_id='executor-codex',
        actual_model_provider='openai',
        actual_model='gpt-worker',
        worker_id='worker-a',
        worker_label='Codex worker',
        worker_occupation_emoji='🔧',
        worker_status='completed',
        worker_runtime={
            'application': 'codex', 'session_id': 'worker-session-a',
        },
        source_session_url=(
            'codex://threads/01234567-89ab-cdef-0123-456789abcdef'
        ),
        tools_used=['pytest', 'rg'],
        token_usage=ProjectAgentTokenUsage(
            source='executor',
            total_tokens=321,
            input_tokens=300,
            output_tokens=21,
        ),
    )

    result = await store.record_project_agent_task_activity(
        {'id': 'principal'},
        request,
    )

    assert result == 'updated-task'
    assert store.actual_reports[0].executor_id == 'executor-codex'
    event_query, event_parameters = store.runtime.driver.event_calls[0]
    assert "event.worker_id = $worker_id" in event_query
    assert event_parameters['worker_id'] == 'worker-a'
    assert event_parameters['worker_status'] == 'completed'
    assert 'event.source_session_url = $source_session_url' in event_query
    assert event_parameters['source_session_url'].startswith('codex://threads/')
    assert 'event.tools_used = $tools_used' in event_query
    assert event_parameters['tools_used'] == ['pytest', 'rg']
    assert 'event.token_usage_json = $token_usage_json' in event_query
    assert '"total_tokens":321' in event_parameters['token_usage_json']
    assert 'event.worker_runtime_json = $worker_runtime_json' in event_query
    assert event_parameters['worker_runtime_json'] == request.worker_runtime.model_dump_json()
    assert event_parameters['status'] == 'running'


@pytest.mark.asyncio
async def test_task_executor_resolution_passes_task_assignment_and_model_provenance():
    store = ResolverStore()
    request = task_request(
        executor_policy_override=ProjectAgentExecutorPolicy(
            mode='locked',
            locked_executor_ids=['codex'],
        )
    )
    selected = candidate('agent-a', ['verification'], ['test execution'])

    await store._resolve_executor_if_available(
        {'id': 'principal'},
        request,
        selected,
        ProjectAgentModelStrategy(mode='deep'),
        'task',
        'task-a',
    )

    assert store.resolved['assignment_id'] == 'assignment-agent-a'
    assert store.resolved['task_override'].locked_executor_ids == ['codex']
    assert store.resolved['model_strategy_source'] == 'task'
    assert store.resolved['required_capabilities'] == []


@pytest.mark.asyncio
async def test_task_executor_resolution_uses_only_explicit_executor_hints():
    store = ResolverStore()
    request = task_request(
        required_capabilities=['hotel planning', 'research'],
        executor_capability_hints=['testing'],
    )
    selected = candidate(
        'agent-a',
        ['hotel-requirement'],
        ['hotel planning', 'research'],
    )

    await store._resolve_executor_if_available(
        {'id': 'principal'},
        request,
        selected,
        ProjectAgentModelStrategy(mode='adaptive'),
        'agent',
        'task-a',
    )

    assert store.resolved['required_capabilities'] == ['testing']


def test_executor_decision_is_embedded_as_json_audit_data():
    raw = {
        'selected_executor_id': 'codex',
        'matched_rule_id': 'rule-a',
        'selection_reason': 'Matched the user project rule.',
        'fallback_outcome': 'not_needed',
        'executor_policy': {
            'mode': 'flexible',
            'locked_executor_ids': [],
            'preferred_executor_ids': [],
        },
    }

    class DecisionModel:
        def model_dump(self, *, mode):
            assert mode == 'json'
            return raw

    fields = StoreProjectAgentTasks._decision_executor_fields(DecisionModel())

    assert fields['executor_decision'] == raw
    assert isinstance(fields['executor_decision'], dict)
    assert fields['selected_executor_id'] == 'codex'


class ResolverStore(StoreProjectAgentTasks):
    def __init__(self):
        self.resolved = None

    async def resolve_project_agent_executor(self, actor, **values):
        self.resolved = values
        return {'status': 'selected'}


class SelectionStore(StoreProjectAgentTasks):
    def __init__(self, rows, *, auto_reuse_previous_agent=True):
        self.rows = rows
        self.auto_reuse_previous_agent = auto_reuse_previous_agent
        self.settings = SimpleNamespace(
            provider_id='provider',
            provider_mode='personal',
        )

    async def _assignment_candidates(self, personal_space_id, personal_project_id):
        assert personal_space_id == 'personal-space'
        assert personal_project_id == 'project-a'
        return self.rows

    async def get_project_agent_coordination_policy(
        self,
        actor,
        personal_space_id,
        personal_project_id,
    ):
        return SimpleNamespace(
            ask_before_recruitment=True,
            auto_reuse_previous_agent=self.auto_reuse_previous_agent,
        )

    async def _historical_project_agent_outcomes(
        self,
        personal_space_id,
        personal_project_id,
        agent_ids,
    ):
        return {}


class HistorySelectionStore(SelectionStore):
    def __init__(self, rows, history, *, project_history=None):
        super().__init__(rows)
        self.runtime = SimpleNamespace(driver=SelectionAuthorizationDriver())
        self.history = history
        self.history_context = None
        self.project_history = project_history or {}

    async def _historical_agent_outcomes(
        self,
        personal_space_id,
        personal_project_id,
        work_kind,
        agent_ids,
    ):
        self.history_context = (
            personal_space_id,
            personal_project_id,
            work_kind,
            tuple(agent_ids),
        )
        return self.history

    async def _historical_project_agent_outcomes(
        self,
        personal_space_id,
        personal_project_id,
        agent_ids,
    ):
        return self.project_history


class SelectionAuthorizationDriver:
    async def execute_query(self, query, **parameters):
        if 'RETURN project' in query:
            return ([{'project': {'project_id': parameters['project_id']}}], None, None)
        return ([{
            'agent': {
                'agent_id': parameters['agent_id'],
                'status': 'active',
            },
            'assignment_id': f"assignment-{parameters['agent_id']}",
        }], None, None)


class RecruitmentStore(StoreProjectAgentTasks):
    def __init__(self):
        self.settings = SimpleNamespace(
            provider_id='provider',
            provider_mode='personal',
        )
        self.runtime = SimpleNamespace(driver=RecruitmentDriver())
        self.persisted = False

    async def get_project_agent_coordination_policy(
        self,
        actor,
        personal_space_id,
        personal_project_id,
    ):
        return SimpleNamespace(
            ask_before_recruitment=True,
            auto_reuse_previous_agent=True,
        )

    async def _persist_recruitment(self, raw):
        self.persisted = True


class RecruitmentDriver:
    async def execute_query(self, query, **parameters):
        if 'RETURN recruitment' in query:
            return ([], None, None)
        return ([{'hr': {'agent_id': 'hr-1'}}], None, None)


class ActivityStore(StoreProjectAgentTasks):
    def __init__(self, row, *, event_rows=None):
        self.row = row
        self.settings = SimpleNamespace(
            provider_id='provider',
            provider_mode='personal',
        )
        self.runtime = SimpleNamespace(
            driver=ActivityDriver(event_rows or []),
        )
        self.actual_reports = []

    def _require_personal(self):
        return None

    async def authorize(self, actor, personal_space_id, role):
        return {'id': personal_space_id, 'kind': 'personal'}

    async def _find_task_row(self, personal_space_id, task_id):
        return self.row

    def _task_from_row(self, row):
        return 'existing-task'

    async def record_project_agent_executor_actual(self, actor, request):
        self.actual_reports.append(request)

    async def _archive_finished_temporary_agent(self, request, raw_task, updated_at):
        return None

    async def get_project_agent_task(self, actor, personal_space_id, task_id):
        return 'updated-task'


class ActivityDriver:
    def __init__(self, event_rows):
        self.event_rows = event_rows
        self.calls = []

    @property
    def event_calls(self):
        return [call for call in self.calls if 'MERGE (event:FuliProjectAgentTaskEvent' in call[0]]

    async def execute_query(self, query, **parameters):
        self.calls.append((query, parameters))
        if 'RETURN project' in query:
            return ([{'project': {'project_id': 'project-a'}}], None, None)
        return (self.event_rows, None, None)

    @asynccontextmanager
    async def transaction(self):
        driver = self

        class QueryTransaction:
            async def run(self, query, **parameters):
                records, _, _ = await driver.execute_query(query, **parameters)

                async def rows():
                    for record in records:
                        yield record
                return rows()

        yield QueryTransaction()


def candidate(agent_id, work_kinds, capabilities, *, allowed_clients=None):
    return {
        'agent_id': agent_id,
        'assignment_id': f'assignment-{agent_id}',
        'responsibility': 'Project work',
        'work_kinds': work_kinds,
        'capabilities': capabilities,
        'model_strategy_override': None,
        'profile': ProjectAgentProfile(
            name=agent_id,
            responsibility='Project work',
            work_kinds=work_kinds,
            capabilities=capabilities,
            allowed_clients=allowed_clients or [
                'codex', 'claude_code', 'cursor', 'kiro', 'other',
            ],
        ),
        'assigned_at': '2026-08-17T00:00:00Z',
    }
