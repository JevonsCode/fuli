"""Narrow one stored task's write to the projects it can change (project_write_gate.py).

A task's activity, its block, its close and its verification write the task,
its events, verifications and attention requests (all in the task's project),
this computer's executor and session records (local only) and, when the task
ends, its FLA loans (their source and target projects) and the assignments of
its temporary FLA (the projects they are in). The projects are read from the
stored task before the transaction opens and read again before it commits:
an effect beyond them, or a task in another project than the caller named,
is refused and rolled back.
"""
from contextlib import asynccontextmanager

from fastapi import HTTPException

from .project_write_gate import gate_space_directory, project_targets
from .store_transactions import query_store_transaction

_TASK_PROJECTS = '''
MATCH (:FuliSpace {id: $space_id, kind: 'personal'})-[:HAS_PROJECT_AGENT_TASK]->
      (task:FuliProjectAgentTask {personal_space_id: $space_id, task_id: $task_id})
OPTIONAL MATCH (loan:FuliAgentLoan {space: $space_id, task_id: $task_id})
WITH task, collect(loan.source_project) + collect(loan.target_project) AS loans
OPTIONAL MATCH (task)-[:HAS_PARTICIPANT]->(:FuliProjectAgent {agent_type: 'temporary', temporary_task_id: $task_id})
      <-[:ASSIGNED_AGENT]-(:FuliProjectAgentAssignment)<-[:HAS_PROJECT_AGENT_ASSIGNMENT]-(assigned:FuliPersonalProject)
WITH task, loans, collect(assigned.project_id) AS assigned
OPTIONAL MATCH (:FuliSpace {id: $space_id})-[:HAS_AGENT_ATTENTION]->(request:FuliAgentAttention {task_id: $task_id})
WITH task, loans, assigned, collect(request.personal_project_id) AS requests
RETURN task.personal_project_id AS project, loans + assigned + requests AS related
'''


async def task_projects(driver, space_id, task_id, project_id=None):
    rows, _, _ = await driver.execute_query(_TASK_PROJECTS, space_id=space_id, task_id=task_id, routing_='r')
    if not rows:
        # No such task: the write that follows finds nothing either.
        return {project_id} if project_id else set()
    if project_id and rows[0]['project'] != project_id:
        raise HTTPException(status_code=404, detail='project Agent task not found')
    return {rows[0]['project'], *(project for project in rows[0]['related'] if project)}


@asynccontextmanager
async def task_transaction(store, space_id, task_id, project_id=None):
    """One transaction writing this task, admitted for the projects it can change."""
    if gate_space_directory(getattr(store, 'settings', None), space_id) is None:
        async with query_store_transaction(store) as scoped:
            yield scoped
        return
    projects = await task_projects(store.runtime.driver, space_id, task_id, project_id)
    with project_targets(space_id, projects):
        async with query_store_transaction(store) as scoped:
            yield scoped
            if not await task_projects(scoped.runtime.driver, space_id, task_id, project_id) <= projects:
                raise HTTPException(409, detail={'code': 'project_scope_changed'})
