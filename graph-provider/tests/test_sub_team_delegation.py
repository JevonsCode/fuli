from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from fuli_graph.project_agent_delegations import AgentDelegationIssue, StoreAgentDelegations
from test_project_agent_sub_teams import policy


class DelegationStore(StoreAgentDelegations):
    def __init__(self, sender):
        self.sender = sender
        self.settings = SimpleNamespace(provider_mode='personal')
        async def query(sql, **parameters):
            return ([{'project': {'project_id': 'project'}}] if 'RETURN project' in sql else [], None, None)
        self.runtime = SimpleNamespace(driver=SimpleNamespace(execute_query=AsyncMock(side_effect=query)))

    def _require_personal(self):
        pass

    async def authorize(self, *args):
        return {'id': 'space', 'kind': 'personal'}

    async def get_task_context(self, *args):
        return {'personal_project_id': 'project', 'project_agent_id': self.sender}

    async def get_project_agent_coordination_policy(self, *args):
        return policy()

    async def get_project_agent(self, *args):
        return SimpleNamespace(profile=SimpleNamespace(status='active', allowed_clients=['codex']),
            assignments=[SimpleNamespace(status='active', personal_project_id='project')])


@pytest.mark.asyncio
@pytest.mark.parametrize('sender,target,allowed', [
    ('lead', 'sub', True), ('sub', 'lead', True),
    ('sub', 'member', True), ('member', 'sub', True),
    ('lead', 'member', False), ('member', 'lead', False),
    ('other', 'member', False), ('sub', 'other', False),
])
async def test_capability_issue_uses_only_adjacent_project_reporting_links(sender, target, allowed):
    store = DelegationStore(sender)
    # This test uses an offline authorization port; it never creates a real task.
    request = AgentDelegationIssue(personal_space_id='space', task_context_token='synthetic-token',
        source_application='codex', agent_id=target, target_application='codex')
    if allowed:
        result = await store.issue_agent_delegation({'id': 'principal'}, request)
        assert len(result['token']) >= 32
    else:
        with pytest.raises(HTTPException) as error:
            await store.issue_agent_delegation({'id': 'principal'}, request)
        assert error.value.status_code == 403
        assert not any('CREATE (:FuliAgentDelegation' in c.args[0]
                       for c in store.runtime.driver.execute_query.call_args_list)


@pytest.mark.asyncio
async def test_cross_project_root_uses_the_target_project_role_even_if_it_is_a_source_grandchild():
    class CrossProjectStore(DelegationStore):
        async def get_project_agent_coordination_policy(self, *args):
            if args[-1] == 'other-project':
                return SimpleNamespace(team_lead_agent_id='member', sub_teams=[], updated_at=None)
            return policy()
    store = CrossProjectStore('lead')
    request = AgentDelegationIssue(personal_space_id='space', task_context_token='synthetic-token',
        source_application='codex', agent_id='member', target_application='codex',
        target_personal_project_id='other-project')
    assert len((await store.issue_agent_delegation({'id': 'principal'}, request))['token']) >= 32
