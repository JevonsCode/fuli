import { FIXED_ROLES } from '../employees/fixed-roles.js';

// One authoritative reading of a project's people. The coordination policy
// owns the explicit hierarchy; active assignments decide who currently works
// on the exact project. Assigned Agents outside the explicit team are shown as
// collaborators and peer roles stay peers, never converted into direct reports.
// FULI's own roles are peers of a project team, never its members.
const PEER_ROLES = Object.values(FIXED_ROLES);
// 'fuli-project-hr' is the AR identity from before Bole.
const PEER_AGENT_IDS = new Set([...PEER_ROLES.map(role => role.agentId), 'fuli-project-hr']);
const PEER_CAPABILITIES = new Set(PEER_ROLES.map(role => role.capability));

export function isPeerRoleAgent({ agentId, agentType, capabilities = [] }) {
  return PEER_AGENT_IDS.has(agentId) || agentType === 'hr'
    || capabilities.some(value => PEER_CAPABILITIES.has(String(value).toLowerCase()));
}

export function buildProjectTeam({ policy, agents, projectId, standingAssignments = [] }) {
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
    unavailableMemberIds: memberIds.filter(id => !assigned.has(id)),
    workstreams: workstreamLedger(standingAssignments, projectId, leadId, assigned)
  };
}

// The lead's ledger (docs/workstreams.md): each line of work of this project,
// who owns it, since when and who decided it. A workstream is a standing
// assignment of this project whose Agent is not its lead; an assignment that
// points at the lead routes work into the project and is not a line within
// it. An owner that has left the project keeps its ID, so the person can
// still move or end the work.
function workstreamLedger(assignments, projectId, leadId, assigned) {
  return (Array.isArray(assignments) ? assignments : [])
    .filter(item => item.projectId === projectId && !item.retiredAt && item.leadAgentId !== leadId)
    .map(item => ({
      assignmentId: item.assignmentId,
      name: item.responsibility,
      terms: [...item.terms],
      ownerAgentId: item.leadAgentId,
      ownerName: assigned.get(item.leadAgentId)?.name ?? null,
      ownerOnProject: assigned.has(item.leadAgentId),
      decidedBy: item.source,
      startedAt: item.createdAt,
      changedAt: item.updatedAt,
      revision: item.revision
    }))
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt) || left.assignmentId.localeCompare(right.assignmentId));
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
  return buildProjectTeam({ policy, agents: list, projectId,
    standingAssignments: standingAssignmentsFor(application) });
}

// The local store's active assignments, or none: a FULI that cannot read it
// still reports its team, without claiming the project has no workstreams.
function standingAssignmentsFor(application) {
  if (!application.standingAssignments) return [];
  try {
    return application.standingAssignments.list(application.config.personal.spaceId);
  } catch {
    return [];
  }
}
