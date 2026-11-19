"""Each digest task result points at the checkpoint event that wrote it, or says
its source is unknown; never a guess. Synthetic driver double; the Cypher runs
in test_agent_conversations_neo4j.py."""
import json
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from fuli_graph.agent_conversation_models import ConversationEvent
from fuli_graph.conversation_context import add_task_result
from fuli_graph.store_agent_conversations import StoreAgentConversations, checkpoint_source, encode_event

WRITE = datetime(2026, 11, 18, 21, 0, 22, 495123, tzinfo=timezone.utc)


def stored(sequence, content, *, kind='checkpoint', event_id=None, at=WRITE, client='claude_code', session='synthetic-claude'):
    _, payload = encode_event(ConversationEvent(event_id=event_id or f'synthetic-task-{sequence}:summary',
                                                role='summary', content=content, kind=kind))
    return {'payload': payload, 'sequence': sequence, 'created_at': at, 'source_application': client, 'session_id': session}


class EventsDriver:
    def __init__(self, events):
        self.events, self.queries = events, []

    async def execute_query(self, query, **params):
        self.queries.append(params)
        return [event for event in self.events if event['sequence'] == params['sequence']], None, None


def store_with(events):
    store = StoreAgentConversations.__new__(StoreAgentConversations)
    store.runtime = SimpleNamespace(driver=EventsDriver(events))
    return store


def test_a_new_result_points_at_the_one_checkpoint_of_its_write():
    request = SimpleNamespace(summary='Same words', source_application='codex', session_id='synthetic-codex')
    assert checkpoint_source([(7, 'synthetic-task:summary', 'Same words')], request) == {
        'sequence': 7, 'event_id': 'synthetic-task:summary', 'client': 'codex', 'session_id': 'synthetic-codex'}
    # No checkpoint with these words, or two of them in one write: unknown, never picked.
    assert checkpoint_source([(7, 'a', 'Other words')], request) is None
    assert checkpoint_source([(7, 'a', 'Same words'), (8, 'b', 'Same words')], request) is None
    digest = add_task_result({}, WRITE.isoformat(), 'completed', 'Same words', None)
    assert digest['tasks'] == [{'at': WRITE.isoformat(), 'status': 'completed', 'summary': 'Same words', 'source': None}]


@pytest.mark.asyncio
async def test_an_older_result_without_a_recorded_source_is_unknown_and_reads_no_event():
    # Review 11-19: two older results with the same instant, status and words, one written by
    # Claude (whose checkpoint said other words) and one by Codex, were both linked to Codex's
    # event. Older results carry no write ID, so the same instant proves nothing: unknown.
    store = store_with([stored(1, 'A 的细节'), stored(2, 'shared status', client='codex', session='synthetic-codex')])
    same = {'at': WRITE.isoformat(), 'status': 'completed', 'summary': 'shared status'}
    recorded = {**same, 'summary': 'Recorded', 'source': {'sequence': 9, 'event_id': 'e'}}
    digest = await store._with_task_sources('synthetic-conversation', {'tasks': [same, dict(same), recorded]})
    assert [task['source'] for task in digest['tasks']] == [None, None, {'sequence': 9, 'event_id': 'e'}]
    assert store.runtime.driver.queries == [], 'no event is read, let alone unpacked, to guess a source'


@pytest.mark.asyncio
async def test_a_source_reads_back_only_the_event_it_names():
    events = [stored(1, 'Same words'), stored(2, 'Same words', client='codex', session='synthetic-codex',
                                              event_id='codex-task:summary')]
    store = store_with(events)
    record = {'id': 'c', 'revision': 3}
    found = await store._source_event(record, 2, 'codex-task:summary')
    assert found['source_check'] == 'verified'
    assert [(e['sequence'], e['content'], e['client'], e['session_id'], e['kind']) for e in found['events']] == [
        (2, 'Same words', 'codex', 'synthetic-codex', 'checkpoint')]
    # Another event at that sequence, a removed event or a sequence past the revision: unavailable, nothing shown.
    assert (await store._source_event(record, 2, 'claude-task:summary'))['events'] == []
    assert (await store._source_event(record, 3, 'codex-task:summary'))['source_check'] == 'unavailable'
    store.runtime.driver.events = [events[0]]
    gone = await store._source_event(record, 2, 'codex-task:summary')
    assert (gone['source_check'], gone['events']) == ('unavailable', [])


def test_the_list_names_the_summary_source_only_when_the_write_recorded_it():
    from fuli_graph.store_agent_conversations import _summary_source
    source = {'sequence': 4, 'event_id': 'e', 'client': 'codex', 'session_id': 's'}
    digest = json.dumps({'tasks': [{'summary': 'Old', 'source': None}, {'summary': 'Latest', 'source': source}]})
    assert _summary_source({'summary': 'Latest', 'digest': digest}) == source
    assert _summary_source({'summary': 'Changed since', 'digest': digest}) is None
    assert _summary_source({'summary': 'Latest', 'digest': json.dumps({'tasks': [{'summary': 'Latest'}]})}) is None
    assert _summary_source({'summary': '', 'digest': None}) is None
