import asyncio
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from fuli_graph.project_agent_models import ProjectAgentProfile
from fuli_graph.project_agent_task_models import (
    ProjectAgentParallelPlan,
    ProjectAgentRecruitmentDecision,
    ProjectAgentTaskRecord,
    ProjectAgentTaskSubmit,
)
from fuli_graph.provider_values import stable_uuid
from fuli_graph.store_project_agent_tasks import StoreProjectAgentTasks


def task_request(**updates):
    values = {
        'personal_space_id': 'personal-space',
        'personal_project_id': 'project-a',
        'idempotency_key': 'parallel-task-idempotency',
        'title': 'Verify parallel recruitment',
        'objective': 'Recruit only the missing Agents and preserve an audit trail.',
        'work_kind': 'verification',
        'required_capabilities': ['test execution'],
        'routing_reason': 'The task requires independently verified work.',
    }
    values.update(updates)
    return ProjectAgentTaskSubmit(**values)


def parallel_plan():
    return ProjectAgentParallelPlan(
        enabled=True,
        independent_verification=True,
        conflict_free_scopes=True,
        reason='Independent verification paths.',
        workstream_boundaries=['API tests', 'UI tests'],
    )


def candidate(agent_id):
    return {
        'agent_id': agent_id,
        'assignment_id': f'assignment-{agent_id}',
        'responsibility': 'Project verification',
        'work_kinds': ['verification'],
        'capabilities': ['test execution'],
        'model_strategy_override': None,
        'profile': ProjectAgentProfile(
            name=agent_id,
            responsibility='Project verification',
            work_kinds=['verification'],
            capabilities=['test execution'],
            allowed_clients=['codex', 'claude_code', 'cursor', 'kiro', 'other'],
        ),
        'assigned_at': '2026-08-17T00:00:00Z',
    }


@pytest.mark.asyncio
async def test_parallel_recruitment_confirmation_validation_has_no_side_effects():
    store = AtomicSubmitStore(
        ask_before_recruitment=True,
        active_hr=True,
    )
    for idempotency_key in (
        'parallel-recruitment-failure',
        'parallel-recruitment-retry',
    ):
        request = task_request(
            idempotency_key=idempotency_key,
            staffing_intent='new_durable',
            parallel_plan=parallel_plan(),
        )

        with pytest.raises(HTTPException, match='at least two active Agents'):
            await store.submit_project_agent_task({'id': 'principal'}, request)

    assert store.side_effects == []


@pytest.mark.asyncio
async def test_automatic_parallel_recruitment_fills_two_agent_minimum():
    store = AtomicSubmitStore(
        ask_before_recruitment=False,
        active_hr=True,
    )

    result = await store.submit_project_agent_task(
        {'id': 'principal'},
        task_request(
            idempotency_key='parallel-auto-recruit-two',
            staffing_intent='new_durable',
            parallel_plan=parallel_plan(),
        ),
    )

    assert store.side_effects == [
        'coordinator',
        'recruitment:lead:lead',
        'recruitment:collaborator:collaborator-1',
        'persist',
    ]
    assert [item['role'] for item in store.persisted['participants']] == [
        'lead',
        'collaborator',
    ]
    assert len(result.recruitments) == 2


@pytest.mark.asyncio
async def test_automatic_parallel_recruitment_only_fills_missing_collaborator():
    store = AtomicSubmitStore(
        ask_before_recruitment=False,
        active_hr=True,
        selected_lead='existing-lead',
    )

    result = await store.submit_project_agent_task(
        {'id': 'principal'},
        task_request(
            idempotency_key='parallel-auto-recruit-one',
            parallel_plan=parallel_plan(),
        ),
    )

    assert store.side_effects == [
        'coordinator',
        'recruitment:collaborator:collaborator-1',
        'persist',
    ]
    assert [item['agent_id'] for item in store.persisted['participants']] == [
        'existing-lead',
        'recruited-collaborator-1',
    ]
    assert len(result.recruitments) == 1


@pytest.mark.asyncio
async def test_existing_parallel_team_is_reused_without_recruitment():
    store = AtomicSubmitStore(
        ask_before_recruitment=False,
        active_hr=True,
        selected_lead='existing-lead',
        collaborators=['existing-collaborator'],
    )

    result = await store.submit_project_agent_task(
        {'id': 'principal'},
        task_request(
            idempotency_key='parallel-existing-team',
            parallel_plan=parallel_plan(),
        ),
    )

    assert store.side_effects == ['coordinator', 'persist']
    assert result.recruitments == []


