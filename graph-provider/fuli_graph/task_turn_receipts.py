"""Delivery of a turn's knowledge receipt, exactly once (rec#20).

A completed checkpoint that saved knowledge leaves its receipt unread. The
checkpoint's own reply claims it; when that reply never carried it (the call
failed after saving, or the host could not append it), the next task entry of
the same session claims it instead. A claim names its claimant, so a retry of
the same call gets the same receipts again and nobody else ever does.
"""
import json


async def mark_turn_receipt_unread(store, space_id: str, token: str, capture_results) -> None:
    """Call inside the checkpoint's transaction, after it completed."""
    if not any(result.status == 'committed' for result in capture_results or []):
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
        WITH task, task.turn_receipt_state AS state, task.turn_receipt_claimant AS claimant
        SET task.turn_receipt_state = CASE WHEN state = 'unread' THEN 'delivered' ELSE state END,
            task.turn_receipt_claimant = CASE WHEN state = 'unread' THEN $token ELSE claimant END
        RETURN state, claimant
        ''', space_id=request.personal_space_id, token=token)
    if not records:
        return {'deliver': False}
    state, claimant = records[0]['state'], records[0]['claimant']
    return {'deliver': state == 'unread' or claimant == token}


async def claim_session_turn_receipts(store, session_node_id: str, token: str) -> list[dict]:
    """A new entry claims receipts its session's earlier turns never delivered.
    Call inside the entry's transaction, with the session locked."""
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (:FuliTaskContextSession {id: $session_id})-[:HAS_CONTEXT]->(task:FuliTaskContext)
        WHERE task.token <> $token
          AND (task.turn_receipt_state = 'unread' OR task.turn_receipt_claimant = $token)
        SET task.turn_receipt_state = 'delivered', task.turn_receipt_claimant = $token
        RETURN task.record_json AS record_json
        ORDER BY task.created_at
        ''', session_id=session_node_id, token=token)
    receipts = []
    for record in records:
        value = json.loads(record['record_json'])
        results = (value.get('checkpoint') or {}).get('capture_results') or []
        receipts.append({'personal_project_id': value.get('personal_project_id'),
                         'capture_results': results})
    return receipts
