from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest

from fuli_graph.project_agent_context_models import ProjectAgentContextRequest
from fuli_graph.project_agent_models import (
    ProjectAgentExecutorPolicy,
    ProjectAgentProfile,
    ProjectAgentRecord,
)
from fuli_graph.project_agent_task_models import ProjectAgentParallelPlan
from fuli_graph.store_project_agent_context import StoreProjectAgentContext
from test_project_agent_tasks import HistorySelectionStore, SelectionStore, candidate, task_request


class TeamStore(SelectionStore):
    def __init__(self, rows, *, lead='lead', members=('member',), history=None, **kwargs):
        super().__init__(rows, **kwargs)
        self.lead = lead
        self.members = list(members)
        self.history = history or {}

    async def get_project_agent_coordination_policy(self, *args):
        return SimpleNamespace(auto_reuse_previous_agent=self.auto_reuse_previous_agent,
            ask_before_recruitment=True, team_lead_agent_id=self.lead,
            team_member_agent_ids=self.members)

    async def _historical_agent_outcomes(self, *args):
        return self.history


def reproduction_store(**kwargs):
    return TeamStore([
        candidate('synthetic-lead', ['planning'], ['planning']),
        candidate('synthetic-specialist', ['verification'], ['test execution']),
    ], lead='synthetic-lead', members=['synthetic-specialist'], **kwargs)


@pytest.mark.asyncio
async def test_team_lead_remains_conversation_owner_across_work_kinds():
    store = TeamStore([candidate('outside', ['verification'], ['test execution']),
        candidate('lead', ['planning'], []), candidate('member', ['verification'], ['test execution'])])
    for kind in ['verification', 'design', 'project_context']:
        selected, candidates, reason, _ = await store._select_agents(
            {}, {}, task_request(work_kind=kind), conversation=True)
        assert selected[0]['agent_id'] == 'lead'
        assert {row['agent_id'] for row in candidates} == {'lead', 'member'}
        assert reason == 'project_team_lead'


@pytest.mark.asyncio
async def test_unqualified_lead_does_not_execute_work_a_member_is_qualified_for():
    selected, candidates, reason, basis = await reproduction_store()._select_agents(
        {}, {}, task_request())
    assert selected[0]['agent_id'] == 'synthetic-specialist'
    assert reason == 'project_team_member'
    assert [row['agent_id'] for row in candidates] == ['synthetic-specialist', 'synthetic-lead']
    assert basis[0] == ('project team lead synthetic-lead remains accountable; '
                        'selected the best-fitting team member')
    assert 'exact work kind: verification' in basis


@pytest.mark.asyncio
async def test_qualified_team_lead_executes_its_own_work():
    store = TeamStore([candidate('lead', ['verification'], ['test execution']),
        candidate('member', ['verification'], ['test execution'])])
    selected, _, reason, basis = await store._select_agents({}, {}, task_request())
    assert selected[0]['agent_id'] == 'lead'
    assert reason == 'project_team_lead'
    assert basis[0] == 'project team lead is the stable conversation owner and fits this work'


@pytest.mark.asyncio
async def test_lead_with_capability_but_no_work_kind_yields_to_exact_member():
    store = TeamStore([candidate('lead', ['planning'], ['test execution']),
        candidate('member', ['verification'], ['test execution'])])
    selected, _, reason, _ = await store._select_agents({}, {}, task_request())
    assert selected[0]['agent_id'] == 'member'
    assert reason == 'project_team_member'


@pytest.mark.asyncio
async def test_successful_history_reuses_the_specialist_among_equal_members():
    store = TeamStore([candidate('lead', ['planning'], ['planning']),
        candidate('member-a', ['verification'], ['test execution']),
        candidate('member-b', ['verification'], ['test execution'])],
        members=['member-a', 'member-b'],
        history={'member-b': {'participation_count': 2, 'completed_count': 2,
                              'failed_count': 0, 'cancelled_count': 0}})
    selected, _, reason, basis = await store._select_agents({}, {}, task_request())
    assert selected[0]['agent_id'] == 'member-b'
    assert reason == 'project_team_member'
    assert any(item.startswith('historical continuity for verification: 2 prior') for item in basis)


