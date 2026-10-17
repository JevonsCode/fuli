import { TASK_ENTRY_TOOLS } from './repository-project-registration.js';
import { hostInternalActivity } from './task-entry-activity-origin.js';
import { projectNamedInPrompt } from './task-entry-project-mention.js';

// The fixed assistant receives conversations no project has claimed yet.
const ASSISTANT_AGENT_ID = 'employee.assistant';

// Restore only exact session provenance; a normal folder name is not a role binding.
// An unclaimed conversation never creates a project or hires a lead: it stays
// pending in the assistant's global scope until it is assigned to a project.
export async function resolveTaskEntryProject(application, resolution, input) {
  if (!input.agentInvocation || !TASK_ENTRY_TOOLS.has(input.agentToolName)
    || resolution.personalProjectId || resolution.repositoryProjectId
    || !['unmatched', 'not_provided'].includes(resolution.status)) return resolution;
  // An explicit FLA outside a project uses its independent global context.
  if (input.projectAgentId || String(input.taskPrompt ?? '').trimStart().startsWith('@')) {
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
    for (const sessionId of sessions) {
      const context = await application.taskContextRegistry?.current?.(sessionId, source);
      if (context?.projectScope?.type === 'temporary') continue;
      if (context?.personalProjectId === null && context.projectAgentId) {
        return { status: 'global', basis: 'host_session_context', personalProjectId: null,
          globalAgentId: context.projectAgentId };
      }
      if (!context?.personalProjectId) continue;
      const project = await application.personal.getPersonalProject(spaceId, context.personalProjectId);
      if (project?.scope_type !== 'temporary') {
        return matched(context.personalProjectId, 'host_session_context');
      }
    }
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

function matched(personalProjectId, basis) {
  return { status: 'matched', basis, personalProjectId };
}
