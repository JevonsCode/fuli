"""Grow a project team inside the recruitment transaction, without changing authority."""

from fastapi import HTTPException

from .provider_values import now_utc


async def enroll_recruited_team_member(store, recruitment, profile):
    # Temporary workers and system employees do not become permanent teammates.
    if (profile.agent_type != 'durable' or profile.status != 'active'
            or any(cap.startswith('fuli.employee:') for cap in profile.capabilities)):
        return
    space_id = recruitment['personal_space_id']
    project_id = recruitment['personal_project_id']
    rows, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (:FuliSpace {id: $space_id})-[:CONTAINS_PROJECT]->
              (project:FuliPersonalProject {project_id: $project_id})
        MATCH (project)-[:HAS_PROJECT_AGENT_ASSIGNMENT]->
              (:FuliProjectAgentAssignment {status: 'active'})-[:ASSIGNED_AGENT]->
              (agent:FuliProjectAgent {agent_id: $agent_id, status: 'active'})
        WITH DISTINCT project, agent
        MERGE (policy:FuliProjectAgentCoordinationPolicy {policy_id: $policy_id})
        ON CREATE SET policy.personal_space_id = $space_id,
                      policy.personal_project_id = $project_id,
                      policy.created_at = $updated_at
        SET policy._fuli_write_lock = true
        REMOVE policy._fuli_write_lock
        MERGE (project)-[:HAS_PROJECT_AGENT_COORDINATION_POLICY]->(policy)
        WITH policy, agent, coalesce(policy.auto_grow_team, true) AS enabled,
             coalesce(policy.team_member_agent_ids, []) AS members
        WITH policy, agent, members, enabled,
             policy.team_lead_agent_id IS NULL AS needs_lead,
             coalesce(policy.team_lead_agent_id = agent.agent_id, false)
               OR agent.agent_id IN members AS already_member
        WITH *, enabled AND NOT already_member
                  AND (needs_lead OR size(members) < 32) AS changed
        FOREACH (_ IN CASE WHEN changed THEN [1] ELSE [] END |
          SET policy.team_lead_agent_id = CASE WHEN needs_lead
                THEN agent.agent_id ELSE policy.team_lead_agent_id END,
              policy.team_member_agent_ids = CASE WHEN needs_lead
                THEN members ELSE members + agent.agent_id END,
              policy.updated_at = $updated_at
        )
        RETURN enabled AND NOT already_member AND NOT needs_lead
                 AND size(members) >= 32 AS full
        ''',
        space_id=space_id, project_id=project_id,
        agent_id=recruitment['proposed_agent_id'],
        policy_id=store._project_agent_coordination_policy_id(space_id, project_id),
        updated_at=now_utc(),
    )
    if not rows:
        raise HTTPException(409, 'recruited Agent has no active project assignment')
    if rows[0]['full']:
        raise HTTPException(409, 'project team is full; change the team before recruiting')
