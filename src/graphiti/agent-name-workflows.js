import { projectAgentNameChange, workingProject } from './project-agent-mapping.js';

// Every rename in a space, and settling the names FLAs share (graph-provider
// store_project_agent_name_fixes.py): the plan says who keeps each shared name,
// what the others become and why; the person may pick another keeper or leave
// a rename out, and one apply renames exactly the FLAs they agreed to.

// Every rename, newest first, and up to when the person has seen the settled ones.
export async function listAgentNameChanges(application, input) {
  return nameChanges(await application.personal.listAgentNameChanges(input.personalSpaceId));
}

// 知道了 on the FLAs page: kept with the space, so every console agrees.
export async function markAgentNameChangesSeen(application, input) {
  return nameChanges(await application.personal.markAgentNameChangesSeen({
    personal_space_id: input.personalSpaceId, until: input.until }));
}

// How the shared names would be settled; `keep` names the FLAs the person picked to keep theirs.
export async function agentNameFixPlan(application, input) {
  return nameFixPlan(await application.personal.agentNameFixPlan(input.personalSpaceId, input.keep ?? []));
}

// The renames the person agreed to, each with the new name they saw.
export async function applyAgentNameFixes(application, input) {
  return nameFixPlan(await application.personal.applyAgentNameFixes({
    personal_space_id: input.personalSpaceId, keep: input.keep ?? [], renames: input.renames ?? {} }));
}

function nameChanges(value) {
  return { seenUntil: value.seen_until ?? null, items: (value.items ?? []).map(item => ({
    agentId: item.agent_id, displayName: item.display_name, status: item.status,
    change: projectAgentNameChange(item.change), keptByName: item.kept_by_name ?? null })) };
}

function nameFixPlan(value) {
  return { renames: value.renames, groups: value.groups.map(group => ({ name: group.name,
    members: group.members.map(member => ({ agentId: member.agent_id, name: member.name, status: member.status,
      projects: (member.projects ?? []).map(workingProject), keeps: member.keeps, newName: member.new_name ?? null,
      gaveWay: member.gave_way ?? null })) })) };
}
