"""A conversation list for a progress view (Jefa's list_project_conversations):
each row's last task results, bounded, and pages that pass over the newest.
Synthetic driver double; the Cypher runs in test_agent_conversations_neo4j.py."""
import json
from types import SimpleNamespace

import pytest

from fuli_graph.agent_conversation_models import ConversationPolicy, ConversationQuery
from fuli_graph.store_agent_conversations import StoreAgentConversations, _recent_tasks


def test_recent_tasks_are_the_last_three_bounded_with_their_recorded_source():
    tasks = [{'at': f't{n}', 'status': 'completed', 'summary': f'result {n}'} for n in range(5)]
    tasks[-1] = {**tasks[-1], 'summary': '长' * 300, 'source': {'sequence': 9, 'event_id': 'e'}}
    recent = _recent_tasks(json.dumps({'tasks': tasks}))
    assert [task['at'] for task in recent] == ['t2', 't3', 't4']
    assert recent[0]['source'] is None, 'no recorded source reads as None'
    assert recent[-1]['source'] == {'sequence': 9, 'event_id': 'e'}
    assert len(recent[-1]['summary'].encode()) <= 400 + len('…'.encode()) and recent[-1]['summary'].endswith('…')
    assert _recent_tasks(None) == [] and _recent_tasks('not json') == []


class ListDriver:
    def __init__(self):
        self.calls = []

    async def execute_query(self, query, **parameters):
        self.calls.append((query, parameters))
        if 'c.digest AS digest' in query:
            return [{'id': 'c1', 'digest': json.dumps({'tasks': [{'at': 'x', 'status': 'completed', 'summary': 'done'}]})}], None, None
        if 'FuliConversationSession' in query or 'HAS_EVENT' in query:
            return [], None, None
        return [{'c': {'id': 'c1', 'summary': 'done', 'status': 'completed', 'revision': 2, 'last_activity': 'y',
                       'digest': 'kept out of the list'}, 't': None}], None, None


class ListStore(StoreAgentConversations):
    def __init__(self):
        self.runtime = SimpleNamespace(driver=ListDriver())

    async def _conversation_scope(self, actor, request, *, write=False):
        return 'scope'

    async def _conversation_policy(self, scope):
        return ConversationPolicy()


@pytest.mark.asyncio
async def test_a_progress_list_adds_recent_tasks_and_pages_on_only_when_asked():
    store = ListStore()
    query = lambda **changes: ConversationQuery(personal_space_id='s', personal_project_id='p', agent_id='a', mode='list', **changes)
    plain = await store.query_conversations({}, query())
    assert 'recent_tasks' not in plain['conversations'][0] and 'digest' not in plain['conversations'][0]
    assert store.runtime.driver.calls[0][1]['skip'] == 0
    progress = await store.query_conversations({}, query(with_progress=True, after=40, limit=5))
    assert progress['conversations'][0]['recent_tasks'] == [{'at': 'x', 'status': 'completed', 'summary': 'done', 'source': None}]
    list_call = [params for q, params in store.runtime.driver.calls if 'SKIP $skip' in q][-1]
    assert (list_call['skip'], list_call['limit']) == (40, 5)
    digest_call = [params for q, params in store.runtime.driver.calls if 'c.digest AS digest' in q][-1]
    assert digest_call == {'scope': 'scope', 'ids': ['c1']}, 'digests are read only within the scope, for the listed rows'
