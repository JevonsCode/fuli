import { loadProjectTeam } from './project-team-view.js';

// Only public role/assignment data crosses the team boundary. Member memory
// is restored separately inside each authorized worker's isolated context.
export async function loadProjectTeamContext(application, personalSpaceId, projectId) {
  if (typeof application.personal.getProjectAgentCoordinationPolicy !== 'function') return null;
  const team = await loadProjectTeam(application, personalSpaceId, projectId);
  if (team.status === 'no_lead') return null;
  const leadId = team.lead?.agentId ?? team.unavailableLead.agentId;
  const entry = (person, role) => ({ agent_id: person.agentId, name: person.name, occupation: person.occupation,
    responsibility: person.responsibility, role });
  const subLeads = new Set(team.subTeams.map(group => group.lead?.agentId));
  const roster = [...(team.lead ? [entry(team.lead, 'lead')] : []),
    ...team.members.map(member => entry(member, subLeads.has(member.agentId) ? 'sub_lead' : 'member'))];
  return { lead_agent_id: leadId, roster,
    user_facing_agent_id: leadId,
    reporting_lines: team.members.map(member => ({ agent_id: member.agentId, reports_to_agent_id: member.reportsToAgentId })),
    unavailable_agent_ids: [...new Set([...(team.lead ? [] : [leadId]), ...team.unavailableMemberIds,
      ...team.subTeams.flatMap(group => [...(group.unavailableLead ? [group.unavailableLead.agentId] : []), ...group.unavailableMemberIds])])],
    assigned_collaborators: team.collaborators.map(person => entry(person, 'collaborator')),
    assigned_peers: team.peers.map(person => entry(person, 'peer')),
    peer_roles: ['hr', 'project_manager'], worker_started: false,
    guidance: TEAM_GUIDANCE };
}

export const TEAM_GUIDANCE = 'The project lead is the sole user-facing owner. Report results and blockers to your immediate reporting lead; members report through their sub-lead when configured. Never skip levels or replace the project lead when a member is named. Each lead integrates and verifies direct reports before reporting upward. Assigned collaborators work through the project lead unless the policy groups them. Split bounded work through an authorized coordination plan and report real worker evidence. AR and project managers remain peers. Team membership grants no new tool, data, executor, or publication permissions.';
