"""Synthetic project ownership and reporting regressions."""

from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from fuli_graph.project_agent_context_models import ProjectAgentContextRequest
from fuli_graph.project_agent_coordination_models import ProjectAgentCoordinationPolicyUpdate
from test_project_agent_coordination_policy import PolicyStore
from test_project_agent_staffing import ContextStaffingStore, SelectionDriver, peer_assignment


class ReportingStore(ContextStaffingStore):
    def __init__(self, lead='lead', session_owner=None, include_lead=True):
        rows = [peer_assignment('member', work_kinds=['implementation'], capabilities=['coding'])]
        if include_lead:
            rows.append(peer_assignment('lead', work_kinds=['project_context'], capabilities=['planning']))
        super().__init__(SelectionDriver(rows, session_owner=session_owner))
        self.lead = lead

    async def get_project_agent_coordination_policy(self, *args):
        return SimpleNamespace(auto_reuse_previous_agent=True, team_lead_agent_id=self.lead,
                               team_member_agent_ids=['member'])


def request(**changes):
    return ProjectAgentContextRequest(personal_space_id='personal-space', personal_project_id='project-a',
                                      source_application='codex', work_kind='implementation', **changes)


@pytest.mark.asyncio
async def test_named_member_is_preserved_but_project_lead_owns_context():
    result = await ReportingStore().resolve_project_agent_context({'id': 'principal'}, request(agent_id='member'))
    assert result.agent.agent_id == 'lead'
    assert result.requested_agent_id == 'member'
    assert result.reason == 'project_lead_reporting'


def test_caller_supplied_reporting_lead_is_not_delegation_authority():
    with pytest.raises(ValidationError):
        request(agent_id='member', report_to_agent_id='lead')


@pytest.mark.asyncio
async def test_old_member_session_cannot_bypass_project_lead():
    result = await ReportingStore(session_owner='member').resolve_project_agent_context(
        {'id': 'principal'}, request(session_id='old-session', turn_id='turn'))
    assert result.agent.agent_id == 'lead'


@pytest.mark.asyncio
@pytest.mark.parametrize('agent_id', [None, 'member'])
async def test_existing_specialist_does_not_hide_a_missing_project_lead(agent_id):
    result = await ReportingStore(lead=None).resolve_project_agent_context({'id': 'principal'}, request(agent_id=agent_id))
    assert result.status == 'unassigned'
    assert result.reason == 'project_lead_required'
    assert result.agent is None


@pytest.mark.asyncio
async def test_missing_configured_lead_cannot_be_replaced_by_named_member():
    result = await ReportingStore(include_lead=False).resolve_project_agent_context({'id': 'principal'}, request(agent_id='member'))
    assert result.status == 'agent_unavailable'
    assert result.agent is None


@pytest.mark.asyncio
async def test_team_edit_cannot_clear_project_lead():
    store = PolicyStore({'team_lead_agent_id': 'lead', 'team_member_agent_ids': ['member']})
    with pytest.raises(HTTPException) as error:
        await store.update_project_agent_coordination_policy({'id': 'principal'}, ProjectAgentCoordinationPolicyUpdate(
            personal_space_id='personal-space', personal_project_id='activity-intake',
            team_lead_agent_id=None, team_member_agent_ids=[]))
    assert error.value.status_code == 422


# docs/workstreams.md: the owner of a workstream of this project runs the turn
# as itself, with its own memory and records; every other request still keeps
# the lead as owner (test_named_member_is_preserved_but_project_lead_owns_context).

@pytest.mark.asyncio
async def test_workstream_owner_runs_the_turn_as_itself():
    result = await ReportingStore().resolve_project_agent_context(
        {'id': 'principal'}, request(agent_id='member', workstream_owner=True))
    assert result.status == 'ready'
    assert result.agent.agent_id == 'member'
    assert result.reason == 'workstream_owner'
    # Not held by the lead and given no reporting line: the turn is the member's own.
    assert result.requested_agent_id is None
    assert result.reporting_lead_agent_id is None


@pytest.mark.asyncio
async def test_workstream_owner_session_is_the_owners_not_the_leads():
    # A session whose last task was the member's goes on as the member only
    # when the entry names the line again; without it the lead owns it.
    named = await ReportingStore(session_owner='member').resolve_project_agent_context(
        {'id': 'principal'}, request(agent_id='member', workstream_owner=True, session_id='s', turn_id='t'))
    plain = await ReportingStore(session_owner='member').resolve_project_agent_context(
        {'id': 'principal'}, request(session_id='s', turn_id='t'))
    assert (named.agent.agent_id, plain.agent.agent_id) == ('member', 'lead')


@pytest.mark.asyncio
async def test_workstream_owner_that_left_the_project_is_said_not_replaced():
    result = await ReportingStore().resolve_project_agent_context(
        {'id': 'principal'}, request(agent_id='former', workstream_owner=True))
    assert result.status == 'agent_unavailable'
    assert result.reason == 'workstream_owner_not_on_project'
    assert result.agent is None


@pytest.mark.asyncio
async def test_workstream_owner_outside_this_client_is_said_not_replaced():
    result = await ReportingStore().resolve_project_agent_context(
        {'id': 'principal'}, ProjectAgentContextRequest(
            personal_space_id='personal-space', personal_project_id='project-a', source_application='claude',
            work_kind='implementation', agent_id='member', workstream_owner=True))
    assert (result.status, result.reason, result.agent) == ('agent_unavailable', 'client_not_allowed', None)


@pytest.mark.asyncio
@pytest.mark.parametrize('changes', [{'agent_id': 'lead'}, {}, {'agent_id': 'member', 'delegation_token': 'x' * 40}])
async def test_workstream_owner_is_never_the_lead_nobody_or_a_delegated_turn(changes):
    with pytest.raises(HTTPException) as error:
        await ReportingStore().resolve_project_agent_context(
            {'id': 'principal'}, request(workstream_owner=True, **changes))
    assert error.value.status_code == 422


@pytest.mark.asyncio
async def test_workstream_owner_needs_the_project_lead_to_exist():
    result = await ReportingStore(lead=None).resolve_project_agent_context(
        {'id': 'principal'}, request(agent_id='member', workstream_owner=True))
    assert (result.status, result.reason) == ('unassigned', 'project_lead_required')
