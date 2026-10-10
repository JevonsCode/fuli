import { loadProjectTeam } from './project-team-view.js';

// Only public role/assignment data crosses the team boundary. Member memory
// is restored separately inside each authorized worker's isolated context.
export async function loadProjectTeamContext(application, personalSpaceId, projectId) {
  if (typeof application.personal.getProjectAgentCoordinationPolicy !== 'function') return null;
  const team = await loadProjectTeam(application, personalSpaceId, projectId);
  if (team.status === 'no_lead') return null;
  const leadId = team.lead?.agentId ?? team.unavailableLead.agentId;
  const entry = (person, role) => ({ agent_id: person.agentId, name: person.name,
    responsibility: person.responsibility, role });
  const roster = [...(team.lead ? [entry(team.lead, 'lead')] : []),
    ...team.members.map(member => entry(member, 'member'))];
  return { lead_agent_id: leadId, roster,
    user_facing_agent_id: leadId,
    reporting_lines: team.members.map(member => ({ agent_id: member.agentId, reports_to_agent_id: leadId })),
    unavailable_agent_ids: [...(team.lead ? [] : [leadId]), ...team.unavailableMemberIds],
    assigned_collaborators: team.collaborators.map(person => entry(person, 'collaborator')),
    assigned_peers: team.peers.map(person => entry(person, 'peer')),
    peer_roles: ['hr', 'project_manager'], worker_started: false,
    guidance: 'The project lead is the sole user-facing owner. Members report results and blockers to this lead; do not skip reporting levels or replace the lead when a member is named. Assigned collaborators outside the explicit team work through the lead and are not direct reports unless the policy names them. The lead integrates and verifies member reports before reporting to the user. Split bounded work through an authorized coordination plan; report real worker evidence. AR and project managers remain peers. Team membership grants no new tool, data, executor, or publication permissions.' };
}
