"""Retain project task history without carrying an active native session."""
from fastapi import HTTPException

from .provider_values import stable_uuid
from .scope_import import _batches, _run


async def check_task_history(tx, space, project):
    rows = await _run(tx, """
        MATCH (:FuliSpace {id:$space})-[:HAS_TASK_CONTEXT_SESSION]->(s:FuliTaskContextSession)
              -[:HAS_CONTEXT]->(t:FuliTaskContext {personal_project_id:$project})
        WHERE s.current_token=t.token AND NOT coalesce(t.completed,false)
        RETURN count(t) AS active
        """, space=space, project=project)
    if rows[0]['active']:
        raise HTTPException(409, detail={'code': 'project_tasks_still_active', 'count': rows[0]['active']})


async def archive_task_history(tx, space, project, move_id, ids):
    """Keep other projects on the same session, and all business records intact."""
    if not ids:
        return
    await check_task_history(tx, space, project)
    archive = stable_uuid('fuli-project-history-session', space, project, move_id)
    await _run(tx, """
        MATCH (space:FuliSpace {id:$space})
        MERGE (s:FuliTaskContextSession {id:$archive})
        ON CREATE SET s.write_serial=0
        MERGE (space)-[:HAS_TASK_CONTEXT_SESSION]->(s)
        """, space=space, archive=archive)
    for chunk in _batches(sorted(ids)):
        await _run(tx, """
            MATCH (space:FuliSpace {id:$space})-[:HAS_TASK_CONTEXT_SESSION]->(old:FuliTaskContextSession)
                  -[link:HAS_CONTEXT]->(task:FuliTaskContext {personal_project_id:$project})
            WHERE elementId(task) IN $ids AND old.id<>$archive
            FOREACH (_ IN CASE WHEN old.current_token=task.token THEN [1] ELSE [] END | REMOVE old.current_token)
            DELETE link
            """, space=space, project=project, ids=chunk, archive=archive)
        rows = await _run(tx, """
            MATCH (:FuliSpace {id:$space})-[:HAS_TASK_CONTEXT_SESSION]->(s:FuliTaskContextSession {id:$archive})
            WHERE s.current_token IS NULL
            MATCH (task:FuliTaskContext {personal_space_id:$space, personal_project_id:$project})
            WHERE elementId(task) IN $ids
            MERGE (s)-[:HAS_CONTEXT]->(task)
            RETURN count(task) AS archived
            """, space=space, project=project, ids=chunk, archive=archive)
        if not rows or rows[0]['archived'] != len(chunk):
            raise HTTPException(409, detail={'code': 'project_history_incomplete'})
