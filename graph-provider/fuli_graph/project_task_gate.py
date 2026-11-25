"""Resolve task writes from the native session, stored contexts and their work."""
from contextlib import asynccontextmanager

from fastapi import HTTPException

from .knowledge_versions import lock_knowledge
from .project_feedback_gate import knowledge_item_projects
from .project_write_gate import gate_space_directory, project_targets
from .store_transactions import query_store_transaction


def moved_task_refusal():
    return HTTPException(409, detail={'code': 'project_task_moved',
        'message': 'This project moved. Enter a new task on its current owner. 项目已搬移，请在当前所有者上重新进入任务。'})


async def _projects(tx, space, session_id, token, request):
    # Entry may close the previous fallback or reuse a turn's original token.
    # A receipt claim may update older contexts in this very same session.
    rows = await tx.run('''
        CALL {
            MATCH (s:FuliTaskContextSession {id:$session})<-[:HAS_TASK_CONTEXT_SESSION]-(:FuliSpace {id:$space})
            MATCH (s)-[:HAS_CONTEXT]->(task:FuliTaskContext)
            WHERE task.token=s.current_token OR task.turn_id=$turn OR task.token=$token
            RETURN task, s
            UNION
            MATCH (current:FuliTaskContext {token:$token,personal_space_id:$space})<-[:HAS_CONTEXT]-(s:FuliTaskContextSession)
            WHERE EXISTS { MATCH (:FuliSpace {id:$space})-[:HAS_TASK_CONTEXT_SESSION]->(s) }
            RETURN current AS task, s
            UNION
            UNWIND $receipts AS receipt
            MATCH (task:FuliTaskContext {id:receipt})<-[:HAS_CONTEXT]-(s:FuliTaskContextSession)
            WHERE EXISTS { MATCH (:FuliSpace {id:$space})-[:HAS_TASK_CONTEXT_SESSION]->(s) }
              AND EXISTS { MATCH (s)-[:HAS_CONTEXT]->(:FuliTaskContext {token:$token}) }
            RETURN task, s
        }
        OPTIONAL MATCH (task)-[:COORDINATES_TASK|FOR_WORKER_RUN|AUTHORIZES_WORKER_RUN]->(work)
        RETURN DISTINCT task.personal_project_id AS project, work.personal_project_id AS work_project,
               task.token=$token AND (s.id STARTS WITH 'fuli-project-history:') AS moved,
               task.token=$token AND task.knowledge_usage_result_json IS NOT NULL AS usage_saved
        ''', space=space['id'], session=session_id, token=token, receipts=getattr(request, 'receipt_ids', []),
        turn=getattr(request, 'turn_id', None))
    records = [row async for row in rows]
    if any(row.get('moved') for row in records):
        raise moved_task_refusal()
    projects = {project for row in records for project in (row['project'], row['work_project']) if project}
    if project := getattr(request, 'personal_project_id', None):
        projects.add(project)
    items = getattr(request, 'knowledge_usage', None)
    if items and not any(row['usage_saved'] for row in records):
        projects.update(await knowledge_item_projects(tx, space, items))
    return projects


@asynccontextmanager
async def task_write_transaction(store, actor, request, token, *, entering=False):
    directory = gate_space_directory(getattr(store, 'settings', None), request.personal_space_id)
    if directory is None:
        async with query_store_transaction(store) as scoped:
            yield scoped
        return
    space = await store.authorize(actor, request.personal_space_id, 'maintainer')
    session = store._task_session_id(space['id'], request.source_application, request.session_id) if entering else None
    async with store.runtime.driver.read_transaction() as tx:
        projects = await _projects(tx, space, session, token, request)
    with project_targets(space['id'], projects):
        async with query_store_transaction(store) as scoped:
            await lock_knowledge(scoped, space)
            async with scoped.runtime.driver.transaction() as tx:
                if projects != await _projects(tx, space, session, token, request):
                    raise HTTPException(409, detail={'code': 'project_scope_changed'})
            yield scoped
