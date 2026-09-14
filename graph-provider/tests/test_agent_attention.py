from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock
import hashlib
import json

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from fuli_graph.project_agent_attention_models import AgentAttentionCreate, AgentAttentionDecision
from fuli_graph.project_agent_names import agent_display_name
from fuli_graph.store_project_agent_attention import StoreProjectAgentAttention


def test_names_are_stable_and_keep_custom_names_and_explicit_overrides():
    assert agent_display_name('agent-a', '前端工程师') == agent_display_name('agent-a', '测试工程师')
    assert agent_display_name('agent-a', '前端工程师') != agent_display_name('agent-b', '前端工程师')
    assert agent_display_name('employee.bole', 'Bole') == 'Bole'
    assert agent_display_name('custom', 'Lumi') == 'Lumi'
    assert agent_display_name('custom', '测试工程师', 'My Name') == 'My Name'
    assert agent_display_name('fuli-project-coordinator', '项目协调人') == 'Orion'
    # Identity migration, not a nickname override, unifies the built-in HR.
    assert agent_display_name('fuli-project-hr', '伯乐') == '伯乐'
    assert agent_display_name('fuli-project-hr', '伯乐', 'Custom') == 'Custom'
    assert agent_display_name('agent-a', 'Release Verifier') == agent_display_name('agent-a', '前端工程师')
    assert agent_display_name('agent-a', '报表需求记录员') == agent_display_name('agent-a', '前端工程师')


def test_attention_requires_human_action_not_generic_work_status():
    base = dict(personal_space_id='space', personal_project_id='project', agent_id='agent',
                idempotency_key='request-1', kind='question', title='Choice', detail='Two targets', requested_action='Choose a target')
    assert AgentAttentionCreate(**base).kind == 'question'
    for changes in ({'kind': 'running'}, {'requested_action': ' '}, {'personal_project_id': ''}, {'human': True}):
        with pytest.raises(ValidationError):
            AgentAttentionCreate(**(base | changes))


class Store(StoreProjectAgentAttention):
    def __init__(self, rows):
        self.driver = SimpleNamespace(execute_query=AsyncMock(return_value=(rows, None, None)))
        self.runtime = SimpleNamespace(driver=self.driver)
        self.authorize = AsyncMock(return_value={'id': 'space'})
    def _require_personal(self):
        pass


def raw_request(**changes):
    return dict(request_id='request', personal_space_id='space', personal_project_id='project',
                agent_id='agent', kind='question', title='Choice', detail='Two targets',
                requested_action='Choose a target', status='resolved', revision=1,
                response='A', responded_by='human', created_at=datetime.now(UTC), updated_at=datetime.now(UTC)) | changes


@pytest.mark.asyncio
async def test_human_reply_and_agent_withdrawal_are_separate_and_compare_revisions(monkeypatch):
    authorize_project = AsyncMock()
    monkeypatch.setattr('fuli_graph.store_project_agent_attention.authorize_personal_project', authorize_project)
    request = AgentAttentionDecision(personal_space_id='space', personal_project_id='project', request_id='request', expected_revision=0, response='A')
    store = Store([{'request': raw_request()}])
    reply = await store.decide_agent_attention({}, request, human=True)
    assert reply.responded_by == 'human'
    query, = store.driver.execute_query.call_args.args
    params = store.driver.execute_query.call_args.kwargs
    assert query.index('SET request.lock_version') < query.index('WHERE request.revision')
    assert params['project_id'] == 'project'
    assert params['status'] == 'resolved'
    await store.decide_agent_attention({}, request, human=False)
    assert store.driver.execute_query.call_args.kwargs['status'] == 'cancelled'
    assert store.driver.execute_query.call_args.kwargs['responded_by'] == 'agent'
    store.driver.execute_query.return_value = ([], None, None)
    with pytest.raises(HTTPException) as exc:
        await store.decide_agent_attention({}, request, human=True)
    assert exc.value.status_code == 409


@pytest.mark.asyncio
async def test_counts_cover_full_set_not_only_page():
    store = Store([{'items': [raw_request(status='open')], 'total': 201, 'open_agents': ['agent'] * 201}])
    result = await store.list_agent_attention({}, 'space', limit=1)
    assert result.total == 201 and result.counts == {'agent': 201}
    assert len(result.items) == 1
    assert store.driver.execute_query.call_args.kwargs['space_id'] == 'space'


@pytest.mark.asyncio
async def test_request_scope_and_idempotency_are_checked_before_return(monkeypatch):
    authorize_agent = AsyncMock()
    monkeypatch.setattr('fuli_graph.store_project_agent_attention.authorize_project_agent', authorize_agent)
    request = AgentAttentionCreate(personal_space_id='space', personal_project_id='project', agent_id='agent', idempotency_key='request-1', kind='review', title='Review', detail='Changes are ready', requested_action='Review the changes')
    fingerprint = hashlib.sha256(json.dumps(request.model_dump(exclude={'idempotency_key'}), sort_keys=True).encode()).hexdigest()
    store = Store([{'request': raw_request(fingerprint=fingerprint)}])
    store.settings = SimpleNamespace(provider_id='provider')
    await store.create_agent_attention({}, request)
    assert authorize_agent.call_args.args[3:5] == ('project', 'agent')
    assert authorize_agent.call_args.kwargs['require_active'] is True
    first_id = store.driver.execute_query.call_args.kwargs['request_id']
    await store.create_agent_attention({}, request)
    assert store.driver.execute_query.call_args.kwargs['request_id'] == first_id
    store.driver.execute_query.return_value = ([{'request': raw_request(fingerprint='different')}], None, None)
    with pytest.raises(HTTPException) as conflict:
        await store.create_agent_attention({}, request)
    assert conflict.value.status_code == 409
    authorize_agent.side_effect = HTTPException(status_code=404, detail='not assigned')
    store.driver.execute_query.reset_mock()
    with pytest.raises(HTTPException):
        await store.create_agent_attention({}, request)
    store.driver.execute_query.assert_not_called()
