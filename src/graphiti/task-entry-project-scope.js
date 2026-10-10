import { createHash } from 'node:crypto';
import { TASK_ENTRY_TOOLS } from './repository-project-registration.js';

// Restore only exact session provenance; a normal folder name is not a role binding.
// The fallback scope is private and contains no prompt, path or raw session identity.
export async function resolveTaskEntryProject(application, resolution, input) {
  if (!input.agentInvocation || !TASK_ENTRY_TOOLS.has(input.agentToolName)
    || resolution.personalProjectId || resolution.repositoryProjectId
    || !['unmatched', 'not_provided'].includes(resolution.status)) return resolution;
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
      if (!context?.personalProjectId || context.projectScope?.type === 'temporary') continue;
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

    const key = createHash('sha256').update(JSON.stringify([
      'fuli-conversation-project-v1', spaceId, source, sessions[0]
    ])).digest('hex');
    const projectId = `conversation-${key}`;
    try {
      await application.personal.getPersonalProject(spaceId, projectId);
    } catch (error) {
      if (error.status !== 404) throw error;
      await application.upsertPersonalProject({ personalSpaceId: spaceId, projectId,
        profile: { name: '会话项目 / Conversation project', lifecycle: 'active',
          purpose: '为尚未归属已有项目的会话提供独立的负责人和上下文。',
          boundaries: ['仅供当前会话使用，不隐式继承其他项目知识。'] } });
    }
    return matched(projectId, 'isolated_conversation');
  } catch {
    // A failed read cannot prove that no previous owner exists.
    return { status: 'unavailable', basis: null, personalProjectId: null,
      reason: 'session_scope_unavailable' };
  }
}

function matched(personalProjectId, basis) {
  return { status: 'matched', basis, personalProjectId };
}
