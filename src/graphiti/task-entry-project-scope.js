import { TASK_ENTRY_TOOLS } from './repository-project-registration.js';
import { hostInternalActivity } from './task-entry-activity-origin.js';
import { projectNamedInPrompt } from './task-entry-project-mention.js';
import { sessionTaskContext, withStandingOwner } from './task-entry-standing-owner.js';
import { namedFlaRequest, namedFlaResolution, namedFlaTask } from './task-entry-named-fla.js';
import { leadingAgentAddress } from './fla-mention.js';
import { ASSISTANT_AGENT_ID } from './assistant-identity.js';

// Restore only exact session provenance; a normal folder name is not a role binding.
// An unclaimed conversation never creates a project or hires a lead: it stays
// pending in the assistant's global scope until it is assigned to a project.
// A standing assignment the prompt names then scopes this task alone
// (task-entry-standing-owner.js). An FLA the person names, or this session is
// bound to, comes first (task-entry-named-fla.js).
export async function resolveTaskEntryProject(application, resolution, input) {
  if (!input.agentInvocation || !TASK_ENTRY_TOOLS.has(input.agentToolName)) return resolution;
  const readSessionTask = sessionTaskReader(application, input);
  const fla = await namedFlaRequest(application, resolution, input, readSessionTask);
  const named = fla && namedFlaResolution(fla);
  if (named) return named;
  const routed = await withStandingOwner(application,
    await sessionEntryProject(application, resolution, input, readSessionTask), input);
  return fla ? { ...routed, fla } : routed;
}

// The session's current task, read at most once per entry, and not at all
// when the caller already read it (sessionTask).
function sessionTaskReader(application, input) {
  const identity = input.sessionId ?? input.sourceSessionId;
  let read = input.sessionTask !== undefined ? Promise.resolve(input.sessionTask) : null;
  return () => {
    if (typeof identity !== 'string' || !identity.trim()) return Promise.resolve(null);
    read ??= Promise.resolve(application.taskContextRegistry?.current?.(identity, input.sourceApplication ?? 'other'));
    return read;
  };
}

async function sessionEntryProject(application, resolution, input, readSessionTask) {
  // An unregistered repository ID is only a hint: when auto-registration did
  // not apply, the prompt, the session and the assistant still decide.
  if (resolution.personalProjectId
    || !['unmatched', 'not_provided'].includes(resolution.status)) return resolution;
  // An explicit FLA outside a project uses its independent global context.
  if (input.projectAgentId || leadingAgentAddress(input.taskPrompt) !== null) {
    return { status: 'global', basis: 'explicit_agent', personalProjectId: null };
  }
  // A known native session is stronger than an MCP process ID. Never use an
  // older process assignment to override a different, explicitly known chat.
  const identity = input.sessionId ?? input.sourceSessionId;
  const sessions = typeof identity === 'string' && identity.trim() ? [identity] : [];
  if (!sessions.length) return { ...resolution, reason: 'session_identity_required' };
  const spaceId = application.config.personal.spaceId;
  const source = input.sourceApplication ?? 'other';
  try {
    const session = await sessionTaskScope(application, await readSessionTask());
    if (session) return session;
    const assignments = await application.personal.listProjectAgentAssignments({
      personalSpaceId: spaceId, status: 'active'
    });
    const candidates = [...new Set(assignments.filter(value => value.status === 'active'
      && (!value.personal_space_id || value.personal_space_id === spaceId)
      && value.source_application === source && sessions.includes(value.source_session_id))
      .map(value => value.personal_project_id).filter(Boolean))];
    const registered = [];
    for (const id of candidates) {
      const project = await application.personal.getPersonalProject(spaceId, id);
      if (project?.scope_type !== 'temporary') registered.push(id);
    }
    if (registered.length > 1) {
      return { status: 'ambiguous', basis: 'host_session_assignment',
        personalProjectId: null, candidateCount: registered.length };
    }
    if (registered.length === 1) return matched(registered[0], 'host_session_assignment');
    // Internal Agent activity may reuse an existing scope but never creates one.
    if (hostInternalActivity(application, input)) return { ...resolution, reason: 'internal_activity' };

    const named = await projectNamedInPrompt(application, input.taskPrompt);
    if (named?.ambiguous) {
      return { status: 'ambiguous', basis: named.basis, personalProjectId: null,
        candidateCount: named.candidateCount };
    }
    if (named) return matched(named.personalProjectId, named.basis);
    return { status: 'global', basis: 'pending_assignment', personalProjectId: null,
      globalAgentId: ASSISTANT_AGENT_ID };
  } catch {
    // A failed read cannot prove that no previous owner exists.
    return { status: 'unavailable', basis: null, personalProjectId: null,
      reason: 'session_scope_unavailable' };
  }
}

// Where the session's current task keeps it, or null. A task a standing
// assignment routed never moves its session there: the session continues
// where it was before that task. Nor does a named FLA's, once its binding ended.
async function sessionTaskScope(application, task) {
  const context = namedFlaTask(task) ? null : sessionTaskContext(task);
  if (!context || context.projectScope?.type === 'temporary') return null;
  if (context.personalProjectId === null && context.projectAgentId) {
    return { status: 'global', basis: 'host_session_context', personalProjectId: null,
      globalAgentId: context.projectAgentId };
  }
  if (!context.personalProjectId) return null;
  const project = await application.personal.getPersonalProject(application.config.personal.spaceId,
    context.personalProjectId);
  return project?.scope_type !== 'temporary' ? matched(context.personalProjectId, 'host_session_context') : null;
}

function matched(personalProjectId, basis) {
  return { status: 'matched', basis, personalProjectId };
}
