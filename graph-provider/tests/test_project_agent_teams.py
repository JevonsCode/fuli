from types import SimpleNamespace
import pytest
from test_project_agent_tasks import SelectionStore, candidate, task_request


class TeamStore(SelectionStore):
    async def get_project_agent_coordination_policy(self, *args):
        return SimpleNamespace(auto_reuse_previous_agent=self.auto_reuse_previous_agent,
            team_lead_agent_id='lead', team_member_agent_ids=['member'])

    async def _historical_agent_outcomes(self, *args):
        return {}


@pytest.mark.asyncio
async def test_team_lead_remains_conversation_owner_across_work_kinds():
    store = TeamStore([candidate('outside', ['verification'], ['test execution']),
        candidate('lead', ['planning'], []), candidate('member', ['verification'], ['test execution'])])
    for kind in ['verification', 'design', 'project_context']:
        selected, candidates, reason, _ = await store._select_agents({}, {}, task_request(work_kind=kind))
        assert selected[0]['agent_id'] == 'lead'
        assert {row['agent_id'] for row in candidates} == {'lead', 'member'}
        assert reason == 'project_team_lead'


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
