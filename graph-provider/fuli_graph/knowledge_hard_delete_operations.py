"""The outcome of one console's delete operation (rec#5 C9, dot round 3).

A console names each delete it sends with its own operation ID. The graph
keeps a durable, linearizable answer for that ID, so a console whose answer
was lost never has to guess:

- committed: the deletion trace carries the operation ID; it is written in
  the delete's own transaction, so it exists exactly when the delete did;
- refused: the graph refused it (stale preview, missing confirmation, the item
  missing or already deleted). The refusal is decided before anything is
  written and persisted in that same transaction, under the space's
  knowledge lock, so it is never visible while a delete of the operation runs;
- aborted: the console gave up on it. An abort takes the space's knowledge
  lock, which the delete holds from its first statement to its commit, so it
  waits for a delete that is running and wins only when none committed; a
  delete that arrives after the abort finds it under the same lock and is
  refused;
- unknown: none of these yet (not arrived, or still running).

Every outcome is final. An operation ID is bound to the request that first
reached a decision with it (target, kind, preview and a digest of the typed
confirmation): a later request with that ID gets the recorded outcome without
running (an exact replay of a commit answers the same deletion) or 409, and a
different request with it is `operation_mismatch`. Deciding and recording
happen under the space's knowledge lock, so one operation is decided once.

The records hold no words: the operation ID, the state, the refusal code, the
request fingerprint (a digest), the time and who asked. They reuse the audit
label (action `hard_delete_refused` / `hard_delete_aborted`) and carry no
item ID.
"""
import json

from fastapi import HTTPException

from .knowledge_hard_delete_models import KnowledgeHardDeleteOperation
from .knowledge_hard_delete_traces import deletion_record_of
from .knowledge_versions import lock_knowledge
from .provider_values import now_utc, sha256_text, stable_uuid
from .store_transactions import query_store_transaction

_RECORDED = {'hard_delete_refused': 'refused', 'hard_delete_aborted': 'aborted'}


async def operation_outcome(store, space, operation_id) -> KnowledgeHardDeleteOperation:
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (record:FuliKnowledgeAudit {space_id: $space_id})
        WHERE record.operation_id = $operation_id
          AND record.action IN ['hard_delete', 'hard_delete_refused', 'hard_delete_aborted']
        RETURN record ORDER BY record.created_at
        ''', space_id=space['id'], operation_id=operation_id, routing_='r')
    found = [dict(record['record']) for record in records]
    committed = next((record for record in found if record['action'] == 'hard_delete'), None)
    if committed is not None:
        return KnowledgeHardDeleteOperation(operation_id=operation_id, state='committed',
                                            deletion=deletion_record_of(committed))
    if found:
        return KnowledgeHardDeleteOperation(operation_id=operation_id, state=_RECORDED[found[0]['action']],
                                            code=found[0].get('outcome'))
    return KnowledgeHardDeleteOperation(operation_id=operation_id, state='unknown')


def operation_fingerprint(item_id, request) -> str:
    """What an operation ID is bound to; the confirmation only as a digest."""
    return sha256_text(json.dumps({
        'item_kind': request.item_kind, 'item_id': item_id, 'preview_id': request.preview_id,
        'confirmation': sha256_text(request.confirmation.strip()),
    }, sort_keys=True, separators=(',', ':')))


async def settled_operation(scoped, space, operation_id, fingerprint):
    """Inside a delete's transaction, after the knowledge lock: None when the
    operation has no outcome yet, the recorded deletion for an exact replay of
    its commit, otherwise a 409 that names the outcome it keeps."""
    records, _, _ = await scoped.runtime.driver.execute_query(
        '''
        MATCH (record:FuliKnowledgeAudit {space_id: $space_id})
        WHERE record.operation_id = $operation_id
          AND record.action IN ['hard_delete', 'hard_delete_refused', 'hard_delete_aborted']
        RETURN record ORDER BY record.created_at
        ''', space_id=space['id'], operation_id=operation_id)
    found = [dict(record['record']) for record in records]
    if not found:
        return None
    outcome = await operation_outcome(scoped, space, operation_id)
    decided = next((record for record in found if record['action'] == 'hard_delete'), found[0])
    if outcome.state != 'aborted' and decided.get('operation_fingerprint') != fingerprint:
        raise HTTPException(status_code=409, detail={
            'code': 'operation_mismatch', 'state': outcome.state,
            'message': 'this operation ID belongs to a different delete request'})
    if outcome.state == 'committed':
        return outcome.deletion
    raise HTTPException(status_code=409, detail={
        'code': 'hard_delete_aborted' if outcome.state == 'aborted' else 'hard_delete_operation_closed',
        'state': outcome.state, 'refusal': outcome.code,
        'message': f'this delete operation was already {outcome.state}; it is not run again'})


async def record_refusal(scoped, actor, space, operation_id, code, fingerprint) -> None:
    """Inside the locked transaction that decided the refusal."""
    await _record(scoped, actor, space, operation_id, 'hard_delete_refused', code, fingerprint)


async def abort_operation(store, actor, space, operation_id) -> KnowledgeHardDeleteOperation:
    async with query_store_transaction(store) as scoped:
        # Waits for a delete of this space that holds the lock until it ends.
        await lock_knowledge(scoped, space)
        outcome = await operation_outcome(scoped, space, operation_id)
        if outcome.state != 'unknown':
            return outcome
        await _record(scoped, actor, space, operation_id, 'hard_delete_aborted', 'aborted', None)
    return KnowledgeHardDeleteOperation(operation_id=operation_id, state='aborted', code='aborted')


async def _record(store, actor, space, operation_id, action, code, fingerprint) -> None:
    await store.runtime.driver.execute_query(
        '''
        MATCH (space:FuliSpace {id: $space_id, kind: 'personal'})
        MERGE (record:FuliKnowledgeAudit {id: $record_id})
        ON CREATE SET record.space_id = $space_id, record.operation_id = $operation_id, record.action = $action,
                      record.outcome = $code, record.operation_fingerprint = $fingerprint,
                      record.operation_actor = 'human', record.created_by = $created_by,
                      record.created_at = $created_at
        MERGE (space)-[:HAS_KNOWLEDGE_AUDIT]->(record)
        ''', space_id=space['id'], record_id=stable_uuid(space['id'], 'hard-delete-operation', operation_id),
        operation_id=operation_id, action=action, code=code, fingerprint=fingerprint, created_by=actor['id'],
        created_at=now_utc())
