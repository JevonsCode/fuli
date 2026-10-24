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
// A routed task stores its route in its Agent assignment's match basis, with
// or without a selected Agent: "standing_assignment:<assignmentId> <notice>",
// then the session's own state before the route, "standing_session_project:<id>"
// or "standing_session_agent:<id>" (none when the session had neither). Later
// entries and the checkpoint receipt recognize them by prefix and ID alone, so
// rewording or translating the notice changes no routing.
const ROUTE = /^standing_assignment:(\S+) (.+)$/su;
const SESSION_PROJECT = /^standing_session_project:(\S+)$/u;
const SESSION_AGENT = /^standing_session_agent:(\S+)$/u;
// The Provider's bound on a stored match basis (task_context_models.py).
const MATCH_BASIS_LIMIT = 32;
const NO_AGENT = Object.freeze({ version: 1, selection_reason: null, match_basis: [], requested_agent_id: null,
  reporting_lead_agent_id: null, execution_reason: null, execution_agent_id: null });
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
    standingOwner: { ...owner, sessionProjectId: resolution.status === 'matched' ? resolution.personalProjectId : null,
      sessionAgentId: resolution.status === 'global' && resolution.basis === 'host_session_context'
        ? resolution.globalAgentId : null } };
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
  const notice = `本次任务按长期职责归入项目 ${owner.projectName}（负责人 ${leadName ?? owner.leadAgentId}）`;
  return { notice, receiptNotice: receiptText(notice),
    field: { status: 'routed', assignment_id: owner.assignmentId, ...ownerView(owner), lead_name: leadName,
      session_project_id: owner.sessionProjectId, ...(owner.sessionAgentId ? { session_agent_id: owner.sessionAgentId } : {}),
      notice } };
}

// The Agent assignment a routed task stores: the selected Agent's, or one
// without an Agent, with the route appended within the Provider's bound.
export function withStandingRoute(assignment, standingOwner) {
  if (standingOwner?.status !== 'routed') return assignment;
  const route = [`standing_assignment:${standingOwner.assignment_id} ${standingOwner.notice}`,
    ...(standingOwner.session_project_id ? [`standing_session_project:${standingOwner.session_project_id}`] : []),
    ...(standingOwner.session_agent_id ? [`standing_session_agent:${standingOwner.session_agent_id}`] : [])];
  const base = assignment ?? NO_AGENT;
  return { ...base, match_basis: [...base.match_basis.slice(0, MATCH_BASIS_LIMIT - route.length), ...route] };
}

// What the session had before a routed task, so its later tasks continue
// there and never inherit the routed project; any other task is its own.
export function sessionTaskContext(task) {
  const basis = task?.agentAssignment?.match_basis ?? [];
  if (!basis.some(item => ROUTE.test(item))) return task;
  const stored = pattern => basis.map(item => pattern.exec(item)?.[1]).find(Boolean) ?? null;
  const personalProjectId = stored(SESSION_PROJECT);
  const projectAgentId = stored(SESSION_AGENT);
  return personalProjectId || projectAgentId ? { personalProjectId, projectAgentId, projectScope: null } : null;
}

// The checkpoint receipt repeats the notice the routed entry showed.
export function standingReceiptNotices(task) {
  return (task?.agentAssignment?.match_basis ?? []).map(item => ROUTE.exec(item)?.[2]).filter(Boolean)
    .map(receiptText);
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
