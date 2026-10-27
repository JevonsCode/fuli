import { postJson } from '@/api/client'
import { currentLocale, t } from '@/i18n'
import { formatElapsed } from '@/lib/elapsed-time'
import type { BlockerClearCause, ProjectAgentTaskBlocker, ProjectAgentTaskRecord } from '@/types'
import type { TaskScope } from './task-runs'

// A worker FULI started reports its block as a code ("worker_session_stopped. …");
// the person reads the sentence it stands for.
const WORKER_CODE = /^(worker_[a-z_]+)\.(?:\s|$)/
const WORKER_CODES = new Set([
  'worker_authentication_required', 'worker_authentication_unknown', 'worker_workspace_untrusted',
  'worker_model_unavailable', 'worker_model_strategy_unmapped', 'worker_session_stopped',
])
// A block with no recorded activity for this long gets a quiet hint that the
// person can mark it cleared: its session has most likely moved on.
const STALE_AFTER_MS = 3 * 24 * 60 * 60 * 1000

/**
 * The block in one plain sentence: what is missing or being asked. Every
 * surface reads the reason through here, so a reason code becomes words in
 * one place.
 */
export function blockerReasonText(blocker: Pick<ProjectAgentTaskBlocker, 'reason'> | null | undefined) {
  const reason = blocker?.reason?.trim()
  if (!reason) return t('taskBlocker.noReason')
  const code = WORKER_CODE.exec(reason)?.[1]
  return code && WORKER_CODES.has(code) ? t(`taskBlocker.codes.${code}`) : reason
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

/** The person's 「标记为已解除」; the console accepts it only from this computer. */
export function markTaskUnblocked(scope: TaskScope, note: string): Promise<ProjectAgentTaskRecord> {
  return postJson<ProjectAgentTaskRecord>(`/api/project-agent-tasks/${encodeURIComponent(scope.taskId)}/blocker/clear`,
    { personalSpaceId: scope.personalSpaceId, personalProjectId: scope.personalProjectId, note: note.trim() || null })
}
