"""A blocked task says what, since when and where; its own session ends it."""

from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from fuli_graph.project_agent_attention_models import AgentAttentionDecision
from fuli_graph.project_agent_task_models import (
    ProjectAgentTaskActivityCreate,
    ProjectAgentTaskBlockerClear,
    ProjectAgentTaskEventRecord,
)
from fuli_graph.store_project_agent_attention import StoreProjectAgentAttention
from fuli_graph.store_project_agent_tasks import StoreProjectAgentTasks
from fuli_graph.task_blocker import current_blocker
from test_project_agent_tasks import ActivityStore

T0 = datetime(2026, 10, 27, 8, 0, tzinfo=UTC)
SESSION_A = '11111111-2222-4333-8444-555555555555'
SESSION_B = '66666666-7777-4888-9999-000000000000'


def event(status, minutes, summary='Synthetic progress.', **changes):
    return {
        'event_id': f'event-{status}-{minutes}', 'task_id': 'task-a', 'agent_id': 'agent-a',
        'status': status, 'actor_kind': 'agent', 'summary': summary,
        'source_application': 'codex', 'source_session_id': SESSION_A,
        'created_at': T0 + timedelta(minutes=minutes),
    } | changes


BLOCKED_ROWS = [
    event('running', 0),
    event('blocked', 5, 'Which staging database should the migration target?'),
    event('blocked', 9, 'Still need the staging database name.'),
]


def blocked_row(event_rows=BLOCKED_ROWS):
    return {
        'task': {'task_id': 'task-a', 'personal_project_id': 'project-a', 'status': 'blocked',
                 'revision': 3, 'result_summary': 'Still need the staging database name.'},
        'participant_rows': [{'agent_id': 'agent-a', 'role': 'lead'}],
        'event_rows': event_rows,
    }


def test_the_block_names_its_latest_reason_its_start_and_the_reporting_session():
    events = [ProjectAgentTaskEventRecord(**row) for row in BLOCKED_ROWS]
    blocker = current_blocker('blocked', events, 'stored summary')
    assert blocker.reason == 'Still need the staging database name.'
    assert blocker.since == T0 + timedelta(minutes=5)
    assert (blocker.source_application, blocker.source_session_id, blocker.agent_id) == (
        'codex', SESSION_A, 'agent-a')
    assert current_blocker('running', events, None) is None
    # Blocked before any event recorded it: the stored summary, no time, no session.
    legacy = current_blocker('blocked', events[:1], 'Waiting for credentials.')
    assert (legacy.reason, legacy.since, legacy.source_session_id) == ('Waiting for credentials.', None, None)


def activity(status, session_id, key):
    return ProjectAgentTaskActivityCreate(
        personal_space_id='personal-space', personal_project_id='project-a', task_id='task-a',
        idempotency_key=key, status=status, summary='Found the staging database; continuing.',
        agent_id='agent-a', source_application='codex', source_session_id=session_id,
    )


@pytest.mark.asyncio
async def test_the_blocking_session_moves_its_task_on_and_its_requests_leave_the_queue():
    store = ActivityStore(blocked_row(), event_rows=[{'task': {}, 'event': {}, 'same_payload': True,
                                                      'applied_transition': True}])
    await store.record_project_agent_task_activity({'id': 'principal'}, activity('running', SESSION_A, 'resume-a-1'))
    [(_, write)] = store.runtime.driver.event_calls
    assert write['status'] == 'running'
    [(query, closed)] = [call for call in store.runtime.driver.calls if 'FuliAgentAttention' in call[0]]
    assert "request.status = 'cancelled'" in query and "responded_by = 'system'" in query
    assert closed['task_id'] == 'task-a' and closed['kinds'] == ['blocked', 'question']


@pytest.mark.asyncio
async def test_another_session_cannot_unblock_the_task():
    store = ActivityStore(blocked_row())
    with pytest.raises(HTTPException, match='blocked -> running'):
        await store.record_project_agent_task_activity({'id': 'principal'}, activity('running', SESSION_B, 'resume-b-1'))
    assert store.runtime.driver.event_calls == []


class BlockerDriver:
    def __init__(self, candidates):
        self.candidates = candidates
        self.calls = []

    async def execute_query(self, query, **parameters):
        self.calls.append((query, parameters))
        if 'RETURN DISTINCT task.task_id' in query:
            return [{'task_id': task_id} for task_id in self.candidates], None, None
        return [], None, None

    @asynccontextmanager
    async def transaction(self):
        driver = self

        class Transaction:
            async def run(self, query, **parameters):
                await driver.execute_query(query, **parameters)

                async def rows():
                    for _ in ():
                        yield _
                return rows()
        yield Transaction()

    def writes(self, text):
        return [parameters for query, parameters in self.calls if text in query]


