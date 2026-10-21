"""Optimistic concurrency for one knowledge item (rec#20 quick edit, rec#5 C7).

The version an editor reads is the item's edit revision: how many content,
scope and validity revisions it has. Usage and feedback change its ranking,
not what a person edits, so a page left open while the item is used still
saves (rec#20 part 2). An edit that names another revision is refused with the
current one, instead of overwriting newer content from a stale page or link.

Writers still compare-and-set fuli_ai_review_lock_version, which every writer
bumps, so two writes that race inside one request cannot both land.
"""
from fastapi import HTTPException


def lock_version(record: dict) -> int:
    return int(record.get('ai_review_lock_version') or 0)


async def edit_revision(store, space: dict, item_kind: str, item_id: str) -> int:
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (:FuliSpace {id: $space_id, kind: 'personal'})-[:HAS_KNOWLEDGE_REVISION]->
              (revision:FuliKnowledgeRevision {item_id: $item_id, item_kind: $item_kind})
        RETURN count(revision) AS revisions
        ''', space_id=space['id'], item_id=item_id, item_kind=item_kind, routing_='r')
    return int(records[0]['revisions']) if records else 0


async def require_edit_revision(store, space: dict, item_kind: str, item_id: str,
                                expected: int | None) -> None:
    if expected is None:
        return
    current = await edit_revision(store, space, item_kind, item_id)
    if expected != current:
        raise HTTPException(status_code=409, detail={
            'code': 'stale_version', 'current_version': current,
            'message': 'knowledge changed since it was read; read it again before editing',
        })
