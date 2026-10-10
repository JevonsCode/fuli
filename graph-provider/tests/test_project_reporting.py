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
