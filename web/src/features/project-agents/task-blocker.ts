import type { BlockerClearCause, ProjectAgentTaskRecord } from '@/types'

/** The last time a block ended by itself, for a task that is no longer blocked. */
export function lastBlockerClear(task: ProjectAgentTaskRecord): { cause: BlockerClearCause; at: string } | null {
  if (task.status === 'blocked') return null
  const events = task.events ?? []
  // Only the end of the latest block: the first event after its last blocked report.
  const lastBlocked = events.map(item => item.status).lastIndexOf('blocked')
  const event = lastBlocked < 0 ? undefined : events[lastBlocked + 1]
  return event?.blockerClearedBy ? { cause: event.blockerClearedBy, at: event.createdAt } : null
}
