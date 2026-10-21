"""Reading the content-free traces hard deletes leave (rec#5 C9).

A trace is a FuliKnowledgeAudit with action `hard_delete`: when, by whom, the
kind, counts and opaque IDs (each removed item as `<kind>:<id>`, the source
episodes it had, the episodes that were removed). It never holds words. Old
links and receipts read it to say 「已彻底删除」 instead of not found, a
conclusion names a removed basis as deleted, and a replayed capture of a
removed episode is not written again.
"""
import json

from fastapi import HTTPException

from .knowledge_hard_delete_models import KnowledgeHardDeleteCounts, KnowledgeHardDeleteRecord
from .provider_values import native_datetime, stable_uuid


async def hard_deletion_record(store, space, item_id) -> KnowledgeHardDeleteRecord | None:
    """The trace of the latest hard delete that removed this item ID, if any."""
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (trace:FuliKnowledgeAudit {space_id: $space_id, action: 'hard_delete'})
        WHERE any(key IN coalesce(trace.deleted_item_keys, []) WHERE key ENDS WITH (':' + $item_id))
        RETURN trace ORDER BY trace.created_at DESC LIMIT 1
        ''', space_id=space['id'], item_id=item_id, routing_='r')
    if not records:
        return None
    trace = dict(records[0]['trace'])
    return KnowledgeHardDeleteRecord(
        deletion_id=trace['id'], item_kind=trace['item_kind'], item_id=trace['item_id'],
        deleted_at=native_datetime(trace['created_at']),
        counts=KnowledgeHardDeleteCounts(**json.loads(trace.get('deletion_counts_json') or '{}')),
        deleted_item_ids=[key.split(':', 1)[1] for key in trace.get('deleted_item_keys') or []])


async def require_not_hard_deleted(store, space, item_id) -> None:
    """An old link to a deleted item answers 410 with the trace, not 404."""
    deletion = await hard_deletion_record(store, space, item_id)
    if deletion is not None:
        raise HTTPException(status_code=410, detail={
            'code': 'hard_deleted', 'message': 'this knowledge was permanently deleted by its owner',
            'deleted_at': deletion.deleted_at.isoformat()})


async def fresh_identities(store, space, item_ids) -> dict[str, str]:
    """For each stated ID a hard delete removed, the ID a new statement takes
    instead: a new generation salted with that deletion, again for as many
    deletes as the chain had. The deleted ID itself is never written again,
    so an old link stays 已彻底删除 and an old basis stays deleted. The same
    statement against the same traces always gets the same ID (replays)."""
    if not item_ids:
        return {}
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (trace:FuliKnowledgeAudit {space_id: $space_id, action: 'hard_delete'})
        UNWIND coalesce(trace.deleted_item_keys, []) AS key
        RETURN split(key, ':')[1] AS item_id, trace.id AS deletion_id ORDER BY trace.created_at
        ''', space_id=space['id'], routing_='r')
    # The latest delete of each ID decides its next generation.
    deletions = {record['item_id']: record['deletion_id'] for record in records}
    renamed = {}
    for item_id in item_ids:
        current, seen = item_id, set()
        while current in deletions and current not in seen:
            seen.add(current)
            current = stable_uuid(current, 'after-hard-delete', deletions[current])
        if current != item_id:
            renamed[item_id] = current
    return renamed


async def hard_deleted_kinds(store, space, item_ids) -> dict[str, str]:
    """For each of these IDs a hard delete removed, its item kind."""
    if not item_ids:
        return {}
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (trace:FuliKnowledgeAudit {space_id: $space_id, action: 'hard_delete'})
        UNWIND coalesce(trace.deleted_item_keys, []) AS key
        WITH key WHERE split(key, ':')[1] IN $item_ids
        RETURN DISTINCT key
        ''', space_id=space['id'], item_ids=list(item_ids), routing_='r')
    return {record['key'].split(':', 1)[1]: record['key'].split(':', 1)[0] for record in records}


async def hard_deletions_in_episodes(store, space, episode_ids) -> list[str]:
    """The hard deletes that removed something these episodes had recorded,
    by deletion ID, so a reader of several batches counts each once."""
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (trace:FuliKnowledgeAudit {space_id: $space_id, action: 'hard_delete'})
        WHERE any(id IN coalesce(trace.evidence_ids, []) WHERE id IN $episode_ids)
        RETURN trace.id AS deletion_id ORDER BY deletion_id
        ''', space_id=space['id'], episode_ids=list(episode_ids), routing_='r')
    return [record['deletion_id'] for record in records]


async def episode_hard_deleted(store, space, episode_id) -> bool:
    """Whether a hard delete removed this episode: a replayed capture (same
    idempotency key, so the same episode ID) must not write it again."""
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (trace:FuliKnowledgeAudit {space_id: $space_id, action: 'hard_delete'})
        WHERE $episode_id IN coalesce(trace.removed_episode_ids, [])
        RETURN count(trace) > 0 AS deleted
        ''', space_id=space['id'], episode_id=episode_id, routing_='r')
    return bool(records and records[0]['deleted'])
