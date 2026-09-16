// Only public role/assignment data crosses the team boundary. Member memory
// is restored separately inside each authorized worker's isolated context.
export async function loadProjectTeamContext(application, personalSpaceId, projectId) {
  if (typeof application.personal.getProjectAgentCoordinationPolicy !== 'function') return null;
  const policy = await application.personal.getProjectAgentCoordinationPolicy(personalSpaceId, projectId);
  if (!policy?.team_lead_agent_id) return null;
  const agents = await application.personal.listProjectAgents(personalSpaceId, projectId, { status: 'active' });
  const ids = [policy.team_lead_agent_id, ...(policy.team_member_agent_ids ?? [])];
  const roster = (Array.isArray(agents) ? agents : []).filter(agent => ids.includes(agent.agent_id)
    && agent.assignments?.some(assignment => assignment.personal_project_id === projectId
      && assignment.status === 'active'))
    .map(agent => ({ agent_id: agent.agent_id,
      name: agent.profile?.display_name || agent.profile?.name,
      responsibility: agent.assignments?.find(assignment => assignment.personal_project_id === projectId
        && assignment.status === 'active')?.responsibility || agent.profile?.responsibility,
      role: agent.agent_id === policy.team_lead_agent_id ? 'lead' : 'member' }));
  return { lead_agent_id: policy.team_lead_agent_id, roster,
    unavailable_agent_ids: ids.filter(id => !roster.some(agent => agent.agent_id === id)),
    peer_roles: ['hr', 'project_manager'], worker_started: false,
    guidance: 'The team lead is the user-facing owner. Split bounded work among team members through an authorized coordination plan; report real worker evidence. HR and project managers remain peers. Team membership grants no new tool, data, executor, or publication permissions.' };
}
