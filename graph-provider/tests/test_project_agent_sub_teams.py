import json
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from fuli_graph.project_agent_coordination_models import (
    ProjectAgentCoordinationPolicyRecord, ProjectAgentCoordinationPolicyUpdate,
)
from test_project_agent_coordination_policy import PolicyStore


GROUP = {'id': 'backend', 'name': 'Backend', 'lead_agent_id': 'sub', 'member_agent_ids': ['member']}


def policy(**changes):
    return ProjectAgentCoordinationPolicyRecord(personal_space_id='personal-space',
        personal_project_id='activity-intake', team_lead_agent_id='lead',
        team_member_agent_ids=['sub', 'member', 'other'], **{'sub_teams': [GROUP], **changes})


def update(**changes):
    return ProjectAgentCoordinationPolicyUpdate(personal_space_id='personal-space',
        personal_project_id='activity-intake', **changes)


def test_legacy_policy_defaults_are_flat_without_changing_existing_members():
    value = policy(sub_teams=[])
    assert value.sub_teams == []
    assert value.sub_team_suggestion_threshold == 6
    assert value.team_member_agent_ids == ['sub', 'member', 'other']


@pytest.mark.parametrize('groups', [
    [GROUP, GROUP],
    [{**GROUP, 'member_agent_ids': ['member', 'member']}],
    [{**GROUP, 'member_agent_ids': ['sub']}],
    [GROUP, {'id': 'second', 'name': 'Second', 'lead_agent_id': 'other', 'member_agent_ids': ['member']}],
    [GROUP, {'id': 'second', 'name': 'Second', 'lead_agent_id': 'member', 'member_agent_ids': []}],
    [{**GROUP, 'lead_agent_id': 'lead'}],
    [{**GROUP, 'member_agent_ids': ['foreign']}],
    [{**GROUP, 'name': ' '}],
    [{**GROUP, 'id': 'x' * 129}],
])
def test_invalid_or_overlapping_groups_cannot_create_reporting_cycles(groups):
    with pytest.raises(ValidationError):
        update(team_lead_agent_id='lead', team_member_agent_ids=['sub', 'member', 'other'], sub_teams=groups)


@pytest.mark.asyncio
async def test_policy_roundtrip_and_legacy_partial_update_preserve_subteams():
    store = PolicyStore({'team_lead_agent_id': 'lead', 'team_member_agent_ids': ['sub', 'member'],
        'sub_teams_json': json.dumps([GROUP]), 'sub_team_suggestion_threshold': 9})
    saved = await store.update_project_agent_coordination_policy({'id': 'principal'}, update(auto_reuse_previous_agent=False))
    assert saved.sub_teams[0].lead_agent_id == 'sub'
    assert saved.sub_team_suggestion_threshold == 9
    write = next(parameters for query, parameters in store.runtime.driver.calls
                 if 'SET policy.ask_before_recruitment' in query)
    assert json.loads(write['sub_teams_json']) == [GROUP]


@pytest.mark.asyncio
async def test_removing_a_group_member_requires_an_atomic_layout_update():
    store = PolicyStore({'team_lead_agent_id': 'lead', 'team_member_agent_ids': ['sub', 'member'],
        'sub_teams_json': json.dumps([GROUP])})
    with pytest.raises(HTTPException) as error:
        await store.update_project_agent_coordination_policy({'id': 'principal'}, update(team_member_agent_ids=['sub']))
    assert error.value.status_code == 422
    assert not any('SET policy.ask_before_recruitment' in q for q, _ in store.runtime.driver.calls)
    saved = await store.update_project_agent_coordination_policy({'id': 'principal'}, update(team_member_agent_ids=['sub'], sub_teams=[]))
    assert saved.sub_teams == []


def test_direct_links_and_reporting_parent_are_project_local():
    from fuli_graph.project_agent_hierarchy import reporting_parent, direct_reporting_link
    grouped = policy()
    assert reporting_parent(grouped, 'member') == 'sub'
    assert reporting_parent(grouped, 'sub') == 'lead'
    assert reporting_parent(grouped, 'other') == 'lead'
    assert reporting_parent(grouped, 'lead') is None
    for sender, receiver in [('lead', 'sub'), ('sub', 'lead'), ('sub', 'member'), ('member', 'sub')]:
        assert direct_reporting_link(grouped, sender, receiver)
    for sender, receiver in [('lead', 'member'), ('member', 'lead'), ('member', 'other'), ('sub', 'other')]:
        assert not direct_reporting_link(grouped, sender, receiver)
    # Legacy bounded collaborators still work through the project lead.
    assert direct_reporting_link(policy(sub_teams=[]), 'lead', 'assigned-collaborator')


