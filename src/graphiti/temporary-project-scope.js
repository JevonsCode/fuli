import { createHash } from 'node:crypto';

export const temporaryProjectScope = Object.freeze({
  type: 'temporary', lifetime: 'task', persisted: true
});

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
