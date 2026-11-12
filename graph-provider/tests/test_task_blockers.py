"""A blocked task says what, since when and where; its own session, its Agents or the person end it."""

from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from typing import Annotated
from unittest.mock import AsyncMock

import pytest
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.testclient import TestClient

from fuli_graph.project_agent_attention_models import AgentAttentionDecision
from fuli_graph.project_agent_routes import register_project_agent_routes
from fuli_graph.project_agent_task_models import (
    ProjectAgentTaskActivityCreate,
    ProjectAgentTaskBlockerClear,
    ProjectAgentTaskBlockerPersonClear,
    ProjectAgentTaskBlockerProgress,
    ProjectAgentTaskBlockerProgressResult,
    ProjectAgentTaskEventRecord,
)
from fuli_graph.store_project_agent_attention import StoreProjectAgentAttention
from fuli_graph.store_project_agent_task_reads import StoreProjectAgentTaskReads
from fuli_graph.store_project_agent_tasks import StoreProjectAgentTasks
from fuli_graph.task_blocker import PERSON_CLEAR_SUMMARY, PERSON_CONFIRM_SUMMARY, current_blocker
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
@pytest.mark.parametrize('status', ['running', 'queued', 'completed'])
async def test_another_session_cannot_unblock_the_task_and_is_told_how(status):
    store = ActivityStore(blocked_row())
    with pytest.raises(HTTPException, match=f'blocked -> {status}') as refused:
        await store.record_project_agent_task_activity({'id': 'principal'}, activity(status, SESSION_B, 'resume-b-1'))
    assert store.runtime.driver.event_calls == []
    # rec#123: the refusal names the step that does end the block, within what the Agent sees.
    detail = refused.value.detail
    assert 'run_delegated_action' in detail and 'blocker/clear route' in detail and 'params.taskId' in detail
    assert ':' not in detail and len(detail) <= 240


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
        self.project_reads = getattr(self, 'project_reads', []) + [personal_project_id]
        return self.row

    async def get_project_agent_task(self, actor, personal_space_id, task_id, **options):
        return {'task_id': task_id, 'read_as': actor, **options}


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
    assert cleared['actor_kind'] == 'system'
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


# The person's 「标记为已解除」: a session that will never continue leaves its
# block in place, so the person ends it from the console.
PERSON = {'id': 'principal', '_human_review_verified': True}


def person_clear(note=None, project='project-a'):
    return ProjectAgentTaskBlockerPersonClear(personal_space_id='personal-space', personal_project_id=project,
                                              note=note)


@pytest.mark.asyncio
async def test_the_person_marks_a_block_cleared_and_history_keeps_who_when_and_their_note():
    store = BlockerStore(blocked_row())
    task = await store.clear_task_blocker_by_person(PERSON, 'task-a', person_clear('Solved it by hand.'))
    assert task == {'task_id': 'task-a', 'read_as': PERSON, 'personal_project_id': 'project-a'}
    assert set(store.project_reads) == {'project-a'}
    [cleared] = store.runtime.driver.writes('CREATE (event:FuliProjectAgentTaskEvent')
    assert (cleared['cause'], cleared['actor_kind'], cleared['summary']) == ('person', 'human', 'Solved it by hand.')
    # Whichever session reported the block; the clear claims none.
    assert (cleared['application'], cleared['session_id']) == (None, None)
    [move] = [query for query, _ in store.runtime.driver.calls if 'CREATE (event:FuliProjectAgentTaskEvent' in query]
    assert "SET task.status = 'running'" in move and "participant.status = 'running'" in move
    [closed] = store.runtime.driver.writes('FuliAgentAttention')
    assert closed['response'] == 'Solved it by hand.' and closed['kinds'] == ['blocked', 'question']


@pytest.mark.asyncio
async def test_without_a_note_the_clear_says_the_person_did_it():
    store = BlockerStore(blocked_row())
    await store.clear_task_blocker_by_person(PERSON, 'task-a', person_clear())
    [cleared] = store.runtime.driver.writes('CREATE (event:FuliProjectAgentTaskEvent')
    assert cleared['summary'] == PERSON_CLEAR_SUMMARY