@pytest.mark.asyncio
async def test_unqualified_history_cannot_override_required_capabilities():
    store = TeamStore([candidate('lead', ['planning'], ['planning']),
        candidate('veteran', ['verification'], ['legacy scripts']),
        candidate('member', ['verification'], ['test execution'])],
        members=['veteran', 'member'],
        history={'veteran': {'participation_count': 9, 'completed_count': 9,
                             'failed_count': 0, 'cancelled_count': 0}})
    selected, _, reason, _ = await store._select_agents({}, {}, task_request())
    assert selected[0]['agent_id'] == 'member'
    assert reason == 'project_team_member'


@pytest.mark.asyncio
async def test_team_without_qualified_member_reports_a_gap_without_outside_reuse():
    store = TeamStore([candidate('outside', ['verification'], ['test execution']),
        candidate('lead', ['planning'], ['planning']), candidate('member', ['design'], ['visual review'])])
    selected, candidates, reason, basis = await store._select_agents({}, {}, task_request())
    assert selected == []
    assert reason == 'project_team_gap'
    assert {row['agent_id'] for row in candidates} == {'lead', 'member'}
    assert basis == ['project team lead lead remains accountable; no active team member fits '
                     'work kind verification with required capabilities: test execution']


@pytest.mark.asyncio
async def test_member_disabled_for_the_source_client_is_reported_unavailable():
    store = TeamStore([candidate('lead', ['planning'], ['planning']),
        candidate('member', ['verification'], ['test execution'], allowed_clients=['claude_code'])])
    selected, _, reason, basis = await store._select_agents(
        {}, {}, task_request(source_application='codex'))
    assert selected == []
    assert reason == 'agent_unavailable'
    assert basis[-1] == 'qualified team member is unavailable to source client: codex'


@pytest.mark.asyncio
async def test_explicit_lead_selection_stays_explicit_without_capability_claims():
    store = reproduction_store()
    store.runtime = SimpleNamespace(driver=AuthorizationDriver())
    selected, _, reason, basis = await store._select_agents(
        {'id': 'principal'}, {'id': 'personal-space', 'kind': 'personal'},
        task_request(lead_agent_id='synthetic-lead'))
    assert selected[0]['agent_id'] == 'synthetic-lead'
    assert reason == 'explicit_agent'
    assert basis == ['explicit Agent selected']


class TeamHistoryStore(HistorySelectionStore):
    """Reuse the shared history fixture under a configured team policy."""

    async def get_project_agent_coordination_policy(self, *args):
        return SimpleNamespace(auto_reuse_previous_agent=True, ask_before_recruitment=True,
            team_lead_agent_id='lead', team_member_agent_ids=['member'])


def busy(row, count):
    return {**row, 'active_task_count': count}


@pytest.mark.asyncio
async def test_equally_qualified_member_with_success_history_executes_instead_of_the_lead():
    store = TeamHistoryStore([candidate('lead', ['verification'], ['test execution']),
        candidate('member', ['verification'], ['test execution'])],
        {'member': {'participation_count': 3, 'completed_count': 3,
                    'failed_count': 0, 'cancelled_count': 0}})
    selected, _, reason, basis = await store._select_agents({}, {}, task_request())
    assert selected[0]['agent_id'] == 'member'
    assert reason == 'project_team_member'
    assert any(item.startswith('historical continuity for verification: 3 prior') for item in basis)
    owner, _, owner_reason, _ = await store._select_agents({}, {}, task_request(), conversation=True)
    assert owner[0]['agent_id'] == 'lead' and owner_reason == 'project_team_lead'


@pytest.mark.asyncio
async def test_equally_qualified_less_busy_member_executes_instead_of_a_busy_lead():
    store = TeamHistoryStore([busy(candidate('lead', ['verification'], ['test execution']), 4),
        busy(candidate('member', ['verification'], ['test execution']), 0)], {})
    selected, _, reason, _ = await store._select_agents({}, {}, task_request())
    assert selected[0]['agent_id'] == 'member'
    assert reason == 'project_team_member'
    owner, _, _, _ = await store._select_agents({}, {}, task_request(), conversation=True)
    assert owner[0]['agent_id'] == 'lead'


