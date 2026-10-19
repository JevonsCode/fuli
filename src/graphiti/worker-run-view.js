// On-demand history only. Never merge requested models with actual observations.
export function workerRunRecord(run) {
  const result = run.execution_result;
  return {
    runId: run.run_id, taskId: run.task_id, agentId: run.agent_id, workerId: run.worker_id,
    personalSpaceId: run.personal_space_id, personalProjectId: run.personal_project_id,
    executorId: run.executor_id, targetApplication: run.target_application,
    state: run.state, executionStatus: run.execution_status ?? 'unknown',
    attemptNumber: run.attempt_number ?? null, rootRunId: run.root_run_id ?? null,
    retryOfRunId: run.retry_of_run_id ?? null,
    requestedModelProvider: run.requested_model_provider ?? null, requestedModel: run.requested_model ?? null,
    requestedModelStrategy: run.requested_model_strategy ?? null,
    actualModel: null, actualModelProvider: null,
    actualSessionId: run.actual_session_id ?? null, createdAt: run.created_at,
    closedAt: run.closed_at ?? null, finishedAt: run.finished_at ?? null,
    revokedAt: run.revoked_at ?? null, closeReason: run.close_reason ?? null,
    promptDispatchedAt: run.prompt_dispatched_at ?? null,
    executionResult: result ? { status: result.status, code: result.code, stage: result.stage,
      failureClass: result.failure_class, promptDispatched: result.prompt_dispatched,
      processStopped: result.process_stopped, runClosed: result.run_closed,
      terminalRecorded: result.terminal_recorded, cleanupErrors: result.cleanup_errors,
      retryEligible: result.retry_eligible, attemptLimit: result.attempt_limit,
      retryNotBefore: result.retry_not_before } : null
  };
}