@pytest.mark.asyncio
@pytest.mark.parametrize('ask_before_recruitment', [False, True])
async def test_parallel_boundary_validation_has_no_side_effects(
    ask_before_recruitment,
):
    store = AtomicSubmitStore(
        ask_before_recruitment=ask_before_recruitment,
        collaborators=['agent-a', 'agent-b', 'agent-c'],
    )
    request = task_request(
        idempotency_key='parallel-boundary-failure',
        staffing_intent='new_durable',
        parallel_plan=parallel_plan(),
    )

    with pytest.raises(
        HTTPException,
        match='exceeds declared workstream boundaries',
    ):
        await store.submit_project_agent_task({'id': 'principal'}, request)

    assert store.side_effects == []


@pytest.mark.asyncio
async def test_recruitment_client_validation_precedes_coordinator_write():
    store = AtomicSubmitStore(
        ask_before_recruitment=False,
        active_hr=True,
    )
    request = task_request(
        idempotency_key='recruitment-client-preflight',
        staffing_intent='new_durable',
        recruitment_profile=ProjectAgentProfile(
            name='Claude-only Agent',
            responsibility='Run a client-scoped verification task.',
            agent_type='durable',
            work_kinds=['verification'],
            capabilities=['tests'],
            allowed_clients=['claude_code'],
        ),
        source_application='codex',
    )

    with pytest.raises(HTTPException) as exc_info:
        await store.submit_project_agent_task({'id': 'principal'}, request)

    assert exc_info.value.status_code == 403
    assert store.side_effects == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ('active_hr', 'staffing_intent'),
    [(False, 'new_durable'), (True, 'unassigned')],
)
async def test_parallel_auto_recruitment_requires_hr_and_assignable_intent(
    active_hr,
    staffing_intent,
):
    store = AtomicSubmitStore(
        ask_before_recruitment=False,
        active_hr=active_hr,
    )

    with pytest.raises(HTTPException, match='at least two active Agents'):
        await store.submit_project_agent_task(
            {'id': 'principal'},
            task_request(
                idempotency_key=f'parallel-guard-{active_hr}-{staffing_intent}',
                staffing_intent=staffing_intent,
                parallel_plan=parallel_plan(),
            ),
        )

    assert store.side_effects == []


@pytest.mark.asyncio
async def test_automatic_parallel_recruitment_projects_all_missing_roles():
    store = AtomicSubmitStore(
        ask_before_recruitment=False,
        active_hr=True,
    )

    projected_from_zero = await store._parallel_plan_participant_projection(
        {'id': 'principal'},
        task_request(
            staffing_intent='new_durable',
            parallel_plan=parallel_plan(),
        ),
        lead=None,
        participants=[],
        routing_reason='explicit_new_agent',
    )
    projected_from_one = await store._parallel_plan_participant_projection(
        {'id': 'principal'},
        task_request(parallel_plan=parallel_plan()),
        lead=candidate('existing-agent'),
        participants=[{'agent_id': 'existing-agent', 'role': 'lead'}],
        routing_reason='exact_work_kind',
    )

    assert [item['role'] for item in projected_from_zero] == [
        'lead',
        'collaborator',
    ]
    assert [item['agent_id'] for item in projected_from_one] == [
        'existing-agent',
        '__recruited_collaborator_1__',
    ]


@pytest.mark.asyncio
async def test_recruitment_slots_are_stable_and_do_not_reprovision():
    store = InMemoryRecruitmentStore()
    request = task_request(
        staffing_intent='new_durable',
        source_application='codex',
    )

    lead, _ = await store._open_recruitment(
        {'id': 'principal'},
        {'id': 'personal-space'},
        request,
        'task-1',
        'coordinator-1',
        'explicit_new_agent',
    )
    lead_replay, _ = await store._open_recruitment(
        {'id': 'principal'},
        {'id': 'personal-space'},
        request,
        'task-1',
        'coordinator-1',
        'explicit_new_agent',
    )
    collaborator, _ = await store._open_recruitment(
        {'id': 'principal'},
        {'id': 'personal-space'},
        request,
        'task-1',
        'coordinator-1',
        'explicit_new_agent',
        participant_role='collaborator',
        recruitment_slot='collaborator-1',
    )
    collaborator_replay, _ = await store._open_recruitment(
        {'id': 'principal'},
        {'id': 'personal-space'},
        request,
        'task-1',
        'coordinator-1',
        'explicit_new_agent',
        participant_role='collaborator',
        recruitment_slot='collaborator-1',
    )

    assert lead.recruitment_id == stable_uuid(
        'provider',
        'personal-space',
        'project-agent-recruitment',
        'task-1',
    )
    assert lead.recruitment_id == lead_replay.recruitment_id
    assert collaborator.recruitment_id == collaborator_replay.recruitment_id
    assert collaborator.recruitment_id != lead.recruitment_id
    assert collaborator.participant_role == 'collaborator'
    assert collaborator.recruitment_slot == 'collaborator-1'
    assert store.provision_count == 2