@pytest.mark.asyncio
async def test_member_with_completed_project_work_is_reused_without_same_kind_history():
    # The member executed earlier project tasks as task lead while the
    # configured lead coordinated them; continuity follows the executor.
    store = TeamHistoryStore([candidate('lead', ['verification'], ['test execution']),
        candidate('member', ['verification'], ['test execution'])], {}, project_history={
            'member': {'participation_count': 2, 'completed_count': 2, 'failed_count': 0,
                       'cancelled_count': 0, 'last_completed_at': '2026-10-01T10:00:00Z',
                       'last_task_at': '2026-10-01T10:00:00Z'}})
    selected, candidates, reason, basis = await store._select_agents({}, {}, task_request())
    assert selected[0]['agent_id'] == 'member'
    assert [row['agent_id'] for row in candidates] == ['member', 'lead']
    assert reason == 'project_team_member'
    assert 'last successful project lead continuity: 2 prior task(s), 2 completed' in basis
    owner, _, _, _ = await store._select_agents({}, {}, task_request(), conversation=True)
    assert owner[0]['agent_id'] == 'lead'


@pytest.mark.asyncio
async def test_project_history_cannot_override_fit_or_load_inside_the_team():
    history = {'member': {'participation_count': 5, 'completed_count': 5, 'failed_count': 0,
                          'cancelled_count': 0, 'last_completed_at': '2026-10-01T10:00:00Z',
                          'last_task_at': '2026-10-01T10:00:00Z'}}
    unfit = TeamHistoryStore([candidate('lead', ['verification'], ['test execution']),
        candidate('member', ['design'], ['test execution'])], {}, project_history=history)
    selected, _, reason, _ = await unfit._select_agents({}, {}, task_request())
    assert selected[0]['agent_id'] == 'lead' and reason == 'project_team_lead'
    busier = TeamHistoryStore([candidate('lead', ['verification'], ['test execution']),
        busy(candidate('member', ['verification'], ['test execution']), 3)], {}, project_history=history)
    selected, _, reason, _ = await busier._select_agents({}, {}, task_request())
    assert selected[0]['agent_id'] == 'lead' and reason == 'project_team_lead'
    context_work = TeamHistoryStore([candidate('lead', ['planning'], []),
        candidate('member', ['project_context'], [])], {}, project_history=history)
    selected, _, reason, _ = await context_work._select_agents(
        {}, {}, task_request(work_kind='project_context', required_capabilities=[]))
    assert selected[0]['agent_id'] == 'lead' and reason == 'project_team_lead'


@pytest.mark.asyncio
async def test_unavailable_team_lead_is_visible_instead_of_silent_replacement():
    store = TeamStore([candidate('member', ['verification'], ['test execution'])])
    selected, _, reason, _ = await store._select_agents({}, {}, task_request())
    assert selected == []
    assert reason == 'agent_unavailable'


@pytest.mark.asyncio
async def test_team_obeys_manual_mode_and_keeps_parallel_work_inside_roster():
    member = candidate('member', ['verification'], ['test execution'])
    store = TeamStore([member, candidate('outside', ['verification'], ['test execution'])], auto_reuse_previous_agent=False)
    selected, _, reason, _ = await store._select_agents({}, {}, task_request())
    assert selected == [] and reason == 'manual_agent_selection'
    request = task_request(parallel_plan={'enabled': True, 'conflict_free_scopes': True, 'reason': 'Independent team verification',
        'independent_verification': True, 'workstream_boundaries': ['lead integration', 'member verification']})
    participants = [{'agent_id': 'lead', 'role': 'lead'}]
    candidates = await store._parallel_staffing_candidates(request, [member], participants, team_only=True)
    assert [row['agent_id'] for row in candidates] == ['member']


class TeamSubmitStore(TeamStore):
    """Run the real submit/recruitment path over in-memory persistence."""

    def __init__(self, rows, *, executor_outcome=None, **kwargs):
        super().__init__(rows, **kwargs)
        self.runtime = SimpleNamespace(driver=SubmitDriver())
        self.recruitments = {}
        self.tasks = []
        if executor_outcome:
            async def resolve_project_agent_executor(actor, **values):
                self.executor_agent_id = values['agent_id']
                return {'outcome': executor_outcome, 'status': executor_outcome,
                        'selection_reason': 'no connected executor',
                        'blocked_reason': 'no connected executor',
                        'executor_policy': ProjectAgentExecutorPolicy().model_dump(mode='json')}
            self.resolve_project_agent_executor = resolve_project_agent_executor

    def _require_personal(self):
        return None

    async def authorize(self, actor, personal_space_id, role):
        return {'id': personal_space_id, 'kind': 'personal'}

    async def _find_task_row(self, personal_space_id, task_id):
        return None

    async def ensure_system_project_coordinator(self, actor, personal_space_id):
        return SimpleNamespace(agent_id='coordinator', profile=ProjectAgentProfile(
            name='Coordinator', responsibility='Coordinate project work.'))

    async def _get_recruitment(self, personal_space_id, recruitment_id):
        raw = self.recruitments.get(recruitment_id)
        return self._recruitment(raw) if raw else None

    async def _persist_recruitment(self, raw):
        self.recruitments.setdefault(raw['recruitment_id'], raw)

    async def _persist_task(self, request, **values):
        self.tasks.append(values)

    async def get_project_agent_task(self, actor, personal_space_id, task_id):
        return SimpleNamespace(task_id=task_id, lead_agent_id=self.tasks[-1]['lead_agent_id'])

    async def _route_assigned_agent(self, actor, request, task):
        return None

    def _route_result(self, task, recruitment, *, assigned_agent=None, recruitments=None):
        return SimpleNamespace(task=task, recruitment=recruitment)


