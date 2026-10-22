import { createHash } from 'node:crypto';

export const temporaryProjectScope = Object.freeze({
  type: 'temporary', lifetime: 'task', persisted: true
});

const TEMPORARY_PROJECT_ID = /^temporary-[0-9a-f]{64}$/;

// A task-scoped project for work outside every registered project.
export function isTemporaryProjectId(projectId) {
  return typeof projectId === 'string' && TEMPORARY_PROJECT_ID.test(projectId);
}

// Explicit coordination owns provisioning. Preference and discovery reads never
// create projects. Identity contains no filesystem paths, prompts or host IDs.
export async function resolveCoordinationScope(application, resolution, input, entryTask) {
  const projectId = resolution.personal_project_id ?? resolution.personalProjectId;
  if (projectId) {
    if (resolution.basis !== 'explicit_personal_project_id') return resolution;
    const project = await application.personal.getPersonalProject?.(
      application.config.personal.spaceId, projectId);
    if (project?.scope_type !== 'temporary') return resolution;
    return { ...resolution, status: 'temporary', scope: temporaryProjectScope };
  }
  if (!['unmatched', 'not_provided'].includes(resolution.status)) return resolution;
  if (entryTask?.personalProjectId && entryTask.projectScope?.type !== 'temporary') {
    throw new TypeError('Coordination task context belongs to another project');
  }
  const scopeKey = createHash('sha256').update(JSON.stringify([
    'fuli-temporary-task-v1', application.config.personal.spaceId,
    input.sourceApplication ?? 'other',
    input.taskContextToken ?? input.sourceSessionId ?? null,
    input.taskContextToken ? null : input.idempotencyKey
  ])).digest('hex');
  const project = await application.personal.ensureTemporaryProject({
    personal_space_id: application.config.personal.spaceId,
    scope_key: scopeKey,
    source_application: input.sourceApplication ?? 'other',
    task_context_token: input.taskContextToken ?? null
  });
  if (project.scope_type !== 'temporary' || project.project_id !== `temporary-${scopeKey}`) {
    throw new TypeError('Provider did not confirm the isolated temporary project');
  }
  return { status: 'temporary', basis: 'task_scope', personal_project_id: project.project_id,
    scope: temporaryProjectScope, original_status: resolution.status };
}

export function scopedTaskIdempotencyKey(projectId, input) {
  return createHash('sha256').update(JSON.stringify([
    projectId, input.sourceApplication ?? 'other', input.taskContextToken ?? input.sourceSessionId ?? null,
    input.idempotencyKey
  ])).digest('hex');
}

// The session's own temporary project (rec#20): what was worth keeping while
// nobody chose where it applies. A task already in a temporary project keeps
// using it; otherwise the session gets one, keyed by its client and session.
// Like every temporary project it inherits nothing and shares nothing.
export async function ensureSessionTemporaryProject(application, task) {
  if (isTemporaryProjectId(task.personalProjectId)) return task.personalProjectId;
  const projectId = sessionTemporaryProjectId(application.config.personal.spaceId,
    task.sourceApplication ?? 'other', task.sessionId);
  const project = await application.personal.ensureTemporaryProject({
    personal_space_id: application.config.personal.spaceId, scope_key: projectId.slice('temporary-'.length),
    source_application: task.sourceApplication ?? 'other', lifetime: 'session'
  });
  if (project?.scope_type !== 'temporary' || project.project_id !== projectId) {
    throw new TypeError('Provider did not confirm the session temporary project');
  }
  return project.project_id;
}

// One host session's temporary project. The Provider derives the same ID
// (temporary_project_scope.session_temporary_project_id) when it lists what
// the session holds for a batch migration (rec#20 part 2).
function sessionTemporaryProjectId(spaceId, sourceApplication, sessionId) {
  return `temporary-${createHash('sha256').update(JSON.stringify([
    'fuli-temporary-session-v1', spaceId, sourceApplication, sessionId
  ])).digest('hex')}`;
}