@pytest.mark.asyncio
async def test_concurrent_first_recruitment_provisions_exactly_once():
    store = RacingInMemoryRecruitmentStore()
    request = task_request(
        staffing_intent='new_durable',
        source_application='codex',
    )

    async def recruit():
        return await store._open_recruitment(
            {'id': 'principal'},
            {'id': 'personal-space'},
            request,
            'task-concurrent',
            'coordinator-1',
            'explicit_new_agent',
        )

    results = await asyncio.gather(recruit(), recruit())

    assert {
        recruitment.recruitment_id
        for recruitment, _ in results
    } == {
        stable_uuid(
            'provider',
            'personal-space',
            'project-agent-recruitment',
            'task-concurrent',
        )
    }
    assert store.provision_count == 1


@pytest.mark.asyncio
async def test_stale_requested_recruitment_is_reclaimed_and_completed():
    store = RecoveringInMemoryRecruitmentStore()
    request = task_request(
        staffing_intent='new_durable',
        source_application='codex',
    )

    with pytest.raises(RuntimeError, match='simulated provision crash'):
        await store._open_recruitment(
            {'id': 'principal'},
            {'id': 'personal-space'},
            request,
            'task-recover',
            'coordinator-1',
            'explicit_new_agent',
        )

    raw = next(iter(store.records.values()))
    raw['provisioning_claimed_at'] = datetime.now(UTC) - timedelta(minutes=5)
    recruitment, recruited = await store._open_recruitment(
        {'id': 'principal'},
        {'id': 'personal-space'},
        request,
        'task-recover',
        'coordinator-1',
        'explicit_new_agent',
    )

    assert recruitment.status == 'fulfilled'
    assert recruited['agent_id'] == recruitment.proposed_agent_id
    assert store.provision_attempts == 2
    assert store.provision_count == 1


@pytest.mark.asyncio
async def test_task_replay_reclaims_stale_provisioning_before_assignment():
    store = TaskReplayStaleClaimStore()
    request = task_request(
        staffing_intent='new_durable',
        source_application='codex',
    )

    with pytest.raises(RuntimeError, match='simulated provision crash'):
        await store._open_recruitment(
            {'id': 'principal'},
            {'id': 'personal-space'},
            request,
            'task-stale-replay',
            'coordinator-1',
            'explicit_new_agent',
        )
    raw = next(iter(store.records.values()))
    raw['provisioning_claimed_at'] = datetime.now(UTC) - timedelta(minutes=5)

    changed = await store._recover_recruitment_lifecycle(
        {'id': 'principal'},
        request,
        SimpleNamespace(
            task_id='task-stale-replay',
            status='awaiting_recruitment',
        ),
        [store._recruitment(raw)],
    )

    assert changed is True
    assert raw['status'] == 'fulfilled'
    assert store.provision_attempts == 2
    assert store.provision_count == 1
    assert store.linked_agent_ids == [raw['proposed_agent_id']]
    assert store.activated_agent_ids == [raw['proposed_agent_id']]


