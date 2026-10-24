"""A task entry's conversation begin in one transaction (rec#11 D-53).

Synthetic store double; the real Cypher, authorization and append checks are
covered by test_agent_conversations_neo4j.py."""
from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from fuli_graph.agent_conversation_models import ConversationBegin, ConversationEvent, ConversationWrite
from fuli_graph.store_agent_conversations import StoreAgentConversations, encode_event

SCOPE = 'synthetic-scope'
BOUND = 'synthetic-bound-conversation'


def stored_event(sequence, content, *, session_id, source_application, event_id):
    _, payload = encode_event(ConversationEvent(event_id=event_id, role='user', content=content))
    return {'payload': payload, 'sequence': sequence, 'session_id': session_id, 'source_application': source_application}


class JournalDriver:
    """Answers the conversation reads of one scope; records each statement and the transaction's end."""

    def __init__(self, *, bound):
        self.bound = bound
        self.queries = []
        self.outcome = None
        self.record = {'id': BOUND, 'scope': SCOPE, 'revision': 2, 'summary': 'Synthetic result',
                       'status': 'completed', 'last_activity': '2026-10-25T00:00:00+00:00'}
        self.events = [
            stored_event(1, 'SYNTHETIC_OWN', session_id='native-a', source_application='codex', event_id='jsonl-v1:0:0:0'),
            stored_event(2, 'SYNTHETIC_OTHER', session_id='native-a', source_application='claude_code',
                         event_id='jsonl-v1:0:0:0'),
        ]

    @asynccontextmanager
    async def transaction(self):
        try:
            yield self
        except BaseException:
            self.outcome = 'rolled_back'
            raise
        self.outcome = 'committed'

    async def run(self, query, **parameters):
        self.queries.append(query)
        rows = []
        if 'FuliConversationPolicy' in query:
            rows = []
        elif 'FuliConversationBinding' in query:
            rows = [{'conversation_id': self.bound, 'cursor': 0, 'initialized': False}]
        elif 'ORDER BY e.sequence DESC' in query:
            rows = [event for event in reversed(self.events) if event['sequence'] < parameters['before']]
        elif 'MATCH (c:FuliConversation {scope: $scope, id: $id})' in query:
            rows = [{'c': self.record}] if parameters['id'] == self.record['id'] else []
        elif 'MATCH (c:FuliConversation {scope: $scope})' in query:
            rows = [{'c': self.record, 't': None}][:parameters['limit']]

        async def result():
            for row in rows:
                yield row
        return result()


class BeginStore(StoreAgentConversations):
    def __init__(self, *, bound=BOUND, refuse=None):
        self.runtime = SimpleNamespace(driver=JournalDriver(bound=bound))
        self.bound = bound
        self.steps = []
        self.refuse = refuse

    async def _conversation_scope(self, actor, request, *, write=False):
        self.steps.append(('scope', write))
        return SCOPE

    async def append_conversation(self, actor, request):
        self.steps.append(('append', request))
        if self.refuse:
            raise HTTPException(*self.refuse)
        return {'status': 'saved', 'conversation_id': self.bound or 'synthetic-started', 'revision': 2}


def begin_request(**changes):
    return ConversationBegin(**{'personal_space_id': 'synthetic-space', 'personal_project_id': 'synthetic-project',
        'agent_id': 'engineer', 'source_application': 'codex', 'session_id': 'native-a',
        'task_context_token': 'fuli-task-synthetic', **changes})


@pytest.mark.asyncio
async def test_begin_reads_as_a_reader_then_appends_this_task_with_no_events_in_one_transaction():
    store = BeginStore()
    result = await store.begin_conversation(None, begin_request())
    assert [step[0] for step in store.steps] == ['scope', 'append']
    assert store.steps[0] == ('scope', False), 'the reads keep the query route\'s reader check'
    append = store.steps[1][1]
    assert append == ConversationWrite(**begin_request().model_dump())
    assert (append.events, append.cursor, append.expected_cursor, append.summary) == ([], None, None, None)
    assert store.runtime.driver.outcome == 'committed'
    assert (result['status'], result['conversation_id'], result['recovered_from'], result['recent']) == (
        'saved', BOUND, BOUND, None)
    # The recovery window of the bound conversation, with proofs for this client and session's own record only.
    messages = result['previous']['context']['messages']
    assert [(m['content'], m.get('own_event')) for m in messages] == [
        ('SYNTHETIC_OWN', 'jsonl-v1:0:0:0'), ('SYNTHETIC_OTHER', None)]
    assert result['previous']['id'] == BOUND and result['previous']['context']['conversation_id'] == BOUND
    assert not any('FuliConversation {scope: $scope})' in query for query in store.runtime.driver.queries), \
        'a bound session never lists the scope\'s other conversations'


@pytest.mark.asyncio
async def test_an_unbound_session_gets_only_the_latest_conversation_of_its_scope():
    store = BeginStore(bound=None)
    result = await store.begin_conversation(None, begin_request(session_id='native-b'))
    assert result['previous'] is None and result['recovered_from'] is None
    assert result['recent']['id'] == BOUND and result['recent']['triage'] is None
    assert not any('HAS_EVENT' in query for query in store.runtime.driver.queries), 'no message of it is read'


@pytest.mark.asyncio
@pytest.mark.parametrize('refusal', [(409, 'Conversation does not match the current task Agent and session'),
                                     (403, 'Agent is not allowed in this client')])
async def test_a_refused_append_rolls_back_and_returns_no_read(refusal):
    store = BeginStore(refuse=refusal)
    with pytest.raises(HTTPException) as refused:
        await store.begin_conversation(None, begin_request())
    assert refused.value.status_code == refusal[0]
    assert store.runtime.driver.outcome == 'rolled_back'


def test_begin_carries_no_events_cursors_or_summary():
    for extra in ({'events': []}, {'cursor': 1, 'expected_cursor': 1}, {'summary': 'x'}):
        with pytest.raises(ValueError):
            begin_request(**extra)
