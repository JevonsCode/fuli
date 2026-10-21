"""Delivery of a turn's knowledge receipt, exactly once (rec#20).

A completed checkpoint that saved knowledge leaves its receipt unread. The
checkpoint's own reply claims it; when that reply never carried it (the call
failed after saving, or the host could not append it), the next task entry of
the same session is told about it, reads it back and only then claims it, so a
receipt that could not be read stays unread for a later entry. A claim names
its claimant, so a retry of the same call gets the same receipts again and
nobody else ever does. Each claim locks the task first and decides on what it
reads after the lock, so a reply and an entry claiming at once cannot both win.
"""
import json

# A next entry takes at most this many late receipts; the rest stay unread for
# the entry after. At most 3 episodes each, so one batch fits a 64-episode
# full-list link and the claim's 64-ID bound.
LATE_RECEIPTS_PER_ENTRY = 20


async def mark_turn_receipt_unread(store, space_id: str, token: str, capture_results) -> None:
    """Call inside the checkpoint's transaction, after it completed. A duplicate
    is this same turn's earlier attempt: task capture keys carry the task token."""
    if not any(result.status in ('committed', 'duplicate') for result in capture_results or []):
        return
    await store.runtime.driver.execute_query(
        '''
        MATCH (task:FuliTaskContext {personal_space_id: $space_id, token: $token})
        WHERE task.completed AND task.turn_receipt_state IS NULL
        SET task.turn_receipt_state = 'unread'
        ''', space_id=space_id, token=token)


async def claim_turn_receipt(store, actor: dict, token: str, request) -> dict:
    """The checkpoint's own reply claims its receipt; deliver tells it whether
    to show it (False once another entry already delivered it)."""
    store._require_personal()
    await store.authorize(actor, request.personal_space_id, 'maintainer')
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (:FuliSpace {id: $space_id, kind: 'personal'})-[:HAS_TASK_CONTEXT_SESSION]->
              (:FuliTaskContextSession)-[:HAS_CONTEXT]->(task:FuliTaskContext {token: $token})
        SET task.turn_receipt_lock = coalesce(task.turn_receipt_lock, 0) + 1
        WITH task, task.turn_receipt_state AS state, task.turn_receipt_claimant AS claimant
        SET task.turn_receipt_state = CASE WHEN state = 'unread' THEN 'delivered' ELSE state END,
            task.turn_receipt_claimant = CASE WHEN state = 'unread' THEN $token ELSE claimant END
        RETURN state, claimant
        ''', space_id=request.personal_space_id, token=token)
    if not records:
        return {'deliver': False}
    state, claimant = records[0]['state'], records[0]['claimant']
    return {'deliver': state == 'unread' or claimant == token}


async def unread_session_turn_receipts(store, session_node_id: str, token: str) -> list[dict]:
    """Receipts this session's earlier turns never delivered, or that this same
    entry already claimed (a retry). Reading claims nothing."""
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (:FuliTaskContextSession {id: $session_id})-[:HAS_CONTEXT]->(task:FuliTaskContext)
        WHERE task.token <> $token
          AND (task.turn_receipt_state = 'unread' OR task.turn_receipt_claimant = $token)
        RETURN task.id AS receipt_id, task.record_json AS record_json
        ORDER BY coalesce(task.turn_receipt_claimant = $token, false) DESC, task.created_at
        LIMIT $limit
        ''', session_id=session_node_id, token=token, limit=LATE_RECEIPTS_PER_ENTRY)
    receipts = []
    for record in records:
        value = json.loads(record['record_json'])
        results = (value.get('checkpoint') or {}).get('capture_results') or []
        receipts.append({'receipt_id': record['receipt_id'], 'personal_project_id': value.get('personal_project_id'),
                         'capture_results': results})
    return receipts


async def claim_session_turn_receipts(store, actor: dict, token: str, request) -> dict:
    """The entry that read these receipts back claims them for its reply. Only
    receipts of its own session that are still unread, or already its own."""
    store._require_personal()
    await store.authorize(actor, request.personal_space_id, 'maintainer')
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (:FuliSpace {id: $space_id, kind: 'personal'})-[:HAS_TASK_CONTEXT_SESSION]->
              (session:FuliTaskContextSession)-[:HAS_CONTEXT]->(:FuliTaskContext {token: $token})
        MATCH (session)-[:HAS_CONTEXT]->(task:FuliTaskContext)
        WHERE task.token <> $token AND task.id IN $receipt_ids
        SET task.turn_receipt_lock = coalesce(task.turn_receipt_lock, 0) + 1
        WITH task
        WHERE task.turn_receipt_state = 'unread' OR task.turn_receipt_claimant = $token
        SET task.turn_receipt_state = 'delivered', task.turn_receipt_claimant = $token
        RETURN task.id AS receipt_id
        ''', space_id=request.personal_space_id, token=token, receipt_ids=request.receipt_ids)
    return {'claimed': [record['receipt_id'] for record in records]}