@pytest.mark.asyncio
async def test_task_replay_recovers_every_requested_parallel_slot_in_one_pass():
    store = MultiSlotReplayStore()
    request = task_request(source_application='codex')
    now = datetime.now(UTC)
    profile = ProjectAgentProfile(
        name='Recovered Agent',
        responsibility='Verify one independent workstream.',
        work_kinds=['verification'],
        capabilities=['test execution'],
    )
    for index, role in enumerate(('lead', 'collaborator')):
        recruitment_id = f'recruitment-{index}'
        store.records[recruitment_id] = {
            'id': recruitment_id,
            'recruitment_id': recruitment_id,
            'personal_space_id': 'personal-space',
            'personal_project_id': 'project-a',
            'task_id': 'task-parallel-replay',
            'coordinator_agent_id': 'coordinator-1',
            'hr_agent_id': 'hr-1',
            'position_kind': 'durable',
            'work_kind': 'verification',
            'required_capabilities': ['test execution'],
            'reason_code': 'explicit_new_agent',
            'reason': 'Recover every slot.',
            'status': 'requested',
            'confirmation_mode': 'automatic',
            'proposed_agent_id': f'agent-{index}',
            'proposed_profile_json': profile.model_dump_json(),
            'participant_role': role,
            'recruitment_slot': 'lead' if index == 0 else 'collaborator-1',
            'cleanup_eligible': False,
            'revision': 0,
            'created_at': now,
            'updated_at': now,
            'provisioning_claim_id': f'stale-{index}',
            'provisioning_claimed_at': now - timedelta(minutes=5),
        }
    recruitments = [store._recruitment(raw) for raw in store.records.values()]

    changed = await store._recover_recruitment_lifecycle(
        {'id': 'principal'},
        request,
        SimpleNamespace(
            task_id='task-parallel-replay',
            status='awaiting_recruitment',
            revision=4,
        ),
        recruitments,
    )

    assert changed is True
    assert store.claim_revisions == [4, 6]
    assert {raw['status'] for raw in store.records.values()} == {'fulfilled'}


@pytest.mark.asyncio
async def test_terminal_task_replay_does_not_resume_requested_recruitment():
    store = TaskReplayStaleClaimStore()
    request = task_request(
        staffing_intent='new_durable',
        source_application='codex',
    )

    with pytest.raises(RuntimeError, match='simulated provision crash'):
        await store._open_recruitment(
            {'id': 'principal'},
            {'id': 'personal-space'},
            request,
            'task-cancelled-replay',
            'coordinator-1',
            'explicit_new_agent',
        )
    raw = next(iter(store.records.values()))
    raw['provisioning_claimed_at'] = datetime.now(UTC) - timedelta(minutes=5)

    changed = await store._recover_recruitment_lifecycle(
        {'id': 'principal'},
        request,
        SimpleNamespace(
            task_id='task-cancelled-replay',
            status='cancelled',
            revision=4,
        ),
        [store._recruitment(raw)],
    )

    assert changed is False
    assert raw['status'] == 'requested'
    assert store.provision_attempts == 1
    assert store.provision_count == 0
    assert store.linked_agent_ids == []
    assert store.activated_agent_ids == []


@pytest.mark.asyncio
async def test_ready_assignment_is_finalized_without_stealing_active_claim():
    store = ReadyAssignmentRecoveryStore()
    request = task_request(
        staffing_intent='new_durable',
        source_application='codex',
    )

    with pytest.raises(RuntimeError, match='after assignment'):
        await store._open_recruitment(
            {'id': 'principal'},
            {'id': 'personal-space'},
            request,
            'task-ready-assignment',
            'coordinator-1',
            'explicit_new_agent',
        )
    original_claim = next(iter(store.records.values()))[
        'provisioning_claim_id'
    ]

    recruitment, recruited = await store._open_recruitment(
        {'id': 'principal'},
        {'id': 'personal-space'},
        request,
        'task-ready-assignment',
        'coordinator-1',
        'explicit_new_agent',
    )

    assert recruitment.status == 'fulfilled'
    assert recruited['agent_id'] == recruitment.proposed_agent_id
    assert store.provision_attempts == 1
    assert store.claim_attempts == 0
    assert next(iter(store.records.values()))[
        'provisioning_claim_id'
    ] == original_claim


@pytest.mark.asyncio
async def test_task_replay_finalizes_assignment_ready_recruitment_after_crash():
    store = TaskReplayReadyAssignmentStore()
    request = task_request(
        staffing_intent='new_durable',
        source_application='codex',
    )

    with pytest.raises(RuntimeError, match='after assignment'):
        await store._open_recruitment(
            {'id': 'principal'},
            {'id': 'personal-space'},
            request,
            'task-ready-replay',
            'coordinator-1',
            'explicit_new_agent',
        )
    raw = next(iter(store.records.values()))
    assert raw['status'] == 'requested'

    changed = await store._recover_recruitment_lifecycle(
        {'id': 'principal'},
        request,
        SimpleNamespace(
            task_id='task-ready-replay',
            status='awaiting_recruitment',
        ),
        [store._recruitment(raw)],
    )

    assert changed is True
    assert raw['status'] == 'fulfilled'
    assert store.provision_attempts == 1
    assert store.linked_agent_ids == [raw['proposed_agent_id']]
    assert store.activated_agent_ids == [raw['proposed_agent_id']]


