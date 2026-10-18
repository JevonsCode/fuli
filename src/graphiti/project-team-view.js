// One authoritative reading of a project's people. The coordination policy
// owns the explicit hierarchy; active assignments decide who currently works
// on the exact project. Assigned Agents outside the explicit team are shown as
// collaborators and peer roles stay peers, never converted into direct reports.
const PEER_AGENT_IDS = new Set(['employee.jefa', 'employee.bole', 'employee.tonborg', 'fuli-project-hr']);
const PEER_CAPABILITIES = new Set(['fuli.employee:jefa', 'fuli.employee:bole', 'fuli.employee:tonborg']);

export function isPeerRoleAgent({ agentId, agentType, capabilities = [] }) {
  return PEER_AGENT_IDS.has(agentId) || agentType === 'hr'
    || capabilities.some(value => PEER_CAPABILITIES.has(String(value).toLowerCase()));
}

export function buildProjectTeam({ policy, agents, projectId }) {
  const leadId = policy?.team_lead_agent_id ?? null;
  const memberIds = [...new Set(policy?.team_member_agent_ids ?? [])].filter(id => id !== leadId);
  const all = Array.isArray(agents) ? agents : [];
  const assigned = new Map();
  for (const agent of all) {
    const assignment = activeAssignment(agent, projectId);
    if (assignment && isActive(agent)) assigned.set(agent.agent_id, person(agent, assignment));
  }
  const lead = leadId ? assigned.get(leadId) ?? null : null;
  const groups = policy?.sub_teams ?? [];
  const parents = new Map(groups.flatMap(group => (group.member_agent_ids ?? []).map(id => [id, group.lead_agent_id])));
  // Legacy or reclassified policies may still name a peer role as a member;
  // it stays a peer and never gains a reporting line.
  const members = memberIds.filter(id => assigned.has(id) && !assigned.get(id).peerRole)
    .map(id => ({ ...assigned.get(id), reportsToAgentId: parents.get(id) ?? (lead ? leadId : null) }));
  const memberMap = new Map(members.map(person => [person.agentId, person]));
  const subTeams = groups.map(group => ({ id: group.id, name: group.name,
    lead: memberMap.get(group.lead_agent_id) ?? null,
    unavailableLead: memberMap.has(group.lead_agent_id) ? null : { agentId: group.lead_agent_id,
      name: all.find(agent => agent.agent_id === group.lead_agent_id)?.profile?.name ?? null },
    members: (group.member_agent_ids ?? []).filter(id => memberMap.has(id)).map(id => memberMap.get(id)),
    unavailableMemberIds: (group.member_agent_ids ?? []).filter(id => !memberMap.has(id)) }));
  const reporting = new Set([leadId, ...members.map(member => member.agentId)]);
  const collaborators = [];
  const peers = [];
  for (const [id, entry] of assigned) {
    if (reporting.has(id)) continue;
    (entry.peerRole ? peers : collaborators).push(entry);
  }
  const byName = (left, right) => left.name.localeCompare(right.name);
  const former = leadId && !lead ? all.find(agent => agent.agent_id === leadId) : null;
  return {
    personalProjectId: projectId,
    status: !leadId ? 'no_lead' : lead ? 'ready' : 'lead_unavailable',
    lead,
    unavailableLead: leadId && !lead ? { agentId: leadId, name: former ? displayName(former) : null } : null,
    members,
    subTeams,
    subTeamSuggestion: { suggested: members.length > (policy?.sub_team_suggestion_threshold ?? 6) && !groups.length,
      memberCount: members.length, threshold: policy?.sub_team_suggestion_threshold ?? 6 },
    collaborators: collaborators.sort(byName),
    peers: peers.sort(byName),
    unavailableMemberIds: memberIds.filter(id => !assigned.has(id))
  };
}

function activeAssignment(agent, projectId) {
  return (agent.assignments ?? []).find(assignment => assignment.personal_project_id === projectId
    && assignment.status === 'active') ?? null;
}

function isActive(agent) {
  const status = agent.profile?.status;
  return status === undefined || status === null || status === 'active';
}

function displayName(agent) {
  return agent.profile?.display_name || agent.profile?.name || agent.agent_id;
}

function person(agent, assignment) {
  const profile = agent.profile ?? {};
  return {
    agentId: agent.agent_id,
    name: displayName(agent),
    employeeNumber: agent.employee_number ?? null,
    occupation: agent.occupation?.role ?? null,
    occupationEmoji: profile.occupation_emoji ?? profile.occupationEmoji ?? null,
    responsibility: assignment.responsibility || profile.responsibility || '',
    peerRole: isPeerRoleAgent({ agentId: agent.agent_id, agentType: profile.agent_type,
      capabilities: profile.capabilities ?? [] })
  };
}

export async function loadProjectTeam(application, personalSpaceId, projectId) {
  const [policy, agents] = await Promise.all([
    application.personal.getProjectAgentCoordinationPolicy(personalSpaceId, projectId),
    application.personal.listProjectAgents(personalSpaceId, projectId, { status: 'active' })
  ]);
  const list = Array.isArray(agents) ? agents : agents?.agents ?? agents?.items ?? [];
  return buildProjectTeam({ policy, agents: list, projectId });
}