class SubmitDriver:
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
            return [{'project': {'project_id': 'project-a'}}], None, None
        if 'RETURN hr' in query:
            return [{'hr': {'agent_id': 'hr-1'}}], None, None
        return [], None, None


class AuthorizationDriver(SubmitDriver):
    async def execute_query(self, query, **parameters):
        if 'RETURN project' in query:
            return [{'project': {'project_id': parameters['project_id']}}], None, None
        return [{'agent': {'agent_id': parameters['agent_id'], 'status': 'active'},
                 'assignment_id': f"assignment-{parameters['agent_id']}"}], None, None


@pytest.mark.asyncio
async def test_submit_makes_the_qualified_member_the_task_worker_without_recruiting():
    store = TeamSubmitStore([candidate('synthetic-lead', ['planning'], ['planning']),
        candidate('synthetic-specialist', ['verification'], ['test execution'])],
        lead='synthetic-lead', members=['synthetic-specialist'])
    await store.submit_project_agent_task({'id': 'principal'}, task_request())
    task = store.tasks[-1]
    assert task['lead_agent_id'] == 'synthetic-specialist'
    assert task['routing_reason'] == 'project_team_member'
    assert task['status'] == 'queued'
    assert [item['agent_id'] for item in task['participants']] == ['synthetic-specialist']
    # Accountability is persisted, not only explained: the project lead is
    # the task's coordinator (COORDINATED_BY) and its routing decision owner.
    assert task['coordinator_agent_id'] == 'synthetic-lead'
    assert task['decision'].coordinator_agent_id == 'synthetic-lead'
    assert store.recruitments == {}


@pytest.mark.asyncio
async def test_explicit_coordinator_choice_is_preserved_for_team_work():
    store = TeamSubmitStore([candidate('lead', ['planning'], ['planning']),
        candidate('member', ['verification'], ['test execution'])])
    store.runtime = SimpleNamespace(driver=AuthorizationDriver())
    await store.submit_project_agent_task({'id': 'principal'},
        task_request(coordinator_agent_id='member'))
    assert store.tasks[-1]['coordinator_agent_id'] == 'member'


@pytest.mark.asyncio
async def test_disabled_qualified_member_blocks_without_replacement_or_recruitment():
    store = TeamSubmitStore([candidate('lead', ['planning'], ['planning']),
        candidate('member', ['verification'], ['test execution'], allowed_clients=['claude_code'])])
    await store.submit_project_agent_task({'id': 'principal'}, task_request(source_application='codex'))
    task = store.tasks[-1]
    assert task['lead_agent_id'] is None
    assert task['routing_reason'] == 'agent_unavailable'
    assert task['status'] == 'blocked'
    assert task['routing_outcome'] == 'blocked'
    assert store.recruitments == {}
    # The configured project lead stays accountable for the blocked work.
    assert task['coordinator_agent_id'] == 'lead'
    assert task['decision'].coordinator_agent_id == 'lead'


def unavailable_member_team(*outside):
    return TeamSubmitStore([candidate('lead', ['planning'], ['planning']),
        candidate('member', ['verification'], ['test execution'], allowed_clients=['claude_code']),
        *(candidate(agent_id, ['verification'], ['test execution']) for agent_id in outside)])


def two_stream_plan():
    return ProjectAgentParallelPlan(enabled=True, independent_verification=True,
        conflict_free_scopes=True, reason='Independent verification paths.',
        workstream_boundaries=['API tests', 'UI tests'])


