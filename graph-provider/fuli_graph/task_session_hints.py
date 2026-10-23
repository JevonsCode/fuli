"""Hints a task entry shows at most once per host session (rec#10 D-26.4).

The session is the trusted client identity the task context already keys on
(space, client, native session), never the per-task token, so every entry of
one conversation shares one claim. A claim locks the session first, like a
checkpoint, and decides on what it reads after the lock: concurrent entries
cannot both win. Only the operation and the time are kept, in the claiming
task's own record, which every later rewrite of that record carries forward.
"""
import json

from .provider_values import now_utc
from .store_transactions import query_store_transaction
from .task_context_coordination import task_context_json
from .task_worker_attribution import lock_checkpoint_context

HINTS_KEY = 'session_hints'


async def claim_session_hint(store, actor: dict, token: str, request) -> dict:
    """claimed is True for exactly one current entry of the session; a
    superseded task (404) or an earlier claim of the operation gets nothing."""
    store._require_personal()
    await store.authorize(actor, request.personal_space_id, 'maintainer')
    async with query_store_transaction(store) as scoped:
        await lock_checkpoint_context(scoped, request.personal_space_id, token)
        record = await scoped.get_task_context(actor, request.personal_space_id, token,
                                               request.source_application)
        rows, _, _ = await scoped.runtime.driver.execute_query(
            '''
            MATCH (:FuliSpace {id: $space_id, kind: 'personal'})-[:HAS_TASK_CONTEXT_SESSION]->
                  (session:FuliTaskContextSession)-[:HAS_CONTEXT]->(:FuliTaskContext {token: $token})
            MATCH (session)-[:HAS_CONTEXT]->(task:FuliTaskContext)
            WHERE task.record_json CONTAINS $key
            RETURN task.record_json AS record_json
            ''', space_id=request.personal_space_id, token=token, key=f'"{HINTS_KEY}"')
        if any(hint.get('operation') == request.operation
               for row in rows for hint in json.loads(row['record_json']).get(HINTS_KEY) or []):
            return {'claimed': False}
        record[HINTS_KEY] = [*(record.get(HINTS_KEY) or []),
                             {'operation': request.operation, 'at': now_utc().isoformat()}]
        await scoped.runtime.driver.execute_query(
            '''
            MATCH (task:FuliTaskContext {personal_space_id: $space_id, token: $token})
            SET task.record_json = $record_json
            ''', space_id=request.personal_space_id, token=token, record_json=task_context_json(record))
        return {'claimed': True}
