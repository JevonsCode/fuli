// Called only after a cross-project answer or bounded read actually returns.
// The Provider derives the source project and verifies the live task again.
export async function recordProjectMemoryUsage(app, input) {
  if (!input.taskContextToken || !Number.isSafeInteger(input.resultCount) || input.resultCount < 1) {
    return { recorded: false, reason: 'no_result' };
  }
  const context = await app.taskContextRegistry.context(input.taskContextToken);
  if (!context.personalProjectId || context.personalProjectId === input.targetProjectId) {
    return { recorded: false, reason: 'not_cross_project' };
  }
  return app.personal.recordProjectMemoryUsage({
    personal_space_id: app.config.personalSpaceId,
    task_context_token: input.taskContextToken,
    source_application: context.sourceApplication,
    target_project_id: input.targetProjectId,
    channel: input.channel,
    evidence_id: input.evidenceId,
    result_count: input.resultCount,
    ...(input.taskId ? { task_id: input.taskId } : {})
  });
}
