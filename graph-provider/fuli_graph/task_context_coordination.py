"""Durable parent-task associations; links are scope metadata, not worker evidence."""

import json

from fastapi import HTTPException

from .personal_project_access import authorize_personal_project
from .project_agent_access import authorize_project_agent
from .store_transactions import query_store_transaction
from .client_coverage import covers_client


def task_context_record(row):
    record = json.loads(row['record_json'])
    # Relationships are authoritative for new links. The old adoption pointer
    # remains readable and keeps its original task-only owner semantics.
    ids = set(row.get('coordination_task_ids') or [])
    if record.get('coordination_task_id'):
        ids.add(record['coordination_task_id'])
    record.pop('coordination_task_ids', None)
    if ids:
        record['coordination_task_ids'] = sorted(ids)
    return record


def task_context_json(record):
    # Never copy the relationship projection into a checkpoint's JSON snapshot:
    # a concurrent link must not be overwritten by an older checkpoint read.
    return json.dumps({key: value for key, value in record.items()
                      if key != 'coordination_task_ids'}, ensure_ascii=False)


async def bind_coordination_task(store, actor, token, request):
    async with query_store_transaction(store) as scoped:
        scoped._require_personal()
        space = await scoped.authorize(actor, request.personal_space_id, 'maintainer')
        record = await scoped.get_task_context(actor, request.personal_space_id, token,
                                               request.source_application)
        if record['personal_project_id'] != request.personal_project_id:
            raise HTTPException(409, 'Task context belongs to another project')
        await authorize_personal_project(scoped, actor, space, request.personal_project_id)
        owner_id, owner_profile, owner_assignment_id = record.get('project_agent_id'), None, None
        if owner_id:
            owner = await authorize_project_agent(scoped, actor, space, request.personal_project_id,
                                                  owner_id, require_active=True)
            owner_profile = owner['profile_json']
            owner_assignment_id = owner['active_assignment_id']
            if not covers_client(json.loads(owner_profile).get('allowed_clients', []), request.source_application):
                raise HTTPException(403, 'Task owner is not allowed in this client')
        # Lock order: session, context, coordination task, owner, assignment, policy.
        # Permission withdrawal cannot commit between validation and the link.
        # An unowned adoption must reach its Agent before taking any policy lock.
        rows, _, _ = await scoped.runtime.driver.execute_query(
            '''
            MATCH (space:FuliSpace {id: $space_id, kind: 'personal'})-[:HAS_TASK_CONTEXT_SESSION]->
                  (session:FuliTaskContextSession)-[:HAS_CONTEXT]->(context:FuliTaskContext {token: $token})
            SET session.write_serial = coalesce(session.write_serial, 0) + 1
            WITH space, session, context
            WHERE session.current_token = context.token AND context.personal_project_id = $project_id
            SET context.write_serial = coalesce(context.write_serial, 0) + 1
            WITH space, context
            MATCH (space)-[:HAS_PROJECT_AGENT_TASK]->(task:FuliProjectAgentTask {
              task_id: $task_id, personal_project_id: $project_id})
            SET task._task_lifecycle_lock = true
            REMOVE task._task_lifecycle_lock
            WITH space, context, task
            OPTIONAL MATCH (space)-[:HAS_PROJECT_AGENT_IDENTITY]->(owner:FuliProjectAgent {agent_id: $owner_id})
            SET owner._task_lifecycle_lock = true
            REMOVE owner._task_lifecycle_lock
            WITH space, context, task, owner
            OPTIONAL MATCH (space)-[:CONTAINS_PROJECT]->(:FuliPersonalProject {project_id: $project_id})-
                          [:HAS_PROJECT_AGENT_ASSIGNMENT]->
                          (assignment:FuliProjectAgentAssignment {assignment_id: $owner_assignment_id})-
                          [:ASSIGNED_AGENT]->(owner)
            WITH space, context, task, owner, assignment ORDER BY assignment.id
            SET assignment._task_lifecycle_lock = true
            REMOVE assignment._task_lifecycle_lock
            WITH space, context, task, owner, collect(assignment) AS assignments
            OPTIONAL MATCH (space)-[:CONTAINS_PROJECT]->(:FuliPersonalProject {project_id: $project_id})-
                           [:HAS_PROJECT_AGENT_COORDINATION_POLICY]->(policy:FuliProjectAgentCoordinationPolicy)
            WHERE $owner_id IS NOT NULL
            SET policy._fuli_write_lock = true
            REMOVE policy._fuli_write_lock
            WITH context, task, owner, assignments, policy
            WHERE ((context.project_agent_id IS NULL AND $owner_id IS NULL)
                   OR context.project_agent_id = $owner_id)
              AND ($owner_id IS NULL OR (
                ($owner_id IN [task.coordinator_agent_id, task.lead_agent_id]
                 OR policy.team_lead_agent_id = $owner_id)
                AND owner.status = 'active' AND owner.profile_json = $owner_profile
                AND any(assignment IN assignments WHERE assignment.status = 'active')))
              AND ($adoption_lead IS NULL OR task.lead_agent_id = $adoption_lead)
              AND (EXISTS { MATCH (context)-[:COORDINATES_TASK]->(task) } OR $legacy_retry
                   OR (context.fingerprint IS NULL AND NOT context.completed))
            RETURN context.token AS token
            ''', space_id=request.personal_space_id, project_id=request.personal_project_id,
            token=token, task_id=request.task_id,
            owner_id=owner_id, owner_profile=owner_profile, owner_assignment_id=owner_assignment_id,
            adoption_lead=getattr(request, 'agent_id', None),
            legacy_retry=record.get('coordination_task_id') == request.task_id)
        if not rows:
            raise HTTPException(409, 'Coordination task scope or parent lifecycle does not match')
        rows, _, _ = await scoped.runtime.driver.execute_query(
            '''
            MATCH (context:FuliTaskContext {token: $token, personal_space_id: $space_id})
            MATCH (:FuliSpace {id: $space_id})-[:HAS_PROJECT_AGENT_TASK]->
                  (task:FuliProjectAgentTask {task_id: $task_id, personal_project_id: $project_id})
            MERGE (context)-[binding:COORDINATES_TASK]->(task)
            ON CREATE SET binding.bound_at = datetime(), binding.task_revision = task.revision
            RETURN context.token AS token
            ''', space_id=request.personal_space_id, project_id=request.personal_project_id,
            token=token, task_id=request.task_id)
        if not rows:
            raise HTTPException(409, 'Coordination task association is unavailable')
        return await scoped.get_task_context(actor, request.personal_space_id, token, request.source_application)
