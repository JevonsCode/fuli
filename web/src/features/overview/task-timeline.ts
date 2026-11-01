import { currentLocale, t } from '@/i18n'
import { taskReason, type TaskReason } from '@/features/project-agents/task-reason'
import type { ProjectAgentTaskEvent, ProjectAgentTaskRecord } from '@/types'
import { taskLog } from './workbench-model'

// A task's progress as a timeline: every recorded event, newest first and
// grouped by day. Each event reads as one sentence (a recorded code becomes
// its sentence through taskReason; an Agent's own words read as written),
// and only its dot says it finished, was blocked or was unblocked.
export type TimelineTone = 'done' | 'blocked' | 'unblocked' | 'plain'
export interface TimelineEntry {
  id: string
  at: string | null
  agentId: string | null
  actorKind: string | null
  tone: TimelineTone
  reason: TaskReason
}
export interface TimelineDay { key: string; label: string; entries: TimelineEntry[] }

function tone(event: ProjectAgentTaskEvent): TimelineTone {
  if (event.blockerClearedBy) return 'unblocked'
  if (event.status === 'blocked') return 'blocked'
  if (event.status === 'completed') return 'done'
  return 'plain'
}

/** Every recorded event of the task, newest first. */
export function taskTimeline(task: ProjectAgentTaskRecord): TimelineEntry[] {
  return taskLog(task, Number.POSITIVE_INFINITY).map(event => ({
    id: event.eventId,
    at: event.createdAt ?? null,
    agentId: event.agentId ?? null,
    actorKind: event.actorKind ?? null,
    tone: tone(event),
    reason: taskReason(event.summary) ?? { text: event.summary, unknownCode: null, raw: null },
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