@pytest.mark.asyncio
async def test_only_the_human_review_channel_marks_a_block_cleared():
    store = BlockerStore(blocked_row())
    for actor in ({'id': 'principal'}, {'id': 'principal', '_human_review_verified': 'yes'}):
        with pytest.raises(HTTPException) as refused:
            await store.clear_task_blocker_by_person(actor, 'task-a', person_clear('Agent says done.'))
        assert refused.value.status_code == 403
    assert store.runtime.driver.calls == []


@pytest.mark.asyncio
async def test_a_task_that_is_not_blocked_or_not_found_is_refused_without_a_write():
    row = blocked_row(BLOCKED_ROWS + [event('running', 12)])
    row['task']['status'] = 'running'
    store = BlockerStore(row)
    with pytest.raises(HTTPException) as stale:
        await store.clear_task_blocker_by_person(PERSON, 'task-a', person_clear())
    assert stale.value.status_code == 409
    missing = BlockerStore(None)
    with pytest.raises(HTTPException) as absent:
        await missing.clear_task_blocker_by_person(PERSON, 'task-a', person_clear(project='project-b'))
    assert absent.value.status_code == 404
    assert store.runtime.driver.writes('CREATE (event') == missing.runtime.driver.writes('CREATE (event') == []


def test_the_task_history_reads_the_persons_note_but_not_a_system_summary():
    rows = BLOCKED_ROWS + [
        event('running', 12, 'Solved it by hand.', actor_kind='human', blocker_cleared_by='person',
              source_application=None, source_session_id=None),
        event('blocked', 20),
        event('running', 25, PERSON_CLEAR_SUMMARY, actor_kind='human', blocker_cleared_by='person'),
        event('blocked', 30),
        event('running', 35, 'Unblocked automatically: x', actor_kind='system', blocker_cleared_by='session_reply'),
    ]
    events = StoreProjectAgentTaskReads._events_from_row({'event_rows': rows})
    assert [(item.blocker_cleared_by, item.blocker_clear_note) for item in events if item.blocker_cleared_by] == [
        ('person', 'Solved it by hand.'), ('person', None), ('session_reply', None)]


def test_the_console_route_takes_only_the_human_review_actor():
    async def actor():
        return {'id': 'principal'}

    async def human(x_fuli_human_review_token: Annotated[str | None, Header()] = None):
        if x_fuli_human_review_token != 'synthetic-proof':
            raise HTTPException(403, 'independent human review proof required')
        return {'id': 'principal', '_human_review_verified': True}

    calls = []

    async def clear_task_blocker_by_person(actor_value, task_id, request):
        calls.append((actor_value, task_id, request.note))
        return {'task_id': task_id, 'title': 'Synthetic', 'status': 'running'}

    app = FastAPI()
    store = SimpleNamespace(clear_task_blocker_by_person=clear_task_blocker_by_person)
    register_project_agent_routes(app, store, Annotated[dict, Depends(actor)], Annotated[dict, Depends(human)])
    client = TestClient(app)
    body = {'personal_space_id': 'personal-space', 'personal_project_id': 'project-a', 'note': 'Done.'}
    assert client.post('/v1/project-agent-tasks/task-a/blocker/clear', json=body).status_code == 403
    assert calls == []


# Evidence from another session (graph 19). The task's lead saying the task
# moves on is the Agent's word and ends the block; other work by one of its
# Agents only marks it probably resolved, for the person to confirm.
def lead_row(**task_changes):
    row = blocked_row()
    row['task'] = row['task'] | {'lead_agent_id': 'agent-a'} | task_changes
    return row


APPLIED = [{'task': {}, 'event': {}, 'same_payload': True, 'applied_transition': True}]


