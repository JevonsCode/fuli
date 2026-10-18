import { requiredString } from '../validation/values.js';
import { workerRunRecord } from './worker-run-view.js';

const RETRYABLE_TASK_STATUSES = new Set(['failed', 'cancelled']);
const notFound = () => Object.assign(new Error('Task run not found.'), { status: 404, code: 'task_run_not_found' });

// User and lead controls over task runs (F-P2-05 ⑦). Stopping revokes the run's
// authority; the worker host notices within its next authority read, stops the
// process and records the result. Retrying a terminal task creates a new task
// for the same work (history stays immutable); automatic run-level retries stay
// with the host policy. History replays the recorded runs and their results.
export async function stopProjectAgentTaskRun(application, input) {
  const scope = taskScope(input);
  const runId = requiredString(input.runId, 'runId', 128);
  const history = await application.personal.listProjectAgentTaskRuns({ ...scope, limit: 100 });
  const run = history.runs.find(item => item.run_id === runId);
  if (!run) throw notFound();
  if (['closed', 'revoked'].includes(run.state)) return { status: 'already_stopped', run: workerRunRecord(run) };
  const stopped = await application.personal.revokeProjectAgentWorkerRun(runId, {
    personal_space_id: scope.personalSpaceId, personal_project_id: scope.personalProjectId,
    reason: 'worker_stopped_by_request' });
  return { status: 'stopping', run: workerRunRecord(stopped?.run ?? stopped) };
}

export async function retryProjectAgentTask(application, input) {
  const scope = taskScope(input);
  const task = await application.viewProjectAgentTask({ ...scope, includeEvents: false });
  if (!RETRYABLE_TASK_STATUSES.has(task.status)) {
    throw Object.assign(new Error('Only a failed or cancelled task can be retried; stop a running task first.'),
      { status: 409, code: 'task_not_retryable' });
  }
  return application.submitProjectAgentTask({ personalSpaceId: scope.personalSpaceId, personalProjectId: scope.personalProjectId,
    // One retry per task unless the caller names a new attempt, so a double click never duplicates work.
    idempotencyKey: input.idempotencyKey ?? `retry:${scope.taskId}`,
    title: task.title, objective: task.objective, workKind: task.workKind,
    requiredCapabilities: task.requiredCapabilities, ...(task.leadAgentId ? { leadAgentId: task.leadAgentId } : {}),
    start: input.start !== false, duration: 'one_off',
    routingReason: `Retry of task ${scope.taskId}, which ended ${task.status}.` });
}

function taskScope(input) {
  return { personalSpaceId: requiredString(input.personalSpaceId, 'personalSpaceId', 128),
    personalProjectId: requiredString(input.personalProjectId, 'personalProjectId', 128),
    taskId: requiredString(input.taskId, 'taskId', 128) };
}