@pytest.mark.parametrize('threshold', [0, 33])
def test_suggestion_threshold_is_bounded(threshold):
    with pytest.raises(ValidationError):
        update(sub_team_suggestion_threshold=threshold)


@pytest.mark.asyncio
@pytest.mark.parametrize('state', ['ended', 'client', 'archived'])
async def test_grouped_coordinator_requires_its_current_assignment_and_source_client(state):
    from fuli_graph.project_agent_hierarchy import bind_task_coordinator
    from test_project_agent_tasks import task_request
    class SourceStore:
        async def get_task_context(self, *args):
            return {'project_agent_id': 'sub'}
        async def get_project_agent(self, *args):
            return SimpleNamespace(profile=SimpleNamespace(status='archived' if state == 'archived' else 'active',
                allowed_clients=['claude_code'] if state == 'client' else ['codex']),
                assignments=[SimpleNamespace(status='ended' if state == 'ended' else 'active',
                    personal_project_id='activity-intake')])
    with pytest.raises(HTTPException) as error:
        await bind_task_coordinator(SourceStore(), {}, task_request(task_context_token='current-sub'), policy())
    assert error.value.status_code == 403


class FlatOwnerStore:
    def __init__(self, owner):
        self.owner = owner

    async def get_task_context(self, *args):
        return {'project_agent_id': self.owner}


@pytest.mark.asyncio
@pytest.mark.parametrize('owner', ['lead', 'member'])
async def test_a_flat_team_dispatcher_coordinates_the_task_it_dispatches(owner):
    from fuli_graph.project_agent_hierarchy import bind_task_coordinator
    from test_project_agent_tasks import task_request
    # Without this the system coordinator took the task: the dispatcher's
    # context could not link it and its own task list never showed it.
    bound = await bind_task_coordinator(FlatOwnerStore(owner), {}, task_request(
        task_context_token='current', lead_agent_id='other'), policy(sub_teams=[]))
    assert bound.coordinator_agent_id == owner


@pytest.mark.asyncio
async def test_a_flat_team_coordinator_that_leaves_the_dispatcher_unaccountable_is_refused_before_writing():
    from fuli_graph.project_agent_hierarchy import bind_task_coordinator
    from test_project_agent_tasks import task_request
    flat = policy(sub_teams=[])
    with pytest.raises(HTTPException) as error:
        await bind_task_coordinator(FlatOwnerStore('member'), {}, task_request(
            task_context_token='current', lead_agent_id='other', coordinator_agent_id='lead'), flat)
    assert error.value.status_code == 403
    for owner, changes in [('lead', {'coordinator_agent_id': 'other'}),
                           ('member', {'coordinator_agent_id': 'lead', 'lead_agent_id': 'member'})]:
        request = task_request(task_context_token='current', **{'lead_agent_id': 'other', **changes})
        assert await bind_task_coordinator(FlatOwnerStore(owner), {}, request, flat) is request
    unowned = task_request(task_context_token='current')
    assert await bind_task_coordinator(FlatOwnerStore(None), {}, unowned, flat) is unowned


@pytest.mark.asyncio
async def test_automatic_staffing_enters_the_sublead_before_the_specialist():
    from test_project_agent_teams import TeamStore
    from test_project_agent_tasks import candidate, task_request
    class GroupedStore(TeamStore):
        async def get_project_agent_coordination_policy(self, *args):
            value = await super().get_project_agent_coordination_policy(*args)
            value.sub_teams = policy().sub_teams
            return value
    store = GroupedStore([candidate('lead', ['planning'], []), candidate('sub', ['planning'], []),
        candidate('member', ['verification'], ['test execution']), candidate('other', ['design'], [])],
        members=['sub', 'member', 'other'])
    selected, _, reason, _ = await store._select_agents({}, {}, task_request())
    assert selected[0]['agent_id'] == 'sub'
    assert reason == 'project_sub_team_lead'
    selected, _, reason, _ = await store._select_agents({}, {}, task_request(coordinator_agent_id='sub'))
    assert selected[0]['agent_id'] == 'member'
    assert reason == 'project_team_member'
    selected, _, reason, _ = await store._select_agents({}, {}, task_request(
        coordinator_agent_id='sub', work_kind='design', required_capabilities=[]))
    assert selected == []
    assert reason == 'project_sub_team_gap'
    from fuli_graph.store_project_agent_task_staffing import HOLD_RECRUITMENT_REASONS
    assert reason in HOLD_RECRUITMENT_REASONS
