import { getJson, postJson } from '@/api/client'
import { taskStatusLabel } from '@/features/project-agents/task-labels'
import { t } from '@/i18n'

// Scheduled project Agent tasks (F-P2-05 ⑥). The console routes share the
// service behind the manage_project_agent_schedule tool, so both enforce the
// same rules: fixed intervals of at least 15 minutes, no replay of missed
// slots, and a breaker that pauses after consecutive failed tasks.
export type ScheduleUnit = 'minutes' | 'hours' | 'days'
export type StartMode = 'queue' | 'backlog'

// One slot's claim. Until the Provider's task ID is saved, status is claimed
// (a submit is in flight or being recovered), unresolved (its outcome could not
// be checked yet) or failed (no task was created).
export interface ScheduleRun {
  slot: string
  taskId: string | null
  status: string
  createdAt: string
  leaseExpiresAt: string | null
  progress: string | null
  lastError: string | null
}

export interface TaskSchedule {
  id: string
  personalSpaceId: string
  personalProjectId: string
  revision: number
  enabled: boolean
  body: {
    title: string
    objective: string
    workKind: string
    requiredCapabilities: string[]
    leadAgentId: string | null
    every: { unit: ScheduleUnit; count: number }
    startMode: StartMode
    failureThreshold: number
  }
  nextRunAt: string
  pausedReason: string | null
  recentRuns?: ScheduleRun[]
}

export interface ScheduleDraft {
  personalProjectId: string
  title: string
  objective: string
  workKind: string
  every: { unit: ScheduleUnit; count: number }
  startMode: StartMode
  failureThreshold: number
  firstRunAt?: string
}

export const MINIMUM_INTERVAL_MINUTES = 15
const UNIT_MINUTES: Record<ScheduleUnit, number> = { minutes: 1, hours: 60, days: 1440 }

export function intervalTooShort(every: { unit: ScheduleUnit; count: number }): boolean {
  return !Number.isInteger(every.count) || every.count < 1 || every.count * UNIT_MINUTES[every.unit] < MINIMUM_INTERVAL_MINUTES
}

// A schedule is enabled, paused by a person, or paused by its breaker.
export function scheduleState(schedule: TaskSchedule): 'enabled' | 'paused' | 'circuit_open' | 'unknown' {
  if (schedule.enabled) return 'enabled'
  if (schedule.pausedReason === 'paused_by_user') return 'paused'
  if (schedule.pausedReason === 'circuit_open') return 'circuit_open'
  return 'unknown'
}

// A slot with a task shows the task's own status. Without one, a claim is never
// shown as working: it is being created while its first submit holds a live
// lease, recovering after a crash or a retry, or unknown until checked again.
export function scheduleRunLabel(run: ScheduleRun, now = Date.now()): string {
  if (run.taskId) return taskStatusLabel(run.status)
  if (run.status === 'unresolved') return t('taskSchedules.runState.unresolved')
  if (run.status !== 'claimed') return t('taskSchedules.runState.submitFailed')
  const leaseLive = run.leaseExpiresAt !== null && Date.parse(run.leaseExpiresAt) > now
  return t(leaseLive && run.progress === 'submitting' ? 'taskSchedules.runState.creating' : 'taskSchedules.runState.recovering')
}

export function listSchedules(spaceId: string, signal?: AbortSignal) {
  return getJson<{ schedules: TaskSchedule[] }>(`/api/task-schedules?${new URLSearchParams({ personalSpaceId: spaceId })}`, { signal })
}

export function scheduleRuns(spaceId: string, scheduleId: string) {
  return getJson<{ runs: ScheduleRun[] }>(
    `/api/task-schedules/${encodeURIComponent(scheduleId)}/runs?${new URLSearchParams({ personalSpaceId: spaceId })}`)
}

export function createSchedule(spaceId: string, draft: ScheduleDraft, signal?: AbortSignal) {
  return postJson<TaskSchedule>('/api/task-schedules', { personalSpaceId: spaceId, ...draft }, { signal })
}

// Pause and resume carry the revision the person saw; a stale one is a 409.
export function setScheduleEnabled(spaceId: string, schedule: TaskSchedule, enabled: boolean) {
  return postJson<TaskSchedule>(`/api/task-schedules/${encodeURIComponent(schedule.id)}/${enabled ? 'resume' : 'pause'}`,
    { personalSpaceId: spaceId, expectedRevision: schedule.revision })
}

export type ScheduleChanges = Pick<ScheduleDraft, 'title' | 'objective' | 'workKind' | 'every' | 'startMode' | 'failureThreshold'>

// Updating carries the revision the person edited; a stale one is a 409.
export function updateSchedule(spaceId: string, schedule: TaskSchedule, changes: ScheduleChanges) {
  return postJson<TaskSchedule>(`/api/task-schedules/${encodeURIComponent(schedule.id)}/update`,
    { personalSpaceId: spaceId, expectedRevision: schedule.revision, ...changes })
}

const UNIT_MS: Record<ScheduleUnit, number> = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 }
export const intervalMs = (every: { unit: ScheduleUnit; count: number }) => UNIT_MS[every.unit] * every.count
