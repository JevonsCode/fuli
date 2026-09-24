import asyncio
import json
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from fuli_graph.store_agent_loans import StoreAgentLoans


@pytest.mark.parametrize('revocation', ['assignment', 'client'])
def test_existing_lead_context_cannot_outlive_its_current_authority(monkeypatch, revocation):
    class Store(StoreAgentLoans):
        def _require_personal(self):
            pass
        async def authorize(self, *args):
            return {'id':'space'}
        async def get_task_context(self, *args):
            return {'personal_project_id':'project','project_agent_id':'lead'}
        async def get_project_agent_coordination_policy(self, *args):
            return SimpleNamespace(team_lead_agent_id='lead')
    async def authorize_agent(*args, **kwargs):
        assert kwargs['require_active']
        if revocation == 'assignment':
            raise HTTPException(404, 'Assignment ended')
        return {'profile_json':json.dumps({'allowed_clients':['claude_code']})}
    monkeypatch.setattr('fuli_graph.store_agent_loans.authorize_project_agent', authorize_agent)
    request = SimpleNamespace(personal_space_id='space', task_context_token='current', source_application='codex')
    with pytest.raises(HTTPException) as error:
        asyncio.run(Store()._loan_lead({},request))
    assert error.value.status_code == (404 if revocation == 'assignment' else 403)
