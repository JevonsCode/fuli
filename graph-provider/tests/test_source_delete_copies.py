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


@pytest.mark.asyncio
async def test_items_losing_a_non_normal_source_are_marked_before_the_source_goes():
    calls = []

    async def query(cypher, **parameters):
        calls.append((cypher, parameters))
        return ([], None, None)

    scoped = SimpleNamespace(runtime=SimpleNamespace(driver=SimpleNamespace(execute_query=query)))
    await remove_source_copies(scoped, {'id': 'space', 'group_id': 'group'}, {
        'episodes': [{'uuid': 'episode'}], 'event_ids': [], 'conversation_ids': [], 'task_tokens': [],
        'task_ids': []})
    marks = [index for index, (cypher, _) in enumerate(calls) if 'fuli_had_restricted_source = true' in cypher]
    strip = next(index for index, (cypher, _) in enumerate(calls) if 'SET item.episodes' in cypher)
    delete = next(index for index, (cypher, _) in enumerate(calls) if 'DETACH DELETE episode' in cypher)
    assert len(marks) == 2 and max(marks) < strip < delete
    entity, relationship = (calls[index] for index in marks)
    assert '-[:MENTIONS]->(item:Entity' in entity[0] and 'item.episodes' in relationship[0]
    for cypher, parameters in (entity, relationship):
        assert parameters['episode_ids'] == ['episode']
        assert parameters['edit_kinds'] == ['human_knowledge_edit', 'agent_knowledge_edit']
        # Missing sensitivity is not normal; an edit episode never marks.
        assert "coalesce(episode.fuli_sensitivity, '') <> 'normal'" in cypher
        assert "NOT coalesce(episode.fuli_source_kind, '') IN $edit_kinds" in cypher
