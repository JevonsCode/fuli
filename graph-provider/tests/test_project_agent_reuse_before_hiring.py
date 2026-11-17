"""Bole reuses an idle Agent of the occupation before hiring a new durable one."""

from types import SimpleNamespace

import pytest

from fuli_graph.project_agent_models import ProjectAgentProfile
from fuli_graph.project_agent_task_models import ProjectAgentTaskSubmit
from fuli_graph.store_project_agent_tasks import StoreProjectAgentTasks
from test_project_agent_parallel_recruitment import AtomicSubmitStore, candidate, task_request


def row(agent_id, occupation='testing', *, busy=0, capabilities=('test execution',), clients=('codex',)):
    profile = ProjectAgentProfile(
        name=agent_id, responsibility='Verify the synthetic project.',
        work_kinds=['verification'], capabilities=list(capabilities), allowed_clients=list(clients),
    )
    return {
        'agent_id': agent_id, 'occupation_role': occupation,
        'assignment_id': f'assignment-{agent_id}', 'responsibility': profile.responsibility,
        'work_kinds': ['verification'], 'capabilities': list(capabilities),
        'model_strategy_override': None, 'executor_policy_override': None, 'profile': profile,
        'assigned_at': '2026-11-01T00:00:00Z', 'active_task_count': busy, 'memory_revision': 0,
    }


def new_durable(**updates):
    values = {
        'personal_space_id': 'personal-space', 'personal_project_id': 'project-a',
        'idempotency_key': 'reuse-before-hiring', 'title': 'Verify the synthetic change',
        'objective': 'Verify the change independently.', 'work_kind': 'verification',
        'required_capabilities': ['test execution'], 'source_application': 'codex',
        'routing_reason': 'A second verifier is wanted.', 'staffing_intent': 'new_durable',
    }
    values.update(updates)
    return ProjectAgentTaskSubmit(**values)


class ReuseStore(StoreProjectAgentTasks):
    def __init__(self, rows, **policy):
        self.rows = rows
        self.policy = SimpleNamespace(**{'auto_reuse_previous_agent': True, 'sub_teams': [],
                                         'team_lead_agent_id': None, 'team_member_agent_ids': [], **policy})
        self.settings = SimpleNamespace(provider_id='provider', provider_mode='personal')

    async def _assignment_candidates(self, personal_space_id, personal_project_id, **_):
        return self.rows

    async def get_project_agent_coordination_policy(self, actor, personal_space_id, personal_project_id):
        return self.policy


async def select(store, request):
    selected, _, reason, basis = await store._select_agents({'id': 'principal'}, {'id': 'personal-space'}, request)
    return [item['agent_id'] for item in selected], reason, basis


@pytest.mark.asyncio
async def test_an_idle_agent_of_the_occupation_takes_a_request_for_a_new_one():
    store = ReuseStore([row('engineer', 'engineering'), row('busy-tester', busy=1), row('idle-tester'), row('later-tester')])

    selected, reason, basis = await select(store, new_durable())

    assert selected == ['idle-tester']
    assert reason == 'idle_same_occupation'
    assert basis == ['an idle testing Agent is already on this project; reused instead of recruiting']


@pytest.mark.asyncio
@pytest.mark.parametrize('rows, request_updates', [
    ([row('busy-tester', busy=2)], {}),
    ([row('engineer', 'engineering')], {}),
    # Hired before occupations were recorded: nothing says what it is.
    ([row('unlabelled', None)], {}),
    ([row('tester', capabilities=('reading',))], {}),
    # The Agent that asked for help is never its own answer.
    ([row('asker')], {'coordinator_agent_id': 'asker'}),
    # A fixed role is a peer, never the hire.
    ([row('employee.tonborg', capabilities=('test execution', 'fuli.employee:tonborg'))], {}),
    # An Agent this client cannot run is not a candidate at all.
    ([row('claude-only', clients=('claude_code',))], {}),
])
async def test_without_an_idle_agent_of_the_occupation_a_new_one_is_still_recruited(rows, request_updates):
    selected, reason, _ = await select(ReuseStore(rows), new_durable(**request_updates))

    assert selected == []
    assert reason == 'explicit_new_agent'


