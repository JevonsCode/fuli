import { FIXED_ROLES } from '../employees/fixed-roles.js';
import { agentDisplayName } from './agent-display-name.js';
import { applicationLanguage } from './project-display-name.js';
import { projectWorkstreams, withWorkstreamProgress } from './workstream-ledger.js';

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

// language: the one the person reads FULI in, for names FULI wrote by itself.
export function buildProjectTeam({ policy, agents, projectId, language, standingAssignments = [] }) {
  const leadId = policy?.team_lead_agent_id ?? null;
  const memberIds = [...new Set(policy?.team_member_agent_ids ?? [])].filter(id => id !== leadId);
  const all = Array.isArray(agents) ? agents : [];
  const assigned = new Map();
  for (const agent of all) {
    const assignment = activeAssignment(agent, projectId);
    if (assignment && isActive(agent)) assigned.set(agent.agent_id, person(agent, assignment, language));
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
    unavailableLead: leadId && !lead ? { agentId: leadId, name: former ? agentDisplayName(former, language) : null } : null,
    members,
    subTeams,
    subTeamSuggestion: { suggested: members.length > (policy?.sub_team_suggestion_threshold ?? 6) && !groups.length,
      memberCount: members.length, threshold: policy?.sub_team_suggestion_threshold ?? 6 },
    collaborators: collaborators.sort(byName),
    peers: peers.sort(byName),
    unavailableMemberIds: memberIds.filter(id => !assigned.has(id)),
    // The lead's ledger (workstream-ledger.js).
    workstreams: projectWorkstreams(standingAssignments, projectId, leadId, assigned)
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

function person(agent, assignment, language) {
  const profile = agent.profile ?? {};
  return {
    agentId: agent.agent_id,
    name: agentDisplayName(agent, language),
    employeeNumber: agent.employee_number ?? null,
    occupation: agent.occupation?.role ?? null,
    occupationEmoji: profile.occupation_emoji ?? profile.occupationEmoji ?? null,
    responsibility: assignment.responsibility || profile.responsibility || '',
    peerRole: isPeerRoleAgent({ agentId: agent.agent_id, agentType: profile.agent_type,
      capabilities: profile.capabilities ?? [] })
  };
}

// The lead, a member or a collaborator of the project, active on it, or null.
export function activeTeamAgent(team, agentId) {
  return [team.lead, ...team.members, ...team.collaborators].find(person => person?.agentId === agentId) ?? null;
}

// `withProgress` adds each workstream's latest task: one bounded read per
// line, so only an explicit read asks for it. Task entry never does. `policy`:
// the project's policy read this entry already started (project-policy-read.js).
export async function loadProjectTeam(application, personalSpaceId, projectId, { withProgress = false, policy } = {}) {
  const [read, agents] = await Promise.all([
    policy ?? application.personal.getProjectAgentCoordinationPolicy(personalSpaceId, projectId),
    application.personal.listProjectAgents(personalSpaceId, projectId, { status: 'active' })
  ]);
  const list = Array.isArray(agents) ? agents : agents?.agents ?? agents?.items ?? [];
  const team = buildProjectTeam({ policy: read, agents: list, projectId, language: applicationLanguage(application),
    standingAssignments: standingAssignmentsFor(application) });
  if (!withProgress) return team;
  return { ...team,
    workstreams: await withWorkstreamProgress(application, personalSpaceId, projectId, team.workstreams) };
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
