import { postJson } from '@/api/client'
import { currentLocale, t } from '@/i18n'
import { formatElapsed } from '@/lib/elapsed-time'
import type { BlockerClearCause, ProjectAgentTaskBlocker, ProjectAgentTaskRecord } from '@/types'
import { formatDate } from './task-labels'
import { taskReason } from './task-reason'
import type { TaskScope } from './task-runs'

// A block with no recorded activity for this long gets a quiet hint that the
// person can mark it cleared: its session has most likely moved on.
const STALE_AFTER_MS = 3 * 24 * 60 * 60 * 1000

/**
 * The block in one plain sentence: what is missing or being asked. Every
 * surface reads the reason through here, so a reason code becomes words in
 * one place (taskReason: a known code reads as its sentence, an unknown one
 * as a generic sentence, an Agent's own words as written).
 */
export function blockerReasonText(blocker: Pick<ProjectAgentTaskBlocker, 'reason'> | null | undefined) {
  return taskReason(blocker?.reason)?.text ?? t('taskBlocker.noReason')
}

/** How long the task has been blocked ("3 天"); null when its start was not recorded. */
export function blockedFor(blocker: Pick<ProjectAgentTaskBlocker, 'since'>, now = Date.now()) {
  return formatElapsed(blocker.since, currentLocale(), now)
}

/** No recorded activity on the blocked task for about three days. */
export function blockerIsStale(blocker: Pick<ProjectAgentTaskBlocker, 'since'>, updatedAt: string | null | undefined, now = Date.now()) {
  const times = [blocker.since, updatedAt].map(value => (value ? Date.parse(value) : Number.NaN)).filter(Number.isFinite)
  return times.length > 0 && now - Math.max(...times) > STALE_AFTER_MS
}

/** How and when the latest block ended without the task's own report, for a task that is no longer blocked. */
export function lastBlockerClear(task: ProjectAgentTaskRecord): { cause: BlockerClearCause; at: string; note: string | null } | null {
  if (task.status === 'blocked') return null
  const events = task.events ?? []
  // Only the end of the latest block: the first event after its last blocked report.
  const lastBlocked = events.map(item => item.status).lastIndexOf('blocked')
  const event = lastBlocked < 0 ? undefined : events[lastBlocked + 1]
  return event?.blockerClearedBy
    ? { cause: event.blockerClearedBy, at: event.createdAt, note: event.blockerClearNote ?? null }
    : null
}

// Causes FULI ended by itself, read as 自动解除; the others name who ended the block.
const AUTOMATIC: ReadonlySet<BlockerClearCause> = new Set(['session_activity', 'session_reply', 'attention_answer'])

/** The card's line for a block that ended: when, and who or what ended it. */
export function blockerClearLine(clear: { cause: BlockerClearCause; at: string }) {
  const time = formatDate(clear.at)
  if (clear.cause === 'person') return t('taskBlocker.clearedByYou', { time })
  const cause = t(`taskBlocker.causes.${clear.cause}`)
  return t(AUTOMATIC.has(clear.cause) ? 'taskBlocker.cleared' : 'taskBlocker.clearedBy', { time, cause })
}

/** The person's 「标记为已解除」; the console accepts it only from this computer. */
export function markTaskUnblocked(scope: TaskScope, note: string): Promise<ProjectAgentTaskRecord> {
  return postJson<ProjectAgentTaskRecord>(`/api/project-agent-tasks/${encodeURIComponent(scope.taskId)}/blocker/clear`,
    { personalSpaceId: scope.personalSpaceId, personalProjectId: scope.personalProjectId, note: note.trim() || null })
}

/** The person's one-click 「确认已解除」 of a block FULI sees as probably resolved. */
export function confirmTaskUnblocked(scope: TaskScope): Promise<ProjectAgentTaskRecord> {
  return postJson<ProjectAgentTaskRecord>(`/api/project-agent-tasks/${encodeURIComponent(scope.taskId)}/blocker/clear`,
    { personalSpaceId: scope.personalSpaceId, personalProjectId: scope.personalProjectId, confirmHint: true })
}
