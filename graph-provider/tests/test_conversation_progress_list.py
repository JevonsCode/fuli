"""A conversation list for a progress view (Jefa's list_project_conversations):
each row's latest evidence of progress, and keyset pages. Synthetic data and a
driver double; the Cypher runs in test_agent_conversations_neo4j.py."""
import json
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from fuli_graph.agent_conversation_models import ConversationPolicy, ConversationQuery
from fuli_graph.conversation_context import (
    AUTOMATIC_CLOSE_SUMMARIES, add_task_result, latest_progress, refold_digest,
)
from fuli_graph.conversation_scope import conversation_scope_id
from fuli_graph.store_agent_conversations import StoreAgentConversations

AUTO_CLOSE, AUTO_KEEP = sorted(AUTOMATIC_CLOSE_SUMMARIES, key=len)


def test_automatic_closes_after_a_real_result_leave_it_as_the_progress():
    digest = add_task_result({}, 't0', 'completed', 'Shipped the parser')
    for n in range(3):
        digest = add_task_result(digest, f'a{n}', 'reported', AUTO_CLOSE if n % 2 else AUTO_KEEP)
    progress = latest_progress(digest)
    assert (progress['at'], progress['status'], progress['summary']) == ('t0', 'completed', 'Shipped the parser')


def test_the_progress_outlives_the_task_window_with_its_own_time():
    digest = add_task_result({}, 't0', 'completed', 'Shipped the parser')
    for n in range(13):
        digest = add_task_result(digest, f'a{n}', 'reported', AUTO_CLOSE)
    assert all(task['summary'] == AUTO_CLOSE for task in digest['tasks']), 'the real result left the 12-task window'
    assert latest_progress(digest)['at'] == 't0'
    assert latest_progress(refold_digest(digest, []))['at'] == 't0', 'a rebuilt digest keeps it'
    # A newer real result replaces it; an automatic one never does.
    assert latest_progress(add_task_result(digest, 't9', 'completed', 'Second result'))['at'] == 't9'


def test_a_digest_written_before_the_pointer_falls_back_to_its_window():
    legacy = {'tasks': [{'at': 't0', 'status': 'completed', 'summary': 'Old result'},
                        {'at': 't1', 'status': 'reported', 'summary': AUTO_CLOSE}]}
    assert latest_progress(legacy)['at'] == 't0'
    assert latest_progress({'tasks': [{'at': 't1', 'status': 'reported', 'summary': AUTO_CLOSE}]}) is None
    assert latest_progress({}) is None


def test_a_keyset_position_is_given_whole():
    base = dict(personal_space_id='s', personal_project_id='p', agent_id='a', mode='list')
    assert ConversationQuery(**base, after_activity='2026-11-18T15:00:00+00:00', after_id='c1').after_id == 'c1'
    with pytest.raises(ValidationError):
        ConversationQuery(**base, after_activity='2026-11-18T15:00:00+00:00')


class ListDriver:
    def __init__(self):
        self.calls = []

    async def execute_query(self, query, **parameters):
        self.calls.append((query, parameters))
        if 'c.digest AS digest' in query:
            digest = add_task_result({}, 'x', 'completed', 'done' + 'é' * 300)
            digest = add_task_result(digest, 'y', 'reported', AUTO_CLOSE)
            return [{'id': 'c1', 'digest': json.dumps(digest)}], None, None
        if 'HAS_PROJECT_AGENT_ASSIGNMENT' in query:
            return [{'agent_id': 'a', 'active': True}, {'agent_id': 'member', 'active': True}], None, None
        if 'FuliProjectAgentTaskEvent' in query:
            receipt = lambda event_id: {'at': '2026-11-18T15:30:00Z', 'second': '2026-11-18T15:30:00Z', 'status': 'running',
                'summary': 'Running the suite', 'task_id': 'task-1', 'event_id': event_id, 'agent_id': 'member',
                'client': 'codex', 'session_id': 'synthetic-session'}
            return [{'conversation_id': 'c1', 'latest': [receipt('event-b'), receipt('event-a')]}], None, None
        if 'FuliConversationSession' in query or 'HAS_EVENT' in query:
            return [], None, None
        return [{'c': {'id': 'c1', 'summary': 'done', 'status': 'completed', 'revision': 2, 'last_activity': 'y',
                       'digest': 'kept out of the list'}, 't': None}], None, None


class ListStore(StoreAgentConversations):
    def __init__(self):
        self.runtime = SimpleNamespace(driver=ListDriver())

    async def _conversation_scope(self, actor, request, *, write=False):
        return conversation_scope_id('s', 'p', 'a')

    async def _conversation_policy(self, scope):
        return ConversationPolicy()


@pytest.mark.asyncio
async def test_a_progress_list_adds_evidence_and_pages_by_position_only_when_asked():
    store = ListStore()
    query = lambda **changes: ConversationQuery(personal_space_id='s', personal_project_id='p', agent_id='a', mode='list', **changes)
    plain = await store.query_conversations({}, query())
    row = plain['conversations'][0]
    assert 'progress' not in row and 'task_activity' not in row and 'digest' not in row
    assert store.runtime.driver.calls[0][1]['after_activity'] is None
    progress = await store.query_conversations({}, query(with_progress=True, after_activity='z', after_id='c0', limit=5))
    row = progress['conversations'][0]
    assert row['progress']['at'] == 'x' and row['progress']['summary'].startswith('done')
    assert len(row['progress']['summary'].encode()) <= 400, 'summaries are bounded'
    assert row['task_activity']['source'] == {'client': 'codex', 'session_id': 'synthetic-session', 'task_id': 'task-1',
                                              'event_id': 'event-b', 'agent_id': 'member'}
    assert row['task_activity']['same_second_event_ids'] == ['event-a'], 'a receipt of the same second keeps its ID'
    list_call = [params for q, params in store.runtime.driver.calls if 'after_activity' in params][-1]
    assert (list_call['after_activity'], list_call['after_id'], list_call['limit']) == ('z', 'c0', 5)
    digest_call = [params for q, params in store.runtime.driver.calls if 'c.digest AS digest' in q][-1]
    assert digest_call == {'scope': conversation_scope_id('s', 'p', 'a'), 'ids': ['c1']}, 'digests are read only within the scope, for the listed rows'
    link_call = [params for q, params in store.runtime.driver.calls if 'FuliProjectAgentTaskEvent' in q][-1]
    assert (link_call['space'], link_call['project'], link_call['active']) == ('s', 'p', ['a', 'member'])
    assert len(link_call['scopes']) == 2, 'every journal of the project counts when a session is checked for being unique'