@pytest.mark.asyncio
async def test_the_lead_moves_its_task_on_from_another_session_and_the_event_says_an_agent_resolved_it():
    store = ActivityStore(lead_row(), event_rows=APPLIED)
    await store.record_project_agent_task_activity({'id': 'principal'}, activity('running', SESSION_B, 'resume-b-2'))
    [(_, write)] = store.runtime.driver.event_calls
    assert (write['status'], write['blocker_cleared_by'], write['source_session_id']) == ('running', 'agent', SESSION_B)
    [closed] = [call[1] for call in store.runtime.driver.calls if 'FuliAgentAttention' in call[0]]
    assert closed['task_id'] == 'task-a'


@pytest.mark.asyncio
async def test_the_blocking_sessions_own_report_is_not_marked_as_a_clear():
    store = ActivityStore(lead_row(), event_rows=APPLIED)
    await store.record_project_agent_task_activity({'id': 'principal'}, activity('running', SESSION_A, 'resume-a-2'))
    [(_, write)] = store.runtime.driver.event_calls
    assert write['blocker_cleared_by'] is None


def hint(minutes, session=SESSION_B, application='codex'):
    return {'blocker_hint_agent_id': 'agent-a', 'blocker_hint_source_application': application,
            'blocker_hint_source_session_id': session, 'blocker_hint_at': T0 + timedelta(minutes=minutes)}


def test_work_after_the_latest_report_in_another_session_is_a_probable_resolution():
    events = [ProjectAgentTaskEventRecord(**row) for row in BLOCKED_ROWS]
    later = current_blocker('blocked', events, None, hint(15)).probably_resolved
    assert (later.agent_id, later.source_session_id, later.at) == ('agent-a', SESSION_B, T0 + timedelta(minutes=15))
    # Reported again after that work: the block stands as reported.
    assert current_blocker('blocked', events, None, hint(7)).probably_resolved is None
    # The reporting session's own work is not evidence from elsewhere.
    assert current_blocker('blocked', events, None, hint(15, SESSION_A)).probably_resolved is None
    assert current_blocker('blocked', events, None, {}).probably_resolved is None
    # A block no session reported (an HR or routing block) takes the evidence too.
    assert current_blocker('blocked', events[:1], 'No lead.', hint(15)).probably_resolved.agent_id == 'agent-a'


def progress(session_id=SESSION_B):
    return ProjectAgentTaskBlockerProgress(personal_space_id='personal-space', personal_project_id='project-a',
                                           agent_id='agent-a', source_application='codex',
                                           source_session_id=session_id)


@pytest.mark.asyncio
async def test_an_agents_work_in_another_session_marks_its_tasks_probably_resolved_and_keeps_them_blocked():
    store = BlockerStore(blocked_row())
    result = await store.note_blocker_progress({'id': 'principal'}, progress())
    assert result.hinted_task_ids == ['task-a']
    [lookup] = store.runtime.driver.writes('RETURN DISTINCT task.task_id')
    assert (lookup['project_id'], lookup['agent_id']) == ('project-a', 'agent-a')
    [hinted] = store.runtime.driver.writes('SET task.blocker_hint_agent_id')
    assert (hinted['agent_id'], hinted['application'], hinted['session_id']) == ('agent-a', 'codex', SESSION_B)
    assert store.runtime.driver.writes('CREATE (event') == []
    assert store.runtime.driver.writes('SET task.status') == []


@pytest.mark.asyncio
async def test_the_reporting_sessions_own_work_leaves_no_hint():
    store = BlockerStore(blocked_row())
    assert (await store.note_blocker_progress({'id': 'principal'}, progress(SESSION_A))).hinted_task_ids == []
    assert store.runtime.driver.writes('SET task.blocker_hint_agent_id') == []


def confirm():
    return ProjectAgentTaskBlockerPersonClear(personal_space_id='personal-space', personal_project_id='project-a',
                                              confirm_hint=True)


