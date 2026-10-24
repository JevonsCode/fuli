import { receiptText } from '../agents/identity-receipt.js';
import { hostInternalActivity } from './task-entry-activity-origin.js';
import { nameableProjects, projectDisplayName, promptNamesProject } from './task-entry-project-mention.js';

// A standing assignment routes one task (rec#29 D-41 D3, option b): when the
// task prompt carries a term the person confirmed for a project, this task is
// scoped to that project — its history, todos, results and knowledge queries —
// while the session stays where it belongs. The current local session still
// does the work as that project's Agent; nothing is asked across projects and
// no model is called (D2). The match is the local store's (no Provider round
// trip); the project names come from the entry's shared project list.
//
// What the person or host chose for this task outranks a standing assignment:
// an explicit project or Agent, an @mention, or a project the prompt names.
// Where the folder or the session would put the task does not. When terms of
// several assignments match, the entry asks instead of choosing one.

const EXPLICIT_BASES = new Set(['explicit_personal_project_id', 'explicit_agent', 'named_in_prompt',
  'created_from_prompt']);
// The notice opens every routed task's stored match basis, so later entries
// and the checkpoint receipt recognize the task without another store.
const NOTICE_OPENING = '本次任务按长期职责归入项目';
const CLARIFY_GUIDANCE = 'Terms of several standing assignments match this task, so it stays where it was. Ask the '
  + 'user once which project this task belongs to, then begin the task again naming that project.';

export async function withStandingOwner(application, resolution, input) {
  const matches = standingMatches(application, input.taskPrompt);
  if (!matches.length || !routable(resolution, input) || hostInternalActivity(application, input)
    || await promptNamesProject(application, input.taskPrompt)) return resolution;
  const projects = new Map((await nameableProjects(application)).map(project => [project.project_id, project]));
  const owners = matches.filter(({ assignment }) => projects.has(assignment.projectId))
    .map(({ assignment, matchedTerms }) => ({ assignmentId: assignment.assignmentId, projectId: assignment.projectId,
      projectName: projectDisplayName(projects.get(assignment.projectId)), leadAgentId: assignment.leadAgentId,
      matchedTerms }));
  if (owners.length > 1) return { ...resolution, standingCandidates: owners };
  const [owner] = owners;
  if (!owner || owner.projectId === resolution.personalProjectId) return resolution;
  return { status: 'matched', basis: 'standing_assignment', personalProjectId: owner.projectId,
    standingOwner: { ...owner, sessionProjectId: resolution.personalProjectId ?? null } };
}

// What the entry says about a standing assignment: the routed owner with its
// one sentence, or the candidates to ask about. The lead's name is the
// selected Agent's when it is the lead; no Agent is read for it.
export function standingOwnerEntry(resolution, selection) {
  if (resolution.standingCandidates) {
    return { field: { status: 'clarification_required', candidates: resolution.standingCandidates.map(ownerView),
      guidance: CLARIFY_GUIDANCE } };
  }
  const owner = resolution.standingOwner;
  if (!owner) return null;
  const agent = selection?.agent?.agentId === owner.leadAgentId ? selection.agent : null;
  const leadName = agent?.profile?.displayName || agent?.profile?.name || null;
  const notice = `${NOTICE_OPENING} ${owner.projectName}（负责人 ${leadName ?? owner.leadAgentId}）`;
  return { notice, receiptNotice: receiptText(notice), field: { status: 'routed', ...ownerView(owner),
    lead_name: leadName, session_project_id: owner.sessionProjectId, notice } };
}

// The stored task carries the notice in its match basis; its checkpoint
// receipt repeats it, and the session's later tasks do not inherit its project.
export function standingReceiptNotices(task) {
  return storedNotices(task).map(receiptText);
}

export function routedByStandingAssignment(task) {
  return storedNotices(task).length > 0;
}

function storedNotices(task) {
  return (task?.agentAssignment?.match_basis ?? []).filter(basis => basis.startsWith(NOTICE_OPENING));
}

// A store this FULI cannot read routes nothing; the entry continues as before.
function standingMatches(application, taskPrompt) {
  if (!application.standingAssignments || typeof taskPrompt !== 'string' || !taskPrompt.trim()) return [];
  try {
    return application.standingAssignments.match(application.config.personal.spaceId, taskPrompt);
  } catch {
    return [];
  }
}

function routable(resolution, input) {
  if (input.projectAgentId || String(input.taskPrompt).trimStart().startsWith('@')
    || EXPLICIT_BASES.has(resolution.basis)) return false;
  if (resolution.status === 'matched' || resolution.status === 'global') return true;
  return resolution.status === 'ambiguous' && resolution.basis === 'host_session_assignment';
}

function ownerView(owner) {
  return { project_id: owner.projectId, project_name: owner.projectName, lead_agent_id: owner.leadAgentId,
    matched_terms: owner.matchedTerms };
}