@pytest.mark.asyncio
async def test_recruitment_approval_claims_revision_in_one_atomic_write():
    store = AtomicDecisionStore()
    request = ProjectAgentRecruitmentDecision(
        personal_space_id='personal-space',
        personal_project_id='project-a',
        recruitment_id='recruitment-approval',
        expected_revision=0,
        decision='approve',
        reason='Approved for independent verification.',
    )

    result = await store.decide_project_agent_recruitment(
        {'id': 'principal'},
        request,
    )

    decision_query, decision_parameters = store.runtime.driver.calls[1]
    normalized_query = ''.join(decision_query.split())
    assert "recruitment.status='awaiting_confirmation'" in normalized_query
    assert 'coalesce(recruitment.revision,0)=$expected_revision' in normalized_query
    assert (
        'recruitment.revision=coalesce(recruitment.revision,0)+1'
        in normalized_query
    )
    assert 'SETrecruitment.status=$decision_status' in normalized_query
    assert "task.status='awaiting_recruitment'" in normalized_query
    assert (
        'task.recruitment_provisioning_claimed_atISNULL' in normalized_query
    )
    assert (
        'task.recruitment_provisioning_claimed_at<=$claim_expired_before'
        in normalized_query
    )
    assert (
        'task.recruitment_provisioning_claim_id=$provisioning_claim_id'
        in normalized_query
    )
    assert 'task.revision=coalesce(task.revision,0)+1' in normalized_query
    assert decision_parameters['decision_status'] == 'requested'
    assert decision_parameters['provisioning_claim_id']
    assert decision_parameters['claim_expired_before'] < decision_parameters[
        'provisioning_claimed_at'
    ]
    assert result.status == 'fulfilled'

    with pytest.raises(HTTPException, match='revision is stale'):
        await store.decide_project_agent_recruitment(
            {'id': 'principal'},
            request,
        )


def test_partial_parallel_recruitment_does_not_report_recruited():
    store = AtomicDecisionStore()
    fulfilled_raw = dict(store.raw)
    fulfilled_raw.update({
        'status': 'fulfilled',
        'recruited_agent_id': fulfilled_raw['proposed_agent_id'],
        'fulfilled_at': datetime.now(UTC),
    })
    blocked_raw = dict(store.raw)
    blocked_raw.update({
        'id': 'recruitment-collaborator',
        'recruitment_id': 'recruitment-collaborator',
        'proposed_agent_id': 'blocked-collaborator',
        'participant_role': 'collaborator',
        'recruitment_slot': 'collaborator-1',
        'status': 'blocked',
    })
    fulfilled = store._recruitment(fulfilled_raw)
    blocked = store._recruitment(blocked_raw)
    task = ProjectAgentTaskRecord.model_construct(routing_outcome='blocked')

    result = store._route_result(
        task,
        fulfilled,
        recruitments=[fulfilled, blocked],
    )

    assert result.decision == 'blocked'


class InMemoryRecruitmentStore(StoreProjectAgentTasks):
    def __init__(self):
        self.settings = SimpleNamespace(
            provider_id='provider',
            provider_mode='personal',
        )
        self.runtime = SimpleNamespace(driver=RecruitmentDriver())
        self.records = {}
        self.provision_count = 0

    async def get_project_agent_coordination_policy(
        self,
        actor,
        personal_space_id,
        personal_project_id,
    ):
        return SimpleNamespace(
            ask_before_recruitment=False,
            auto_reuse_previous_agent=True,
        )

    async def _get_recruitment(self, personal_space_id, recruitment_id):
        raw = self.records.get(recruitment_id)
        return self._recruitment(raw) if raw else None

    async def _persist_recruitment(self, raw):
        created = raw['recruitment_id'] not in self.records
        self.records.setdefault(raw['recruitment_id'], raw)
        return created

    async def _provision_recruitment(self, actor, raw):
        self.provision_count += 1
        now = datetime.now(UTC)
        stored = self.records[raw['recruitment_id']]
        stored.update({
            'status': 'fulfilled',
            'recruited_agent_id': raw['proposed_agent_id'],
            'fulfilled_at': now,
            'updated_at': now,
            'revision': 1,
        })
        return candidate(raw['proposed_agent_id'])

    async def _assignment_candidates(
        self,
        personal_space_id,
        personal_project_id,
        *,
        include_temporary=False,
    ):
        return [
            candidate(raw['proposed_agent_id'])
            for raw in self.records.values()
            if raw['status'] == 'fulfilled'
        ]