@pytest.mark.asyncio
async def test_the_person_confirms_a_probable_resolution_and_history_names_the_evidence():
    store = BlockerStore(lead_row(**hint(15)))
    await store.clear_task_blocker_by_person(PERSON, 'task-a', confirm())
    [cleared] = store.runtime.driver.writes('CREATE (event:FuliProjectAgentTaskEvent')
    assert (cleared['cause'], cleared['actor_kind'], cleared['summary']) == (
        'person_confirmed', 'human', PERSON_CONFIRM_SUMMARY)
    assert (cleared['agent_id'], cleared['application'], cleared['session_id']) == ('agent-a', 'codex', SESSION_B)


@pytest.mark.asyncio
async def test_confirming_without_a_probable_resolution_is_refused_without_a_write():
    store = BlockerStore(lead_row(**hint(7)))
    with pytest.raises(HTTPException) as refused:
        await store.clear_task_blocker_by_person(PERSON, 'task-a', confirm())
    assert refused.value.status_code == 409
    assert store.runtime.driver.writes('CREATE (event') == []


@pytest.mark.asyncio
async def test_an_fla_clears_a_block_it_solved_for_the_person_and_history_keeps_who_and_why():
    store = BlockerStore(blocked_row())
    await store.clear_task_blocker_by_person(PERSON, 'task-a', ProjectAgentTaskBlockerPersonClear(
        personal_space_id='personal-space', personal_project_id='project-a', note='Set the staging database.',
        cleared_by='agent', agent_id='agent-b', source_application='claude_code', source_session_id=SESSION_B))
    [cleared] = store.runtime.driver.writes('CREATE (event:FuliProjectAgentTaskEvent')
    assert (cleared['cause'], cleared['actor_kind'], cleared['summary']) == (
        'agent', 'agent', 'Set the staging database.')
    assert (cleared['agent_id'], cleared['application'], cleared['session_id']) == (
        'agent-b', 'claude_code', SESSION_B)


@pytest.mark.parametrize('changes', [
    {'cleared_by': 'agent', 'agent_id': 'agent-b'},
    {'cleared_by': 'agent', 'note': 'Fixed.', 'confirm_hint': True},
    {'agent_id': 'agent-b', 'note': 'Fixed.'},
    {'source_session_id': SESSION_B},
])
def test_an_agent_clear_says_why_and_only_the_person_confirms_a_hint(changes):
    with pytest.raises(ValueError):
        ProjectAgentTaskBlockerPersonClear(personal_space_id='personal-space', personal_project_id='project-a',
                                           **changes)


def test_the_task_history_reads_an_agents_reason_but_not_the_confirmation_sentence():
    rows = BLOCKED_ROWS + [
        event('running', 12, 'Set the staging database.', blocker_cleared_by='agent'),
        event('blocked', 20),
        event('running', 25, PERSON_CONFIRM_SUMMARY, actor_kind='human', blocker_cleared_by='person_confirmed'),
    ]
    events = StoreProjectAgentTaskReads._events_from_row({'event_rows': rows})
    assert [(item.blocker_cleared_by, item.blocker_clear_note) for item in events if item.blocker_cleared_by] == [
        ('agent', 'Set the staging database.'), ('person_confirmed', None)]


def test_the_progress_route_notifies_each_task_it_marked(monkeypatch):
    notified = []
    monkeypatch.setattr('fuli_graph.project_agent_routes.register_task_notification_routes',
                        lambda *_: lambda space, task: notified.append((space, task)))

    async def actor():
        return {'id': 'principal'}

    async def note_blocker_progress(actor_value, request):
        return ProjectAgentTaskBlockerProgressResult(hinted_task_ids=['task-a'])

    app = FastAPI()
    register_project_agent_routes(app, SimpleNamespace(note_blocker_progress=note_blocker_progress),
                                  Annotated[dict, Depends(actor)], Annotated[dict, Depends(actor)])
    response = TestClient(app).post('/v1/project-agent-task-blockers/progress', json=progress().model_dump())
    assert response.json() == {'hinted_task_ids': ['task-a']}
    assert notified == [('personal-space', 'task-a')]
