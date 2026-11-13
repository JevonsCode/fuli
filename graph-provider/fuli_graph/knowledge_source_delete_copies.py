"""Remove source-owned graph copies inside the caller's locked transaction.

Knowledge/version removal is shared with knowledge_hard_delete. This module
owns the additional source range copies: episode links, saved turn contexts,
raw journal events and derived conversation summaries/labels. The owning source
mutation erases local publication drafts in the same transaction; remote copies
are outside this local source operation.
"""
from .conversation_context import message_bytes
from .knowledge_sensitivity import EDIT_SOURCE_KINDS
from .store_agent_conversations import decode_event

# A deleted source that was not explicitly normal (private, restricted or
# unknown) and not an edit episode, which says nothing about the knowledge.
_NON_NORMAL_SOURCE = '''
  NOT coalesce(episode.fuli_source_kind, '') IN $edit_kinds
  AND coalesce(episode.fuli_sensitivity, '') <> 'normal'
'''


async def _mark_restricted_source_loss(scoped, space, episode_ids):
    """Before the episodes go, in the delete's own transaction: every item a
    non-normal one of them is a source of, and that outlives the delete (the
    items that go were removed before this), carries
    fuli_had_restricted_source = true from now on, so a visitor's search
    (knowledge_sensitivity) still withholds it. The marker is never unset;
    only that search reads it."""
    if not episode_ids:
        return
    params = {'group_id': space['group_id'], 'episode_ids': episode_ids, 'edit_kinds': list(EDIT_SOURCE_KINDS)}
    await scoped.runtime.driver.execute_query(
        '''
        MATCH (episode:Episodic {group_id: $group_id})-[:MENTIONS]->(item:Entity {group_id: $group_id})
        WHERE episode.uuid IN $episode_ids AND''' + _NON_NORMAL_SOURCE + '''
        SET item.fuli_had_restricted_source = true
        ''', **params)
    await scoped.runtime.driver.execute_query(
        '''
        MATCH (episode:Episodic {group_id: $group_id})
        WHERE episode.uuid IN $episode_ids AND''' + _NON_NORMAL_SOURCE + '''
        WITH collect(episode.uuid) AS withheld
        MATCH ()-[item:RELATES_TO {group_id: $group_id}]->()
        WHERE any(id IN coalesce(item.episodes, []) WHERE id IN withheld)
        SET item.fuli_had_restricted_source = true
        ''', **params)


async def remove_source_copies(scoped, space, inventory):
    episode_ids = [episode['uuid'] for episode in inventory['episodes']]
    await _mark_restricted_source_loss(scoped, space, episode_ids)
    await scoped.runtime.driver.execute_query(
        '''
        MATCH ()-[item:RELATES_TO {group_id: $group_id}]->()
        WHERE any(id IN coalesce(item.episodes, []) WHERE id IN $episode_ids)
        SET item.episodes = [id IN item.episodes WHERE NOT id IN $episode_ids],
            item.fuli_ai_review_lock_version = coalesce(item.fuli_ai_review_lock_version, 0) + 1
        ''', group_id=space['group_id'], episode_ids=episode_ids)
    await scoped.runtime.driver.execute_query(
        '''
        UNWIND $episode_ids AS id
        MATCH (episode:Episodic {uuid: id, group_id: $group_id})
        DETACH DELETE episode
        ''', group_id=space['group_id'], episode_ids=episode_ids)
    await scoped.runtime.driver.execute_query(
        '''
        UNWIND $event_ids AS id
        MATCH (conversation:FuliConversation)-[:HAS_EVENT]->(event:FuliConversationEvent {id: id})
        WHERE conversation.id IN $conversation_ids
        DETACH DELETE event
        ''', event_ids=inventory['event_ids'], conversation_ids=inventory['conversation_ids'])
    for conversation_id in inventory['conversation_ids']:
        # A shared conversation retains other sessions' events. Drop every
        # derived body, then count the retained events for future compaction.
        events, _, _ = await scoped.runtime.driver.execute_query(
            '''
            MATCH (:FuliConversation {id: $id})-[:HAS_EVENT]->(event:FuliConversationEvent)
            RETURN event.payload AS payload, event.sequence AS sequence ORDER BY sequence
            ''', id=conversation_id)
        remaining_bytes = sum(message_bytes(decode_event(row)) for row in events)
        await scoped.runtime.driver.execute_query(
            '''
            MATCH (conversation:FuliConversation {id: $id})
            SET conversation.summary = '', conversation.digest = '', conversation.compacted_through = 0,
                conversation.unfolded_bytes = $remaining_bytes,
                conversation.revision = conversation.revision + 1
            ''', id=conversation_id, remaining_bytes=remaining_bytes)
    await scoped.runtime.driver.execute_query(
        '''
        MATCH (triage:FuliConversationTriage {space_id: $space_id})
        WHERE triage.id IN $conversation_ids
        DETACH DELETE triage
        ''', space_id=space['id'], conversation_ids=inventory['conversation_ids'])
    await scoped.runtime.driver.execute_query(
        '''
        MATCH (:FuliSpace {id: $space_id})-[:HAS_TASK_CONTEXT_SESSION]->(session:FuliTaskContextSession)
        WHERE session.current_token IN $tokens
        REMOVE session.current_token
        ''', space_id=space['id'], tokens=inventory['task_tokens'])
