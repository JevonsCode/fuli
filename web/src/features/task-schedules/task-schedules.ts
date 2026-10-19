import { getJson, postJson } from '@/api/client'

// Scheduled project Agent tasks (F-P2-05 ⑥). The console routes share the
// service behind the manage_project_agent_schedule tool, so both enforce the
// same rules: fixed intervals of at least 15 minutes, no replay of missed
// slots, and a breaker that pauses after consecutive failed tasks.
export type ScheduleUnit = 'minutes' | 'hours' | 'days'
export type StartMode = 'queue' | 'backlog'

export interface ScheduleRun { slot: string; taskId: string | null; status: string; createdAt: string }

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
