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
    // The project's lines of work and the rule for dividing it, only for a
    // project that has lines (docs/workstreams.md): facts the lead hands work
    // on by, and the line an owner knows as its own.
    ...(team.workstreams.length ? { workstreams: team.workstreams.map(line => ({ workstream: line.name,
      owner_agent_id: line.ownerAgentId, owner_name: line.ownerName ?? null })),
    workstream_guidance: WORKSTREAM_GUIDANCE } : {}),
    reporting_lines: team.members.map(member => ({ agent_id: member.agentId, reports_to_agent_id: member.reportsToAgentId })),
    unavailable_agent_ids: [...new Set([...(team.lead ? [] : [leadId]), ...team.unavailableMemberIds,
      ...team.subTeams.flatMap(group => [...(group.unavailableLead ? [group.unavailableLead.agentId] : []), ...group.unavailableMemberIds])])],
    assigned_collaborators: team.collaborators.map(person => entry(person, 'collaborator')),
    assigned_peers: team.peers.map(person => entry(person, 'peer')),
    peer_roles: ['hr', 'project_manager'], worker_started: false,
    guidance: TEAM_GUIDANCE };
}

export const TEAM_GUIDANCE = 'The project lead is the sole user-facing owner. Report results and blockers to your immediate reporting lead; members report through their sub-lead when configured. Never skip levels or replace the project lead when a member is named. Each lead integrates and verifies direct reports before reporting upward. Assigned collaborators work through the project lead unless the policy groups them. Split bounded work through an authorized coordination plan and report real worker evidence. AR and project managers remain peers. Team membership grants no new tool, data, executor, or publication permissions.';

// How the lead divides a project that has lines (docs/workstreams.md). The
// entry names it by reference; this is the text the reference resolves to.
export const WORKSTREAM_GUIDANCE = 'This project is divided into workstreams. When this task was not routed to one: if it belongs to a listed workstream, hand it over in one call, begin_task_context with workstream "<its name>" and taskPrompt "<the request>", and stop working on it yourself (never #FLA: that is the person\'s own choice of FLA); if it is a new piece of work unrelated to every listed workstream, open one with register_standing_assignment change delegate (terms, responsibility as its name, leadAgentId), tell the person its tell_user, then hand it over the same way; if unsure, do it yourself. Never re-divide recorded work.';
