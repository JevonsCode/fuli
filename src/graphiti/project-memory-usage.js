import { captureDecision, taskCaptureScope } from './capture-decision.js';

// Called only after a cross-project answer or bounded read actually returns.
// The Provider derives the source project and verifies the live task again.
export async function recordProjectMemoryUsage(app, input) {
  if (!input.taskContextToken || !Number.isSafeInteger(input.resultCount) || input.resultCount < 1) {
    return { recorded: false, reason: 'no_result' };
  }
  const context = await app.taskContextRegistry.context(input.taskContextToken, input.sourceApplication);
  // Cross-project usage weights project relations from a session's reads, so it
  // stops with automatic recording (rec#11 D-01).
  const capture = captureDecision(app, taskCaptureScope(context));
  if (!capture.allowed) return { recorded: false, reason: capture.reason, layer: capture.layer };
  if (!context.personalProjectId || context.personalProjectId === input.targetProjectId) {
    return { recorded: false, reason: 'not_cross_project' };
  }
  return app.personal.recordProjectMemoryUsage({
    personal_space_id: app.config.personal.spaceId,
    task_context_token: input.taskContextToken,
    source_application: context.sourceApplication,
    target_project_id: input.targetProjectId,
    channel: input.channel,
    evidence_id: input.evidenceId,
    result_count: input.resultCount,
    ...(input.taskId ? { task_id: input.taskId } : {})
  });
}

// Search scope is granted by the existing read-only lookup. This observation
// derives its source from the host's live task and never expands that scope.
export async function recordReadExtensionUsage(app, input) {
  if ((input.personalProjectScope !== 'all_local_confirmed' && !input.contextPersonalProjectIds?.length)
      || !input.sourceSessionId || input.sourceSessionId.startsWith('fuli-host-')) return;
  const hits = [...(input.facts ?? []), ...(input.entities ?? [])]
    .filter(item => item.scope === 'personal' && item.defined_project_id && item.id);
  if (!hits.length) return;
  const task = await app.taskContextRegistry.current(input.sourceSessionId, input.sourceApplication);
  if (!task?.token || !task.personalProjectId || task.checkpoint?.phase === 'complete') return;
  const targets = new Map();
  for (const item of hits) {
    if (item.defined_project_id === task.personalProjectId) continue;
    if (!targets.has(item.defined_project_id)) targets.set(item.defined_project_id, []);
    targets.get(item.defined_project_id).push(item.id);
  }
  for (const [targetProjectId, ids] of targets) {
    await recordProjectMemoryUsage(app, { taskContextToken: task.token, sourceApplication: task.sourceApplication,
      targetProjectId, channel: 'read_extension_result', evidenceId: `lookup:${ids[0]}`,
      resultCount: ids.length });
  }
}
