"""Remove source-owned graph copies inside the caller's locked transaction.

Knowledge/version removal is shared with knowledge_hard_delete. This module
owns the additional source range copies: episode links, saved turn contexts,
raw journal events and derived conversation summaries/labels. The owning source
mutation erases local publication drafts in the same transaction; remote copies
are outside this local source operation.
"""
from .conversation_context import message_bytes
from .store_agent_conversations import decode_event


async def remove_source_copies(scoped, space, inventory):
    episode_ids = [episode['uuid'] for episode in inventory['episodes']]
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