@pytest.mark.asyncio
async def test_a_project_that_wants_each_agent_picked_by_name_still_hires():
    # Explicit @Agent selection: Bole never picks an existing Agent by itself.
    selected, reason, _ = await select(ReuseStore([row('idle-tester')], auto_reuse_previous_agent=False), new_durable())

    assert (selected, reason) == ([], 'explicit_new_agent')


@pytest.mark.asyncio
@pytest.mark.parametrize('request_updates', [
    # The caller described the Agent it wants.
    {'recruitment_profile': ProjectAgentProfile(
        name='Release verifier', responsibility='Verify releases.', work_kinds=['verification'],
        capabilities=['test execution'], allowed_clients=['codex'])},
    # Tags name abilities the idle Agent was never hired for.
    {'recruitment_occupation': {'role': 'testing', 'tags': ['frontend']}},
])
async def test_a_request_that_names_the_agent_it_wants_still_hires(request_updates):
    selected, reason, _ = await select(ReuseStore([row('idle-tester')]), new_durable(**request_updates))

    assert (selected, reason) == ([], 'explicit_new_agent')


@pytest.mark.asyncio
async def test_the_occupation_asked_for_decides_not_the_work_kind():
    store = ReuseStore([row('tester'), row('designer', 'design')])

    selected, reason, _ = await select(store, new_durable(recruitment_occupation={'role': 'design', 'tags': []}))

    assert (selected, reason) == (['designer'], 'idle_same_occupation')


@pytest.mark.asyncio
async def test_a_work_kind_with_no_occupation_leaves_the_refusal_to_the_recruitment():
    selected, reason, _ = await select(ReuseStore([row('tester')]), new_durable(work_kind='gardening'))

    assert (selected, reason) == ([], 'explicit_new_agent')


@pytest.mark.asyncio
@pytest.mark.parametrize('intent, reason', [('temporary', 'explicit_temporary_agent'), ('default_lead', 'explicit_new_agent')])
async def test_only_a_request_for_a_new_durable_agent_is_answered_by_reuse(intent, reason):
    updates = {'staffing_intent': intent, **({'duration': 'one_off'} if intent == 'temporary' else {})}

    assert (await select(ReuseStore([row('tester'), row('lead', 'lead')]), new_durable(**updates)))[:2] == ([], reason)


@pytest.mark.asyncio
async def test_in_a_team_with_sub_teams_only_a_direct_report_of_the_asking_coordinator_is_reused():
    sub_team = SimpleNamespace(id='qa', name='QA', lead_agent_id='qa-lead', member_agent_ids=['qa-member'])
    policy = {'sub_teams': [sub_team], 'team_lead_agent_id': 'project-lead',
              'team_member_agent_ids': ['qa-lead', 'qa-member', 'direct-tester']}
    request = new_durable(coordinator_agent_id='project-lead')

    # The sub-team's member reports to its own lead: the project lead's request hires instead.
    assert (await select(ReuseStore([row('qa-member')], **policy), request))[:2] == ([], 'explicit_new_agent')
    assert (await select(ReuseStore([row('qa-member'), row('direct-tester')], **policy), request))[:2] == (
        ['direct-tester'], 'idle_same_occupation')


@pytest.mark.asyncio
async def test_a_reused_agent_leads_the_task_and_no_recruitment_is_opened():
    class Reusing(AtomicSubmitStore):
        async def _select_agents(self, actor, space, request):
            selected = candidate('idle-tester')
            return [selected], [selected], 'idle_same_occupation', ['an idle testing Agent is already on this project']

    store = Reusing(ask_before_recruitment=False, active_hr=True)

    result = await store.submit_project_agent_task(
        {'id': 'principal'}, task_request(idempotency_key='reuse-no-recruitment', staffing_intent='new_durable'))

    assert store.side_effects == ['coordinator', 'persist']
    assert result.recruitments == []
    assert [item['agent_id'] for item in store.persisted['participants']] == ['idle-tester']
    assert store.persisted['routing_reason'] == 'idle_same_occupation'
    assert store.persisted['routing_outcome'] == 'assigned_existing'
