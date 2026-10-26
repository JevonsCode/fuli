"""Close unclaimed routine fallback entries under their existing session lock."""

import hashlib
import json

from .task_context_models import TaskContextCheckpoint


AUTO_CLOSE_SUMMARY = 'Auto-closed at the next task entry: the Agent recorded no checkpoint for this routine fallback task.'
NATIVE_APPLICATIONS = {'codex', 'claude', 'claude_code', 'cursor', 'kiro', 'opencode'}


def routine_fallback_eligible(record, *, protected=False, claimed=False):
    # Missing entry provenance is legacy unknown. A display/source label is
    # never evidence that a worker is authorized or safe to close.
    return bool(record and record.get('entry_via') == 'tool'
                and record.get('source_application') in NATIVE_APPLICATIONS
                and record.get('checkpoint') is None and not claimed and not protected
                and record.get('agent_memory_scope') != 'task_only'
                and not record.get('activity_origin')
                and not record.get('coordination_task_id')
                and not record.get('coordination_task_ids'))


async def routine_context_state(store, space_id, session_id):
    rows, _, _ = await store.runtime.driver.execute_query('''
        MATCH (:FuliSpace {id: $space_id})-[:HAS_TASK_CONTEXT_SESSION]->
          (session:FuliTaskContextSession {id: $session_id})-[:HAS_CONTEXT]->(task:FuliTaskContext)
        WHERE task.token = session.current_token
        RETURN task.record_json AS record_json,
          task.fingerprint IS NOT NULL OR coalesce(task.completed, false) AS claimed,
          EXISTS { MATCH (task)-[:FOR_WORKER_RUN|AUTHORIZES_WORKER_RUN|COORDINATES_TASK]->() } AS protected
        ''', space_id=space_id, session_id=session_id)
    if not rows:
        return None, False
    row = rows[0]
    record = json.loads(row['record_json'])
    return record, routine_fallback_eligible(record, protected=row['protected'], claimed=row['claimed'])


async def close_previous_routine_fallback(store, actor, request):
    session_id = store._task_session_id(request.personal_space_id, request.source_application, request.session_id)
    record, eligible = await routine_context_state(store, request.personal_space_id, session_id)
    if not eligible or record['token'] == request.token \
            or (request.turn_id is not None and record.get('turn_id') == request.turn_id):
        return
    # Same transaction and session lock as the new entry. The normal checkpoint
    # path freezes ownership/evidence and writes the truthful work log; a failed
    # entry rolls it back. No capture, memory, usage or model call is invented.
    await store._checkpoint_task_context(actor, record['token'], TaskContextCheckpoint(
        personal_space_id=request.personal_space_id, source_application=request.source_application,
        phase='complete', disposition='retain_nothing', reason=AUTO_CLOSE_SUMMARY,
        fingerprint=hashlib.sha256(f'{record["token"]}:routine-auto-close-v1'.encode()).hexdigest(),
        work_log={'status': 'reported', 'summary': AUTO_CLOSE_SUMMARY}))
