import { ApiError, getJson, postJson } from '@/api/client'
import type { ProjectAgentTaskStatus } from '@/types'

// Run history and the user's stop / retry controls for one task (F-P2-05 ⑦).
// A run's authority state and its execution result are kept apart: revoking a
// run is not proof that its process stopped.
export interface TaskRunResult {
  status?: string | null
  code?: string | null
  stage?: string | null
  failureClass?: string | null
  promptDispatched?: boolean | null
  processStopped?: boolean | null
  runClosed?: boolean | null
  terminalRecorded?: boolean | null
  cleanupErrors?: string[] | null
}

export interface TaskRunRecord {
  runId: string
  taskId: string
  agentId: string
  workerId?: string | null
  executorId?: string | null
  targetApplication?: string | null
  state: string
  executionStatus: string
  attemptNumber?: number | null
  createdAt: string
  closedAt?: string | null
  revokedAt?: string | null
  closeReason?: string | null
  executionResult: TaskRunResult | null
}

export interface TaskRunPage { runs: TaskRunRecord[]; nextCursor: string | null; complete: boolean }
export interface TaskScope { personalSpaceId: string; personalProjectId: string; taskId: string }

const ACTIVE_RUN_STATES = new Set(['prepared', 'claimed', 'sealed', 'admitted'])
const RETRYABLE: ReadonlySet<ProjectAgentTaskStatus> = new Set(['failed', 'cancelled'])

export const runIsActive = (run: TaskRunRecord) => ACTIVE_RUN_STATES.has(run.state)
export const taskIsRetryable = (status: ProjectAgentTaskStatus) => RETRYABLE.has(status)

// Something may have happened outside FULI: the prompt went out but no terminal
// record, a process stop that was not reported, or cleanup that failed.
export function runOutcomeUncertain(run: TaskRunRecord): boolean {
  const result = run.executionResult
  if (!result) return Boolean(run.state === 'closed' || run.state === 'revoked')
  return (result.promptDispatched === true && result.terminalRecorded !== true)
    || result.processStopped !== true
    || Boolean(result.cleanupErrors?.length)
}

export function readTaskRuns(scope: TaskScope, cursor: string | null, signal?: AbortSignal): Promise<TaskRunPage> {
  const query = new URLSearchParams({ personalSpaceId: scope.personalSpaceId, personalProjectId: scope.personalProjectId, limit: '50' })
  if (cursor) query.set('cursor', cursor)
  return getJson<TaskRunPage>(`/api/project-agent-tasks/${encodeURIComponent(scope.taskId)}/runs?${query}`, { signal })
}

// Appends a page in order; a run seen again keeps its newest evidence.
export function mergeRunPages(current: TaskRunRecord[], next: TaskRunRecord[]): TaskRunRecord[] {
  const byId = new Map(current.map(run => [run.runId, run]))
  for (const run of next) byId.set(run.runId, run)
  return [...byId.values()]
}

export interface StopRunResponse { status: 'stopping' | 'already_stopped'; run: TaskRunRecord }

export function stopTaskRun(scope: TaskScope, runId: string): Promise<StopRunResponse> {
  return postJson<StopRunResponse>(
    `/api/project-agent-tasks/${encodeURIComponent(scope.taskId)}/runs/${encodeURIComponent(runId)}/stop`,
    { personalSpaceId: scope.personalSpaceId, personalProjectId: scope.personalProjectId })
}

export interface RetryResponse {
  task: { taskId: string; status: ProjectAgentTaskStatus; leadAgentId?: string | null }
  assignedAgent?: { agentId: string } | null
}

// One retry per task: the server keys it by the original task, so a double
// click or a resend after a lost response returns the same new task.
export function retryTask(scope: TaskScope, start: boolean): Promise<RetryResponse> {
  return postJson<RetryResponse>(`/api/project-agent-tasks/${encodeURIComponent(scope.taskId)}/retry`,
    { personalSpaceId: scope.personalSpaceId, personalProjectId: scope.personalProjectId, start })
}

export type ActionFailure = 'conflict' | 'not_found' | 'denied' | 'unknown' | 'rejected'

// A server or network failure on a write means the result is unknown, not that nothing happened.
export function actionFailure(error: unknown): ActionFailure {
  if (!(error instanceof ApiError)) return 'unknown'
  if (error.status === 409) return 'conflict'
  if (error.status === 404) return 'not_found'
  if (error.status === 401 || error.status === 403) return 'denied'
  return error.status >= 500 ? 'unknown' : 'rejected'
}
