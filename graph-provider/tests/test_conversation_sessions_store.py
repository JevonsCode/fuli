"""Where a conversation was written from (graph 22). Synthetic driver double;
the Cypher itself runs in test_agent_conversations_neo4j.py."""
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from fuli_graph.store_agent_conversations import StoreAgentConversations


class SessionsDriver:
    def __init__(self, bindings, events):
        self.bindings, self.events, self.queries = bindings, events, []

    async def execute_query(self, query, **parameters):
        self.queries.append((query, parameters))
        if 'FuliConversationSession' in query:
            return [row for row in self.bindings if row['conversation_id'] in parameters['ids']], None, None
        assert 'HAS_EVENT' in query
        return [row for row in self.events if row['conversation_id'] in parameters['ids']], None, None


def store_with(bindings, events):
    store = StoreAgentConversations.__new__(StoreAgentConversations)
    store.runtime = SimpleNamespace(driver=SessionsDriver(bindings, events))
    return store


@pytest.mark.asyncio
async def test_a_conversation_written_before_graph_22_names_its_sessions_from_its_journal():
    at = datetime(2026, 11, 18, 9, 0, tzinfo=timezone.utc)
    store = store_with(
        bindings=[{'conversation_id': 'new', 'client': 'codex', 'session_id': 'synthetic-s1', 'model': 'synthetic-model',
                   'working_directory': 'T:/synthetic', 'first_seen': '2026-11-18T08:00:00+00:00',
                   'last_seen': '2026-11-18T09:00:00+00:00'}],
        events=[{'conversation_id': 'old', 'client': 'claude_code', 'session_id': 'synthetic-s0',
                 'first_seen': at, 'last_seen': at},
                {'conversation_id': 'new', 'client': 'codex', 'session_id': 'never-read',
                 'first_seen': at, 'last_seen': at}])
    sessions = await store._conversation_sessions(['new', 'old', 'empty'])
    assert sessions['new'] == [{'client': 'codex', 'session_id': 'synthetic-s1', 'model': 'synthetic-model',
                                'working_directory': 'T:/synthetic', 'first_seen': '2026-11-18T08:00:00+00:00',
                                'last_seen': '2026-11-18T09:00:00+00:00'}]
    # No binding recorded it: the journal names the client and session, with no folder or model.
    assert sessions['old'] == [{'client': 'claude_code', 'session_id': 'synthetic-s0',
                                'first_seen': '2026-11-18T09:00:00+00:00', 'last_seen': '2026-11-18T09:00:00+00:00'}]
    assert 'empty' not in sessions
    # The journal is read only for the conversations no binding names.
    assert store.runtime.driver.queries[1][1]['ids'] == ['old', 'empty']


@pytest.mark.asyncio
async def test_a_list_names_at_most_five_sessions_per_conversation_and_reads_nothing_for_none():
    rows = [{'conversation_id': 'c', 'client': 'codex', 'session_id': f'synthetic-{n}', 'model': None,
             'working_directory': None, 'first_seen': 'x', 'last_seen': f'2026-11-18T0{9 - n}:00:00+00:00'}
            for n in range(7)]
    store = store_with(bindings=rows, events=[])
    sessions = await store._conversation_sessions(['c'])
    assert [s['session_id'] for s in sessions['c']] == [f'synthetic-{n}' for n in range(5)]
    assert all('model' not in s and 'working_directory' not in s for s in sessions['c'])
    assert await store_with([], [])._conversation_sessions([]) == {}


def test_a_credential_like_note_is_left_out_and_never_refuses_the_entry():
    from fuli_graph.agent_conversation_models import ConversationProvenance
    note = ConversationProvenance(working_directory='T:/synthetic', model='synthetic-model',
                                  title='fix access_token=abc in the synthetic client')
    assert (note.working_directory, note.model, note.title) == ('T:/synthetic', 'synthetic-model', None)
    assert ConversationProvenance(working_directory='T:/sk-ant-api03-' + 'A' * 40).working_directory is None
