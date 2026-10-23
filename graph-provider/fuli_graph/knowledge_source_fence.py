"""Point checks for deleted source identities; never return a tombstone list."""
from fastapi import HTTPException

from .provider_values import stable_uuid


def source_turn_key(store, space, source_application, session_id, source_turn_id):
    if not (source_application and session_id and source_turn_id):
        return None
    session = store._task_session_id(space['id'], source_application, session_id)
    return stable_uuid(session, 'source-turn', source_turn_id)


async def require_source_available(store, space, *, episode_id=None, source_application=None,
                                   session_id=None, source_turn_id=None):
    """Final writers call inside their knowledge-space-locked transaction.
    Completed deletions remain fences; they never authorize a renamed replay."""
    keys = [f'episode:{episode_id}'] if episode_id else []
    if source_application and session_id:
        # Reuse the provider-scoped session identity already used by task
        # contexts; a second UUID scheme would make integrity and fences drift.
        keys.append(f'session:{store._task_session_id(space["id"], source_application, session_id)}')
    if not keys:
        return
    turn = source_turn_key(store, space, source_application, session_id, source_turn_id)
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (trace:FuliKnowledgeAudit {space_id: $space_id, action: 'hard_delete'})
        WHERE any(key IN $keys WHERE key IN coalesce(trace.deleted_item_keys, []))
           OR ($episode_id IS NOT NULL AND $episode_id IN coalesce(trace.removed_episode_ids, []))
           OR ($source_turn_key IS NOT NULL AND $source_turn_key IN coalesce(trace.deleted_source_turn_keys, []))
        RETURN count(trace) > 0 AS deleted
        ''', space_id=space['id'], keys=keys, episode_id=episode_id, source_turn_key=turn, routing_='r')
    if records and records[0]['deleted']:
        raise HTTPException(status_code=410, detail={'code': 'source_hard_deleted'})