class RacingInMemoryRecruitmentStore(InMemoryRecruitmentStore):
    """Force two first-look misses while keeping persistence atomic."""

    def __init__(self):
        super().__init__()
        self.initial_reads = 0
        self.initial_reads_ready = asyncio.Event()

    async def _get_recruitment(self, personal_space_id, recruitment_id):
        if not self.records:
            self.initial_reads += 1
            if self.initial_reads == 2:
                self.initial_reads_ready.set()
            await self.initial_reads_ready.wait()
            return None
        return await super()._get_recruitment(
            personal_space_id,
            recruitment_id,
        )


class RecoveringInMemoryRecruitmentStore(InMemoryRecruitmentStore):
    def __init__(self):
        super().__init__()
        self.provision_attempts = 0

    async def _provision_recruitment(self, actor, raw):
        self.provision_attempts += 1
        if self.provision_attempts == 1:
            raise RuntimeError('simulated provision crash')
        return await super()._provision_recruitment(actor, raw)

    async def _claim_requested_recruitment(
        self,
        request,
        recruitment_id,
        **kwargs,
    ):
        raw = self.records[recruitment_id]
        claimed_at = raw.get('provisioning_claimed_at')
        if claimed_at and claimed_at > datetime.now(UTC) - timedelta(minutes=2):
            return None
        raw['provisioning_claim_id'] = 'recovery-claim'
        raw['provisioning_claimed_at'] = datetime.now(UTC)
        return raw


class TaskReplayStaleClaimStore(RecoveringInMemoryRecruitmentStore):
    def __init__(self):
        super().__init__()
        self.linked_agent_ids = []
        self.activated_agent_ids = []

    async def _get_recruitment_raw(self, personal_space_id, recruitment_id):
        return self.records.get(recruitment_id)

    async def _task_recruitments(self, personal_space_id, task_id):
        return [
            self._recruitment(raw)
            for raw in self.records.values()
            if raw['task_id'] == task_id
        ]

    async def _link_recruited_task_participant(self, recruitment, selected):
        self.linked_agent_ids.append(selected['agent_id'])

    async def _activate_approved_recruitment(
        self,
        actor,
        recruitment,
        selected,
        approval_reason,
        **kwargs,
    ):
        self.activated_agent_ids.append(selected['agent_id'])


class MultiSlotReplayStore(InMemoryRecruitmentStore):
    def __init__(self):
        super().__init__()
        self.current_task_revision = 4
        self.claim_revisions = []

    async def _finalize_ready_recruitment(self, *args, **kwargs):
        return None

    async def _claim_requested_recruitment(
        self,
        request,
        recruitment_id,
        *,
        task_id=None,
        expected_task_revision=None,
    ):
        self.claim_revisions.append(expected_task_revision)
        if expected_task_revision != self.current_task_revision:
            return None
        raw = self.records[recruitment_id]
        raw['provisioning_claim_id'] = f'claim-{recruitment_id}'
        raw['provisioning_claimed_at'] = datetime.now(UTC)
        raw['_guarded_task_id'] = task_id
        self.current_task_revision += 1
        return raw

    async def _provision_recruitment(self, actor, raw):
        selected = await super()._provision_recruitment(actor, raw)
        self.current_task_revision += 1
        return selected

    async def _get_recruitment_raw(self, personal_space_id, recruitment_id):
        return self.records.get(recruitment_id)

    async def _task_recruitments(self, personal_space_id, task_id):
        return [
            self._recruitment(raw)
            for raw in self.records.values()
            if raw['task_id'] == task_id
        ]

    async def _link_recruited_task_participant(self, recruitment, selected):
        return None

    async def _activate_approved_recruitment(self, *args, **kwargs):
        return None


