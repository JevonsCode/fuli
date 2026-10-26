"""One canonical content-free shape for retained source task/work-log metadata."""
import json

WORK_LOG_CLEARED = 'Work summary cleared with its source.'
_IDENTITY = ('token', 'personal_space_id', 'personal_project_id', 'project_agent_id',
             'source_application', 'session_id', 'turn_id', 'created_at')
_LOG_STATUSES = {'reported', 'completed', 'incomplete', 'failed', 'no_change', 'unreported'}
_CHECKPOINT_VALUES = {'phase': {'prepare', 'complete'}, 'disposition': {'capture_candidates', 'retain_nothing'}}
_BODY_PROPERTIES = ('reason', 'fingerprint', 'knowledge_usage_json', 'knowledge_usage_result_json')


def cleared_task_record(old):
    record = {key: old[key] for key in _IDENTITY if key in old}
    checkpoint = old.get('checkpoint') or {}
    log = checkpoint.get('work_log') or {}
    status = log.get('status', 'unreported')
    record['checkpoint'] = {key: checkpoint[key] for key, allowed in _CHECKPOINT_VALUES.items()
                            if checkpoint.get(key) in allowed}
    record['checkpoint']['work_log'] = {'status': status if status in _LOG_STATUSES else 'unreported',
                                       'summary': WORK_LOG_CLEARED}
    return record


def task_shell_is_body_free(task):
    """A deletion marker alone is not proof that an old body was not restored."""
    if not task.get('scrubbed_by') or any(task.get(key) is not None for key in _BODY_PROPERTIES):
        return False
    try:
        record = json.loads(task['record_json'])
        log = json.loads(task['work_log_json'])
        return (isinstance(record, dict) and record == cleared_task_record(record)
                and record.get('token') == task.get('token')
                and record.get('personal_space_id') == task.get('personal_space_id')
                and log == record['checkpoint']['work_log'])
    except (TypeError, ValueError, KeyError, AttributeError):
        return False


async def scrub_source_tasks(store, space, task_ids, deletion_id):
    rows, _, _ = await store.runtime.driver.execute_query(
        '''MATCH (task:FuliTaskContext {personal_space_id: $space_id})
           WHERE task.id IN $task_ids
           RETURN task.id AS id, task.record_json AS record_json''', space_id=space['id'], task_ids=task_ids)
    for task in rows:
        record = cleared_task_record(json.loads(task['record_json']))
        await store.runtime.driver.execute_query(
            '''MATCH (task:FuliTaskContext {id: $id, personal_space_id: $space_id})
               SET task.record_json=$record, task.work_log_json=$work_log,
                   task.scrubbed_by=coalesce(task.scrubbed_by, $deletion_id)
               REMOVE task.reason, task.fingerprint, task.knowledge_usage_json, task.knowledge_usage_result_json''',
            id=task['id'], space_id=space['id'], record=json.dumps(record, ensure_ascii=False),
            work_log=json.dumps(record['checkpoint']['work_log'], ensure_ascii=False), deletion_id=deletion_id)
