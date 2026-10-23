"""Source purge keeps other-session events but never their stale mixed summary."""
from types import SimpleNamespace

import pytest

from fuli_graph.knowledge_source_delete_copies import remove_source_copies
from fuli_graph.store_agent_conversations import encode_event
from fuli_graph.conversation_context import message_bytes


@pytest.mark.asyncio
async def test_source_purge_scopes_copies_and_recounts_retained_journal_events():
    calls = []
    event = {'event_id': 'other', 'role': 'user', 'kind': 'message', 'content': 'Other session synthetic words'}
    _, payload = encode_event(SimpleNamespace(model_dump=lambda: event))

    async def query(cypher, **parameters):
        calls.append((cypher, parameters))
        if 'RETURN event.payload' in cypher:
            return ([{'payload': payload, 'sequence': 8}], None, None)
        return ([], None, None)

    scoped = SimpleNamespace(runtime=SimpleNamespace(driver=SimpleNamespace(execute_query=query)))
    await remove_source_copies(scoped, {'id': 'space', 'group_id': 'group'}, {
        'episodes': [{'uuid': 'episode'}], 'event_ids': ['event'], 'conversation_ids': ['conversation'],
        'task_tokens': ['token'], 'task_ids': ['task']})
    resets = [params for cypher, params in calls if "conversation.summary = ''" in cypher]
    assert resets == [{'id': 'conversation', 'remaining_bytes': message_bytes(event)}]
    deletes = [(cypher, params) for cypher, params in calls if 'DETACH DELETE' in cypher]
    assert len(deletes) == 3
    assert all(any(name in params for name in ('group_id', 'space_id', 'conversation_ids'))
               for _, params in deletes)
    assert all('FuliPublicationDraft' not in cypher for cypher, _ in calls)