class ReadyAssignmentRecoveryStore(InMemoryRecruitmentStore):
    def __init__(self):
        super().__init__()
        self.assignment_ready = False
        self.provision_attempts = 0
        self.claim_attempts = 0

    async def _provision_recruitment(self, actor, raw):
        self.provision_attempts += 1
        self.assignment_ready = True
        raise RuntimeError('simulated crash after assignment')

    async def _finalize_ready_recruitment(
        self,
        request,
        recruitment_id,
        **kwargs,
    ):
        if not self.assignment_ready:
            return None
        raw = self.records[recruitment_id]
        now = datetime.now(UTC)
        raw.update({
            'status': 'fulfilled',
            'recruited_agent_id': raw['proposed_agent_id'],
            'fulfilled_at': now,
            'updated_at': now,
            'revision': 1,
        })
        return raw

    async def _claim_requested_recruitment(
        self,
        request,
        recruitment_id,
        **kwargs,
    ):
        self.claim_attempts += 1
        return None

    async def _assignment_candidates(self, *args, **kwargs):
        if not self.assignment_ready:
            return []
        raw = next(iter(self.records.values()))
        return [candidate(raw['proposed_agent_id'])]


class TaskReplayReadyAssignmentStore(ReadyAssignmentRecoveryStore):
    def __init__(self):
        super().__init__()
        self.linked_agent_ids = []
        self.activated_agent_ids = []

    async def _get_recruitment_raw(self, personal_space_id, recruitment_id):
        return self.records.get(recruitment_id)

    async def _task_recruitments(self, personal_space_id, task_id):
        return [
            self._recruitment(raw)
            for raw in self.records.values()
            if raw['task_id'] == task_id
        ]

    async def _link_recruited_task_participant(self, recruitment, selected):
        self.linked_agent_ids.append(selected['agent_id'])

    async def _activate_approved_recruitment(
        self,
        actor,
        recruitment,
        selected,
        approval_reason,
        **kwargs,
    ):
        self.activated_agent_ids.append(selected['agent_id'])


class AtomicDecisionStore(StoreProjectAgentTasks):
    def __init__(self):
        self.settings = SimpleNamespace(
            provider_id='provider',
            provider_mode='personal',
        )
        self.runtime = SimpleNamespace(driver=AtomicDecisionDriver())
        now = datetime.now(UTC)
        profile = ProjectAgentProfile(
            name='Approval Agent',
            responsibility='Verify approved work.',
            work_kinds=['verification'],
            capabilities=['test execution'],
        )
        self.raw = {
            'id': 'recruitment-approval',
            'recruitment_id': 'recruitment-approval',
            'personal_space_id': 'personal-space',
            'personal_project_id': 'project-a',
            'task_id': 'task-approval',
            'coordinator_agent_id': 'coordinator-1',
            'hr_agent_id': 'hr-1',
            'position_kind': 'durable',
            'work_kind': 'verification',
            'required_capabilities': ['test execution'],
            'reason_code': 'explicit_new_agent',
            'reason': 'Independent verification needs an Agent.',
            'status': 'awaiting_confirmation',
            'confirmation_mode': 'require_confirmation',
            'proposed_agent_id': 'approved-agent',
            'proposed_profile_json': profile.model_dump_json(),
            'participant_role': 'lead',
            'recruitment_slot': 'lead',
            'cleanup_eligible': False,
            'revision': 0,
            'created_at': now,
            'updated_at': now,
        }
        self.runtime.driver.store = self

    def _require_personal(self):
        return None

    async def authorize(self, actor, personal_space_id, role):
        return {'id': personal_space_id, 'kind': 'personal'}

    async def _provision_recruitment(self, actor, raw):
        assert raw['status'] == 'requested'
        assert raw['provisioning_claim_id']
        self.raw.update(raw)
        self.raw.update({
            'status': 'fulfilled',
            'recruited_agent_id': raw['proposed_agent_id'],
            'fulfilled_at': datetime.now(UTC),
        })
        return candidate(raw['proposed_agent_id'])

    async def _activate_approved_recruitment(self, *args):
        return None

    async def _get_recruitment(self, personal_space_id, recruitment_id):
        return self._recruitment(self.raw)


class AtomicDecisionDriver:
    def __init__(self):
        self.calls = []
        self.claimed = False
        self.store = None

    async def execute_query(self, query, **parameters):
        self.calls.append((query, parameters))
        if 'RETURN project' in query:
            return ([{'project': {'project_id': 'project-a'}}], None, None)
        if 'SET recruitment.status = $decision_status' not in query:
            return ([], None, None)
        if self.claimed:
            return ([], None, None)
        self.claimed = True
        raw = dict(self.store.raw)
        raw.update({
            'status': parameters['decision_status'],
            'decision_reason': parameters['reason'],
            'provisioning_claim_id': parameters['provisioning_claim_id'],
            'provisioning_claimed_at': parameters['provisioning_claimed_at'],
            'revision': raw['revision'] + 1,
            'updated_at': parameters['updated_at'],
        })
        return ([{'recruitment': raw}], None, None)