@pytest.mark.asyncio
async def test_explicit_coordinator_overrides_the_lead_for_a_blocked_member():
    store = unavailable_member_team()
    store.runtime = SimpleNamespace(driver=AuthorizationDriver())
    await store.submit_project_agent_task({'id': 'principal'},
        task_request(source_application='codex', coordinator_agent_id='member'))
    assert store.tasks[-1]['coordinator_agent_id'] == 'member'


@pytest.mark.asyncio
async def test_unavailable_member_never_borrows_outside_team_parallel_collaborators():
    store = unavailable_member_team('outside-a', 'outside-b')
    await store.submit_project_agent_task({'id': 'principal'},
        task_request(source_application='codex', parallel_plan=two_stream_plan()))
    task = store.tasks[-1]
    assert task['routing_reason'] == 'agent_unavailable' and task['status'] == 'blocked'
    assert task['lead_agent_id'] is None
    assert task['participants'] == []
    assert task['coordinator_agent_id'] == 'lead'
    assert store.recruitments == {}


@pytest.mark.asyncio
async def test_blocked_parallel_team_task_skips_count_validation_without_fallback():
    store = unavailable_member_team('outside-a')
    await store.submit_project_agent_task({'id': 'principal'},
        task_request(source_application='codex', parallel_plan=two_stream_plan()))
    task = store.tasks[-1]
    assert task['status'] == 'blocked' and task['participants'] == []
    assert store.recruitments == {}


@pytest.mark.asyncio
async def test_no_team_unavailable_match_keeps_system_coordinator():
    store = TeamSubmitStore([candidate('member', ['verification'], ['test execution'],
        allowed_clients=['claude_code'])], lead=None, members=[])
    await store.submit_project_agent_task({'id': 'principal'}, task_request(source_application='codex'))
    task = store.tasks[-1]
    assert task['routing_reason'] == 'agent_unavailable'
    assert task['coordinator_agent_id'] == 'coordinator'


@pytest.mark.asyncio
async def test_no_team_unavailable_parallel_match_is_saved_as_blocked():
    store = TeamSubmitStore([candidate('member', ['verification'], ['test execution'],
        allowed_clients=['claude_code'])], lead=None, members=[])
    await store.submit_project_agent_task({'id': 'principal'},
        task_request(source_application='codex', parallel_plan=two_stream_plan()))
    task = store.tasks[-1]
    assert task['status'] == 'blocked'
    assert task['routing_reason'] == 'agent_unavailable'
    assert task['coordinator_agent_id'] == 'coordinator'
    assert task['participants'] == []
    assert store.recruitments == {}


@pytest.mark.asyncio
async def test_parallel_team_work_keeps_the_qualified_member_as_lead_and_the_roster_closed():
    store = TeamSubmitStore([candidate('outside', ['verification'], ['test execution']),
        candidate('lead', ['planning'], ['planning']),
        candidate('member-a', ['verification'], ['test execution']),
        candidate('member-b', ['verification'], ['test execution'])],
        members=['member-a', 'member-b'])
    plan = ProjectAgentParallelPlan(enabled=True, independent_verification=True,
        conflict_free_scopes=True, reason='Independent verification paths.',
        workstream_boundaries=['API tests', 'UI tests'])
    await store.submit_project_agent_task({'id': 'principal'}, task_request(parallel_plan=plan))
    task = store.tasks[-1]
    assert [(item['agent_id'], item['role']) for item in task['participants']] == [
        ('member-a', 'lead'), ('member-b', 'collaborator')]
    assert task['coordinator_agent_id'] == 'lead'
    assert store.recruitments == {}


@pytest.mark.asyncio
async def test_team_gap_opens_one_hr_proposal_that_respects_confirmation_policy():
    store = TeamSubmitStore([candidate('lead', ['planning'], ['planning'])], members=[])
    for _ in range(2):
        # Repeating the same task key reuses the stable recruitment identity.
        await store.submit_project_agent_task({'id': 'principal'}, task_request())
    task = store.tasks[-1]
    assert task['lead_agent_id'] is None
    assert task['status'] == 'awaiting_recruitment'
    assert task['routing_outcome'] == 'recruitment_required'
    assert task['routing_reason'] == 'project_team_gap'
    assert task['coordinator_agent_id'] == 'lead'
    assert len(store.recruitments) == 1
    recruitment = next(iter(store.recruitments.values()))
    assert recruitment['status'] == 'awaiting_confirmation'
    assert recruitment['reason_code'] == 'project_team_gap'
    assert recruitment['required_capabilities'] == ['test execution']


