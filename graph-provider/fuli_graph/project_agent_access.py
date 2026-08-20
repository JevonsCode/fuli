from fastapi import HTTPException

from .personal_project_access import authorize_personal_project


async def authorize_project_agent(
    store,
    actor: dict,
    space: dict,
    project_id: str,
    agent_id: str,
    *,
    require_active: bool = False,
    allow_unassigned: bool = False,
    require_memory: bool = False,
) -> dict:
    if not project_id:
        raise HTTPException(
            status_code=422,
            detail='project Agent access requires a personal project',
        )
    await authorize_personal_project(store, actor, space, project_id)
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (space:FuliSpace {id: $space_id, kind: 'personal'})-
              [:HAS_PROJECT_AGENT_IDENTITY]->
              (agent:FuliProjectAgent {agent_id: $agent_id})
        OPTIONAL MATCH (space)-[:CONTAINS_PROJECT]->
              (:FuliPersonalProject {project_id: $project_id})-
              [:HAS_PROJECT_AGENT_ASSIGNMENT]->
              (assignment:FuliProjectAgentAssignment {status: 'active'})-
              [:ASSIGNED_AGENT]->(agent)
        WITH agent, collect(DISTINCT assignment.assignment_id) AS assignment_ids
        WHERE $allow_unassigned OR size(assignment_ids) > 0
        RETURN agent, head(assignment_ids) AS assignment_id
        ''',
        space_id=space['id'],
        project_id=project_id,
        agent_id=agent_id,
        allow_unassigned=allow_unassigned,
        routing_='r',
    )
    if not records:
        raise HTTPException(status_code=404, detail='project Agent not found')
    agent = dict(records[0]['agent'])
    if require_active and agent.get('status') != 'active':
        raise HTTPException(status_code=409, detail='project Agent is not active')
    if require_memory and agent.get('memory_scope') == 'task_only':
        raise HTTPException(
            status_code=409,
            detail='temporary project Agent cannot access reviewed long-term memory',
        )
    agent['active_assignment_id'] = records[0].get('assignment_id')
    return agent