class AtomicSubmitStore(StoreProjectAgentTasks):
    def __init__(
        self,
        *,
        ask_before_recruitment,
        active_hr=False,
        collaborators=None,
        selected_lead=None,
    ):
        self.settings = SimpleNamespace(
            provider_id='provider',
            provider_mode='personal',
        )
        self.runtime = SimpleNamespace(
            driver=AtomicSubmitDriver(active_hr=active_hr),
        )
        self.ask_before_recruitment = ask_before_recruitment
        self.collaborators = collaborators or []
        self.selected_lead = selected_lead
        self.side_effects = []
        self.persisted = {}

    def _require_personal(self):
        return None

    async def authorize(self, actor, personal_space_id, role):
        return {'id': personal_space_id, 'kind': 'personal'}

    async def _find_task_row(self, personal_space_id, task_id):
        return None

    async def _select_agents(self, actor, space, request):
        if self.selected_lead:
            selected = candidate(self.selected_lead)
            return (
                [selected],
                [selected],
                'exact_work_kind',
                ['exact work kind: verification'],
            )
        return (
            [],
            [],
            'explicit_new_agent',
            ['user explicitly requested recruitment'],
        )

    async def _explicit_collaborators(self, actor, space, request):
        return [candidate(agent_id) for agent_id in self.collaborators]

    async def _parallel_staffing_candidates(self, request, candidates, participants):
        return []

    async def get_project_agent_coordination_policy(
        self,
        actor,
        personal_space_id,
        personal_project_id,
    ):
        return SimpleNamespace(
            ask_before_recruitment=self.ask_before_recruitment,
            auto_reuse_previous_agent=True,
        )

    async def ensure_system_project_coordinator(self, actor, personal_space_id):
        self.side_effects.append('coordinator')
        return SimpleNamespace(
            agent_id='coordinator',
            profile=ProjectAgentProfile(
                name='Coordinator',
                responsibility='Coordinate project work.',
            ),
        )

    async def _open_recruitment(
        self,
        actor,
        space,
        request,
        task_id,
        coordinator_agent_id,
        reason_code,
        *,
        participant_role='lead',
        recruitment_slot=None,
    ):
        slot = recruitment_slot or 'lead'
        self.side_effects.append(f'recruitment:{participant_role}:{slot}')
        recruited = candidate(f'recruited-{slot}')
        return SimpleNamespace(
            recruitment_id=f'recruitment-{slot}',
            status='fulfilled',
            confirmation_mode='automatic',
            participant_role=participant_role,
            recruitment_slot=slot,
            hr_agent_id='hr-1',
            proposed_profile=recruited['profile'],
            position_kind='durable',
            reason=request.routing_reason,
            trigger_source_application=request.source_application,
            fulfilled_at=datetime.now(UTC),
        ), recruited

    async def _persist_task(self, request, **values):
        self.side_effects.append('persist')
        self.persisted.clear()
        self.persisted.update(values)

    async def get_project_agent_task(self, actor, personal_space_id, task_id):
        return SimpleNamespace(
            task_id=task_id,
            routing_outcome=self.persisted['routing_outcome'],
        )

    async def _route_assigned_agent(self, actor, request, task):
        return None

    def _route_result(
        self,
        task,
        recruitment,
        *,
        assigned_agent=None,
        recruitments=None,
    ):
        return SimpleNamespace(
            task=task,
            recruitment=recruitment,
            recruitments=list(recruitments or []),
        )


class AtomicSubmitDriver:
    def __init__(self, *, active_hr):
        self.active_hr = active_hr

    @asynccontextmanager
    async def transaction(self):
        yield self

    async def run(self, query, **parameters):
        rows, _, _ = await self.execute_query(query, **parameters)

        async def result():
            for row in rows:
                yield row

        return result()

    async def execute_query(self, query, **parameters):
        if 'RETURN project' in query:
            return ([{'project': {'project_id': 'project-a'}}], None, None)
        if 'RETURN hr' in query and self.active_hr:
            return ([{'hr': {'agent_id': 'hr-1'}}], None, None)
        return ([], None, None)


class RecruitmentDriver:
    async def execute_query(self, query, **parameters):
        if 'RETURN recruitment' in query:
            return ([], None, None)
        return ([{'hr': {'agent_id': 'hr-1'}}], None, None)
