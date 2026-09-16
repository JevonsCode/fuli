"""Claim an initially unassigned task after recruitment, never replace an owner."""

import json

from fastapi import HTTPException
from .project_agent_access import authorize_project_agent


async def adopt_task_agent(store, actor, token, request):
    space = await store.authorize(actor, request.personal_space_id, 'maintainer')
    record = await store.get_task_context(actor, request.personal_space_id, token,
                                          request.source_application)
    if record['personal_project_id'] != request.personal_project_id:
        raise HTTPException(409, 'Task context belongs to another project')
    if record.get('project_agent_id'):
        if record['project_agent_id'] == request.agent_id:
            return record
        raise HTTPException(409, 'Task context already has an employee')
    before = json.dumps(record, ensure_ascii=False)
    agent = await authorize_project_agent(store, actor, space, request.personal_project_id,
                                          request.agent_id, require_active=True, require_memory=True)
    if request.source_application not in json.loads(agent['profile_json']).get('allowed_clients', []):
        raise HTTPException(403, 'Agent is not allowed in this client')
    memory = await store.get_project_agent_memory(actor, request.personal_space_id,
                                                  request.personal_project_id, request.agent_id)
    record.update(project_agent_id=request.agent_id, memory_revision=memory.revision,
                  work_log_required=True)
    rows, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (space:FuliSpace {id: $space_id})-[:HAS_TASK_CONTEXT_SESSION]->
              (session:FuliTaskContextSession)-[:HAS_CONTEXT]->(context:FuliTaskContext {token: $token})
        MATCH (space)-[:HAS_PROJECT_AGENT_TASK]->(task:FuliProjectAgentTask {
          task_id: $task_id, personal_project_id: $project_id, lead_agent_id: $agent_id})
        SET session.write_serial = coalesce(session.write_serial, 0) + 1
        WITH context, session, task
        SET task._task_lifecycle_lock = true
        REMOVE task._task_lifecycle_lock
        WITH context, session, task
        MATCH (task)-[:HAS_PARTICIPANT]->(agent:FuliProjectAgent {agent_id: $agent_id, status: 'active'})
        SET agent._task_lifecycle_lock = true
        REMOVE agent._task_lifecycle_lock
        WITH context, session, agent, task
        WHERE context.token = session.current_token AND context.project_agent_id IS NULL
          AND context.fingerprint IS NULL AND NOT context.completed
          AND context.record_json = $before
          AND agent.profile_json = $profile_json
          AND task.status IN ['queued', 'running', 'paused', 'blocked', 'awaiting_recruitment']
          AND EXISTS {
            MATCH (:FuliSpace {id: $space_id})-[:CONTAINS_PROJECT]->
              (:FuliPersonalProject {project_id: $project_id})-[:HAS_PROJECT_AGENT_ASSIGNMENT]->
              (:FuliProjectAgentAssignment {status: 'active'})-[:ASSIGNED_AGENT]->(agent)
          }
        SET context.project_agent_id = agent.agent_id, context.record_json = $record_json
        RETURN context.record_json AS record_json
        ''', space_id=request.personal_space_id, project_id=request.personal_project_id,
        task_id=request.task_id, agent_id=request.agent_id, token=token,
        before=before, record_json=json.dumps(record, ensure_ascii=False), profile_json=agent['profile_json'],
    )
    if not rows:
        latest = await store.get_task_context(actor, request.personal_space_id, token,
                                              request.source_application)
        if latest.get('project_agent_id') == request.agent_id:
            return latest
        raise HTTPException(409, 'Task employee claim changed, completed, or is not the routed lead')
    return json.loads(rows[0]['record_json'])
