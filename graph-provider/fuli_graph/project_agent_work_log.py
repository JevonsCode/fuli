"""Recover bounded employee work records independently of distilled memory updates."""

import json


async def read_employee_work_log(store, space_id, project_id, agent_id):
    rows, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (:FuliSpace {id: $space_id})-[:HAS_TASK_CONTEXT_SESSION]->
              (session:FuliTaskContextSession)-[:HAS_CONTEXT]->(task:FuliTaskContext)
        WHERE task.personal_project_id = $project_id AND task.project_agent_id = $agent_id
        RETURN task.record_json AS record_json, task.completed AS completed,
               task.agent_memory_claimed AS memory_updated,
               task.token = session.current_token AS current
        ORDER BY task.created_at DESC, task.token LIMIT 6
        ''', space_id=space_id, project_id=project_id, agent_id=agent_id, routing_='r',
    )
    result = []
    for row in rows:
        record = json.loads(row['record_json'])
        checkpoint = record.get('checkpoint') or {}
        log = checkpoint.get('work_log') or {}
        result.append({
            'task_context_token': record['token'],
            'source_application': record['source_application'],
            'session_id': record['session_id'],
            'created_at': record['created_at'],
            'status': (log.get('status', 'unreported') if row['completed']
                       else 'running' if row.get('current') else 'incomplete'),
            'summary': log.get('summary') or checkpoint.get('reason')
                or 'The employee has not submitted a work summary for this task.',
            'memory_updated': bool(row.get('memory_updated')),
        })
    return result
