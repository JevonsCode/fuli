import type { AgentAttention } from '@/features/project-agents/attention-store'
import type { ProjectAgentTaskRecord, ProjectAgentTaskStatus } from '@/types'

// One reading of the work for every workbench design, so they differ only in
// how they show it: what waits for you, what runs, what is stuck, what just ended.
export type WorkLane = 'waiting' | 'running' | 'stuck' | 'done'

const LANE: Partial<Record<ProjectAgentTaskStatus, WorkLane>> = {
  awaiting_review: 'waiting',
  awaiting_recruitment: 'running',
  queued: 'running',
  running: 'running',
  paused: 'running',
  blocked: 'stuck',
  failed: 'stuck',
  completed: 'done',
}

const DAY_MS = 24 * 60 * 60 * 1000
const time = (value?: string | null) => (value ? Date.parse(value) : NaN)
const latest = (task: ProjectAgentTaskRecord) => time(task.completedAt ?? task.updatedAt ?? task.createdAt)

export function laneOf(task: ProjectAgentTaskRecord): WorkLane | null {
  return LANE[task.status] ?? null
}

/** Tasks per lane, newest first; "done" keeps only the last day. */
export function workLanes(tasks: readonly ProjectAgentTaskRecord[], now = Date.now()) {
  const lanes: Record<WorkLane, ProjectAgentTaskRecord[]> = { waiting: [], running: [], stuck: [], done: [] }
  for (const task of tasks) {
    const lane = laneOf(task)
    if (!lane) continue
    if (lane === 'done' && !(now - latest(task) <= DAY_MS)) continue
    lanes[lane].push(task)
  }
  for (const list of Object.values(lanes)) list.sort((a, b) => (latest(b) || 0) - (latest(a) || 0))
  return lanes
}

export type FocusItem =
  | { kind: 'question'; attention: AgentAttention }
  | { kind: 'stuck'; task: ProjectAgentTaskRecord }
  | { kind: 'review'; task: ProjectAgentTaskRecord }

/**
 * The one thing that most needs the person: the oldest open question from an
 * Agent, else the longest-stuck task, else work waiting for review.
 */
export function focusItem(attention: readonly AgentAttention[], tasks: readonly ProjectAgentTaskRecord[]): FocusItem | null {
  const open = attention.filter(item => item.status === 'open').sort((a, b) => time(a.createdAt) - time(b.createdAt))
  if (open[0]) return { kind: 'question', attention: open[0] }
  const lanes = workLanes(tasks)
  const stuck = [...lanes.stuck].sort((a, b) => (latest(a) || 0) - (latest(b) || 0))[0]
  if (stuck) return { kind: 'stuck', task: stuck }
  const review = lanes.waiting.at(-1)
  return review ? { kind: 'review', task: review } : null
}

export interface TimelineHour { hour: number; label: string; tasks: ProjectAgentTaskRecord[] }

/** The last day of activity by hour, newest hour first. */
export function timelineHours(tasks: readonly ProjectAgentTaskRecord[], now = Date.now(), locale?: string): TimelineHour[] {
  const hours = new Map<number, ProjectAgentTaskRecord[]>()
  for (const task of tasks) {
    const at = latest(task)
    if (!Number.isFinite(at) || now - at > DAY_MS || at > now) continue
    const hour = Math.floor(at / 3_600_000) * 3_600_000
    hours.set(hour, [...(hours.get(hour) ?? []), task])
  }
  const format = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' })
  return [...hours.entries()].sort(([a], [b]) => b - a).map(([hour, list]) => ({
    hour, label: format.format(hour), tasks: list.sort((a, b) => (latest(b) || 0) - (latest(a) || 0)),
  }))
}
