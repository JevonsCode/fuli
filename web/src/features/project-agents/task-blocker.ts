import { t } from '@/i18n'
import type { BlockerClearCause, ProjectAgentTaskBlocker, ProjectAgentTaskRecord } from '@/types'

// A worker FULI started reports its block as a code ("worker_session_stopped. …");
// the person reads the sentence it stands for.
const WORKER_CODE = /^(worker_[a-z_]+)\.(?:\s|$)/
const WORKER_CODES = new Set([
  'worker_authentication_required', 'worker_authentication_unknown', 'worker_workspace_untrusted',
  'worker_model_unavailable', 'worker_model_strategy_unmapped', 'worker_session_stopped',
])

/** The block in one plain sentence: what is missing or being asked. */
export function blockerReasonText(blocker: Pick<ProjectAgentTaskBlocker, 'reason'> | null | undefined) {
  const reason = blocker?.reason?.trim()
  if (!reason) return t('taskBlocker.noReason')
  const code = WORKER_CODE.exec(reason)?.[1]
  return code && WORKER_CODES.has(code) ? t(`taskBlocker.codes.${code}`) : reason
}

/** The last time a block ended by itself, for a task that is no longer blocked. */
export function lastBlockerClear(task: ProjectAgentTaskRecord): { cause: BlockerClearCause; at: string } | null {
  if (task.status === 'blocked') return null
  const events = task.events ?? []
  // Only the end of the latest block: the first event after its last blocked report.
  const lastBlocked = events.map(item => item.status).lastIndexOf('blocked')
  const event = lastBlocked < 0 ? undefined : events[lastBlocked + 1]
  return event?.blockerClearedBy ? { cause: event.blockerClearedBy, at: event.createdAt } : null
}