@pytest.mark.asyncio
async def test_member_without_an_actual_executor_blocks_the_task():
    store = TeamSubmitStore([candidate('lead', ['planning'], ['planning']),
        candidate('member', ['verification'], ['test execution'])], executor_outcome='blocked')
    await store.submit_project_agent_task({'id': 'principal'}, task_request())
    task = store.tasks[-1]
    assert store.executor_agent_id == 'member'
    assert task['status'] == 'blocked'
    assert task['routing_outcome'] == 'blocked'


class TeamContextStore(StoreProjectAgentContext, TeamStore):
    def __init__(self, rows, **kwargs):
        super().__init__(rows, **kwargs)
        self.runtime = SimpleNamespace(driver=SubmitDriver())

    def _require_personal(self):
        return None

    async def authorize(self, actor, personal_space_id, role):
        return {'id': personal_space_id, 'kind': 'personal'}

    async def get_project_agent(self, actor, personal_space_id, personal_project_id, agent_id):
        row = next(item for item in self.rows if item['agent_id'] == agent_id)
        return ProjectAgentRecord(agent_id=agent_id, personal_space_id=personal_space_id,
            personal_project_id=personal_project_id, profile=row['profile'],
            created_at='2026-08-17T00:00:00Z', updated_at='2026-08-17T00:00:00Z')


def context_request(**changes):
    return ProjectAgentContextRequest(personal_space_id='personal-space', personal_project_id='project-a',
        work_kind='verification', required_capabilities=['test execution'], **changes)


@pytest.mark.asyncio
async def test_task_entry_keeps_the_lead_but_does_not_claim_execution_is_staffed():
    store = TeamContextStore([candidate('lead', ['planning'], ['planning']),
        candidate('member', ['verification'], ['test execution'])])
    result = await store.resolve_project_agent_context({'id': 'principal'}, context_request())
    assert result.status == 'ready'
    assert result.agent.agent_id == 'lead'
    assert result.reason == 'project_team_lead'
    assert result.worker_started is False
    assert result.execution_reason == 'project_team_member'
    assert result.execution_agent_id == 'member'
    assert any('coordinate_project_agent_task' in item and 'member' in item
               for item in result.match_basis)


@pytest.mark.asyncio
async def test_task_entry_routes_a_team_gap_to_existing_recruitment():
    store = TeamContextStore([candidate('lead', ['planning'], ['planning'])], members=[])
    result = await store.resolve_project_agent_context({'id': 'principal'}, context_request())
    assert result.agent.agent_id == 'lead'
    assert result.execution_reason == 'project_team_gap'
    assert result.execution_agent_id is None
    assert any('HR recruitment' in item for item in result.match_basis)


@pytest.mark.asyncio
async def test_task_entry_unavailable_member_guidance_never_recommends_recruitment():
    store = TeamContextStore([candidate('lead', ['planning'], ['planning']),
        candidate('member', ['verification'], ['test execution'], allowed_clients=['claude_code'])])
    result = await store.resolve_project_agent_context(
        {'id': 'principal'}, context_request(source_application='codex'))
    assert result.agent.agent_id == 'lead'
    assert result.worker_started is False
    assert result.execution_reason == 'agent_unavailable'
    assert result.execution_agent_id is None
    guidance = result.match_basis[-1]
    assert guidance.startswith('Execution is not staffed: a qualified or configured Agent is unavailable')
    assert 'Do not recruit a replacement' in guidance
    assert not any('HR recruitment' in item for item in result.match_basis)


@pytest.mark.asyncio
async def test_task_entry_reports_nothing_extra_when_the_lead_fits():
    store = TeamContextStore([candidate('lead', ['verification'], ['test execution'])], members=[])
    result = await store.resolve_project_agent_context({'id': 'principal'}, context_request())
    assert result.agent.agent_id == 'lead'
    assert result.execution_reason == 'project_team_lead'
    assert result.execution_agent_id == 'lead'
    assert not any('coordinate_project_agent_task' in item for item in result.match_basis)


@pytest.mark.asyncio
async def test_migrated_lead_delegates_even_with_legacy_implementation_capabilities():
    lead = candidate('lead', ['implementation'], ['coding'])
    lead['occupation_role'] = 'lead'
    store = TeamStore([lead, candidate('member', ['implementation'], ['coding'])])
    selected, _, reason, _ = await store._select_agents({}, {}, task_request(
        work_kind='implementation', required_capabilities=['coding']))
    assert selected[0]['agent_id'] == 'member'
    assert reason == 'project_team_member'
