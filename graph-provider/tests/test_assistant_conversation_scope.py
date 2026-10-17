"""The fixed assistant keeps a global conversation journal without reviewed memory."""
import json
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from fuli_graph.agent_conversation_models import ConversationQuery
from fuli_graph.store_agent_conversations import StoreAgentConversations


class TaskOnlyAgentDriver:
    async def execute_query(self, query, **parameters):
        agent = {'agent_id': parameters.get('agent_id'), 'status': 'active', 'memory_scope': 'task_only',
                 'profile_json': json.dumps({'allowed_clients': ['codex']})}
        return [{'agent': agent, 'assignment_id': 'a-1', 'agent_id': agent['agent_id']}], None, None


class Store(StoreAgentConversations):
    def __init__(self):
        self.runtime = SimpleNamespace(driver=TaskOnlyAgentDriver())

    def _require_personal(self):
        return None

    async def authorize(self, actor, space_id, role):
        return {'id': space_id}


def scope(agent_id, project_id=None):
    return ConversationQuery(personal_space_id='space', personal_project_id=project_id,
                             agent_id=agent_id, source_application='codex')


@pytest.mark.asyncio
async def test_the_assistant_global_journal_is_available():
    assert await Store()._conversation_scope({}, scope('employee.assistant'), write=True)


@pytest.mark.asyncio
async def test_other_task_only_agents_still_have_no_conversation_journal():
    with pytest.raises(HTTPException) as error:
        await Store()._conversation_scope({}, scope('temporary-agent'), write=True)
    assert error.value.status_code == 409


@pytest.mark.asyncio
async def test_the_assistant_gets_no_project_journal(monkeypatch):
    async def allow_project(*args, **kwargs):
        return None
    monkeypatch.setattr('fuli_graph.project_agent_access.authorize_personal_project', allow_project)
    with pytest.raises(HTTPException) as error:
        await Store()._conversation_scope({}, scope('employee.assistant', 'project-a'), write=True)
    assert error.value.status_code == 409
