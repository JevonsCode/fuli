import type { WorkbenchStatus } from '@/features/agent-profile/agent-workbench'

/**
 * How the FLAs page groups its people: what needs the person first, then who
 * is working, who is free, whose state is not known yet, and who is switched
 * off. An unknown state is never shown as idle.
 */
export type FlaGroupKey = 'attention' | 'working' | 'idle' | 'unknown' | 'inactive'

export const FLA_GROUP_ORDER: readonly FlaGroupKey[] = ['attention', 'working', 'idle', 'unknown', 'inactive']

const WORK_GROUP: Record<WorkbenchStatus, FlaGroupKey> = {
  awaiting_review: 'attention',
  blocked: 'attention',
  paused: 'attention',
  awaiting_recruitment: 'attention',
  running: 'working',
  queued: 'working',
  none: 'idle',
  ended: 'idle',
  loading: 'unknown',
  unreported: 'unknown',
  unavailable: 'unknown',
}

export function flaGroup(memberStatus: string, work: WorkbenchStatus | undefined): FlaGroupKey {
  if (memberStatus !== 'active') return 'inactive'
  return WORK_GROUP[work ?? 'unreported']
}

/** Rows in their given order, split into the non-empty groups in FLA_GROUP_ORDER. */
export function groupFlas<T>(rows: readonly T[], groupOf: (row: T) => FlaGroupKey) {
  const groups = new Map<FlaGroupKey, T[]>()
  for (const row of rows) {
    const key = groupOf(row)
    groups.set(key, [...(groups.get(key) ?? []), row])
  }
  return FLA_GROUP_ORDER.filter(key => groups.has(key)).map(key => ({ key, rows: groups.get(key)! }))
}