class BlockerStore(StoreProjectAgentTasks):
    def __init__(self, row, candidates=('task-a',)):
        self.row = row
        self.settings = SimpleNamespace(provider_id='provider', provider_mode='personal')
        self.runtime = SimpleNamespace(driver=BlockerDriver(list(candidates)))

    def _require_personal(self):
        return None

    async def authorize(self, actor, personal_space_id, role):
        return {'id': personal_space_id, 'kind': 'personal'}

    async def _find_task_row(self, personal_space_id, task_id, personal_project_id=None):
        return self.row


def clear(session_id, cause='session_reply'):
    return ProjectAgentTaskBlockerClear(personal_space_id='personal-space', source_application='codex',
                                        source_session_id=session_id, cause=cause)


@pytest.mark.asyncio
@pytest.mark.parametrize('cause', ['session_reply', 'session_activity'])
async def test_progress_in_the_blocking_session_clears_the_block_and_records_why(cause):
    store = BlockerStore(blocked_row())
    result = await store.clear_session_task_blockers({'id': 'principal'}, clear(SESSION_A, cause))
    assert result.cleared_task_ids == ['task-a']
    [lookup] = store.runtime.driver.writes('RETURN DISTINCT task.task_id')
    assert (lookup['application'], lookup['session_id']) == ('codex', SESSION_A)
    [cleared] = store.runtime.driver.writes('CREATE (event:FuliProjectAgentTaskEvent')
    assert cleared['cause'] == cause and cleared['session_id'] == SESSION_A
    assert cleared['agent_id'] == 'agent-a' and 'Unblocked automatically' in cleared['summary']
    [closed] = store.runtime.driver.writes('FuliAgentAttention')
    assert closed['response'] == cleared['summary']


@pytest.mark.asyncio
async def test_activity_in_another_session_leaves_the_block_in_place():
    store = BlockerStore(blocked_row())
    result = await store.clear_session_task_blockers({'id': 'principal'}, clear(SESSION_B))
    assert result.cleared_task_ids == []
    assert store.runtime.driver.writes('CREATE (event') == []
    assert store.runtime.driver.writes('FuliAgentAttention') == []


@pytest.mark.asyncio
async def test_a_task_that_already_left_blocked_is_not_cleared_again():
    row = blocked_row(BLOCKED_ROWS + [event('running', 12)])
    row['task']['status'] = 'running'
    store = BlockerStore(row)
    assert (await store.clear_session_task_blockers({'id': 'principal'}, clear(SESSION_A))).cleared_task_ids == []


class AttentionStore(StoreProjectAgentAttention):
    def __init__(self, raw):
        self.driver = SimpleNamespace(execute_query=AsyncMock(return_value=([{'request': raw}], None, None)))
        self.runtime = SimpleNamespace(driver=self.driver)
        self.authorize = AsyncMock(return_value={'id': 'personal-space'})
        self._clear_task_blocker = AsyncMock(return_value=True)

    def _require_personal(self):
        pass


def answered(**changes):
    return dict(request_id='request', personal_space_id='personal-space', personal_project_id='project-a',
                agent_id='agent-a', task_id='task-a', kind='blocked', title='Staging database',
                detail='The migration needs a target.', requested_action='Name the staging database',
                status='resolved', revision=1, response='Use staging-2', responded_by='human',
                created_at=T0, updated_at=T0) | changes


@pytest.mark.asyncio
@pytest.mark.parametrize(('changes', 'clears'), [
    ({}, True), ({'kind': 'question'}, True), ({'kind': 'approval'}, False), ({'task_id': None}, False),
])
async def test_answering_the_blocking_request_ends_the_block(monkeypatch, changes, clears):
    monkeypatch.setattr('fuli_graph.store_project_agent_attention.authorize_personal_project', AsyncMock())
    store = AttentionStore(answered(**changes))
    decision = AgentAttentionDecision(personal_space_id='personal-space', personal_project_id='project-a',
                                      request_id='request', expected_revision=0, response='Use staging-2')
    await store.decide_agent_attention({}, decision, human=True)
    if clears:
        store._clear_task_blocker.assert_awaited_once_with('personal-space', 'task-a', 'attention_answer')
    else:
        store._clear_task_blocker.assert_not_awaited()
    store._clear_task_blocker.reset_mock()
    # An Agent withdrawing its own request is not an answer.
    await store.decide_agent_attention({}, decision, human=False)
    store._clear_task_blocker.assert_not_awaited()
