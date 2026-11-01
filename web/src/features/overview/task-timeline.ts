import { currentLocale, t } from '@/i18n'
import { taskReason, type TaskReason } from '@/features/project-agents/task-reason'
import type { ProjectAgentTaskEvent, ProjectAgentTaskParticipant, ProjectAgentTaskRecord } from '@/types'
import { taskLog } from './workbench-model'

// A task's progress as a timeline: every recorded event, newest first and
// grouped by day. Each event reads as one sentence (a recorded code becomes
// its sentence through taskReason; an Agent's own words read as written),
// and only its dot says it finished, was blocked or was unblocked. Beside it
// stand the other FLAs that were at work at that moment.
export type TimelineTone = 'done' | 'blocked' | 'unblocked' | 'plain'
export interface TimelineEntry {
  id: string
  at: string | null
  agentId: string | null
  actorKind: string | null
  tone: TimelineTone
  reason: TaskReason
  /** The other FLAs at work when it happened, in the task's participant order. */
  crew: string[]
}
export interface TimelineDay { key: string; label: string; entries: TimelineEntry[] }

function tone(event: ProjectAgentTaskEvent): TimelineTone {
  if (event.blockerClearedBy) return 'unblocked'
  if (event.status === 'blocked') return 'blocked'
  if (event.status === 'completed') return 'done'
  return 'plain'
}

const LIVE = new Set(['running', 'queued', 'awaiting_recruitment'])
const parse = (value?: string | null) => {
  const time = value ? Date.parse(value) : NaN
  return Number.isNaN(time) ? null : time
}

// When an FLA was at work: from it started running (or joined) until it
// ended; still open while its status is live. A window the record cannot
// bound is no window, so no one is claimed to be working.
function workWindow(participant: ProjectAgentTaskParticipant): [number, number] | null {
  const start = parse(participant.runningSince ?? participant.joinedAt)
  const end = parse(participant.endedAt) ?? (LIVE.has(participant.status) ? Number.POSITIVE_INFINITY : parse(participant.updatedAt))
  return start === null || end === null ? null : [start, end]
}

/** Every recorded event of the task, newest first. */
export function taskTimeline(task: ProjectAgentTaskRecord): TimelineEntry[] {
  // An FLA reassigned to the task has several windows; it stands once.
  const windows = (task.participants ?? []).flatMap(participant => {
    const window = participant.agentId ? workWindow(participant) : null
    return window ? [{ agentId: participant.agentId, window }] : []
  })
  const crewAt = (event: ProjectAgentTaskEvent) => {
    const at = parse(event.createdAt)
    return at === null ? [] : [...new Set(windows
      .filter(({ agentId, window: [start, end] }) => agentId !== event.agentId && start <= at && at <= end)
      .map(({ agentId }) => agentId))]
  }
  return taskLog(task, Number.POSITIVE_INFINITY).map(event => ({
    id: event.eventId,
    at: event.createdAt ?? null,
    agentId: event.agentId ?? null,
    actorKind: event.actorKind ?? null,
    tone: tone(event),
    reason: taskReason(event.summary) ?? { text: event.summary, unknownCode: null, raw: null },
    crew: crewAt(event),
  }))
}

const dayKey = (date: Date) => `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`

/** The entries grouped by local day, labelled 今天 / 昨天 / the date. */
export function timelineDays(entries: readonly TimelineEntry[], now = new Date()): TimelineDay[] {
  const today = dayKey(now)
  const yesterday = dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))
  const days: TimelineDay[] = []
  for (const entry of entries) {
    const date = entry.at ? new Date(entry.at) : null
    const key = date && !Number.isNaN(date.getTime()) ? dayKey(date) : 'unknown'
    let day = days.at(-1)
    if (day?.key !== key) {
      const label = key === today ? t('overview.timeline.today') : key === yesterday ? t('overview.timeline.yesterday')
        : key === 'unknown' ? t('overview.timeline.undated') : new Intl.DateTimeFormat(currentLocale(), { month: 'short', day: 'numeric' }).format(date!)
      day = { key, label, entries: [] }
      days.push(day)
    }
    day.entries.push(entry)
  }
  return days
}
