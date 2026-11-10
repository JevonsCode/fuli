"""Corrections appended to a completed task checkpoint (rec#85).

A checkpoint stays immutable: a retry with other input is still refused. An
amendment is the one supported correction of a checkpoint sent too early. It
names only a new reason and work log, is appended under the original, and is
accepted only while the task is still its session's current task. Capture
decisions, receipts and memory writes of the original are never touched.
"""

from fastapi import HTTPException

from .provider_values import now_utc
from .task_context_coordination import task_context_json, task_context_record
from .task_worker_attribution import lock_checkpoint_context

MAX_AMENDMENTS = 5


def checkpoint_amendment(checkpoint, request):
    """The amendment entry to append, or None when this one is already kept (a retry)."""
    if checkpoint.get('phase') != 'complete':
        raise HTTPException(409, 'Only a completed checkpoint can be amended; '
                                 'finish it first by resending its exact first arguments')
    if request.disposition != checkpoint.get('disposition'):
        raise HTTPException(409, 'An amendment keeps the checkpoint disposition; capture decisions cannot change')
    amendments = checkpoint.get('amendments') or []
    if request.fingerprint == checkpoint.get('fingerprint') or any(
            item.get('fingerprint') == request.fingerprint for item in amendments):
        return None
    if len(amendments) >= MAX_AMENDMENTS:
        raise HTTPException(409, f'This checkpoint already has {MAX_AMENDMENTS} amendments; '
                                 'record further work in a new task context')
    entry = {'fingerprint': request.fingerprint, 'reason': request.reason,
             'amended_at': now_utc().isoformat()}
    if request.work_log is not None:
        entry['work_log'] = request.work_log.model_dump()
    return entry


async def amend_task_checkpoint(store, actor, token, request):
    await store.authorize(actor, request.personal_space_id, 'maintainer')
    await lock_checkpoint_context(store, request.personal_space_id, token)
    # Reads only the session's current task of this client: an amendment never
    # reaches a superseded task or another client's token.
    record = await store.get_task_context(actor, request.personal_space_id, token, request.source_application)
    if record.get('work_log_required') and request.work_log is None:
        raise HTTPException(422, 'Employee work summary is required before amending')
    checkpoint = dict(record.get('checkpoint') or {})
    entry = checkpoint_amendment(checkpoint, request)
    if entry is None:
        return record
    checkpoint['amendments'] = [*(checkpoint.get('amendments') or []), entry]
    record['checkpoint'] = checkpoint
    rows, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (:FuliSpace {id: $space_id, kind: 'personal'})-
              [:HAS_TASK_CONTEXT_SESSION]->(session:FuliTaskContextSession)-
              [:HAS_CONTEXT]->(task:FuliTaskContext {token: $token})
        WHERE session.current_token = task.token AND task.completed
        SET session.write_serial = coalesce(session.write_serial, 0) + 1,
            task.write_serial = coalesce(task.write_serial, 0) + 1,
            task.record_json = $record_json
        RETURN task.record_json AS record_json,
               [(task)-[:COORDINATES_TASK]->(linked:FuliProjectAgentTask) | linked.task_id] AS coordination_task_ids
        ''', space_id=request.personal_space_id, token=token, record_json=task_context_json(record),
    )
    if not rows:
        raise HTTPException(409, 'Task checkpoint was superseded before the amendment')
    return task_context_record(rows[0])
