import type { WorkbenchStatus } from '@/features/agent-profile/agent-workbench'

/**
 * How the FLAs page groups its people: what needs the person first, then who
 * is working, who is free, whose state is not known yet, and who is switched
 * off. An unknown state is never shown as idle.
 */
export type FlaGroupKey = 'attention' | 'working' | 'idle' | 'unknown' | 'inactive'

export const FLA_GROUP_ORDER: readonly FlaGroupKey[] = ['attention', 'working', 'idle', 'unknown', 'inactive']

/** The order a link from 今天's 正在干活 asks for (`?view=work&first=working`): who is working comes first. */
export const WORKING_FIRST_ORDER: readonly FlaGroupKey[] = ['working', ...FLA_GROUP_ORDER.filter(key => key !== 'working')]

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

/** Rows in their given order, split into the non-empty groups in `order`. */
export function groupFlas<T>(rows: readonly T[], groupOf: (row: T) => FlaGroupKey, order: readonly FlaGroupKey[] = FLA_GROUP_ORDER) {
  const groups = new Map<FlaGroupKey, T[]>()
  for (const row of rows) {
    const key = groupOf(row)
    groups.set(key, [...(groups.get(key) ?? []), row])
  }
  return order.filter(key => groups.has(key)).map(key => ({ key, rows: groups.get(key)! }))
}

/**
 * The other way to group them: the FLAs who work together on a project, and
 * the global ones who belong to no project (the assistant, Jefa, Bole and
 * the like, or an FLA not yet given one).
 */
export type FlaScopeKey = 'team' | 'global'

/** Rows in their given order, team first, dropping an empty group. */
export function groupFlasByScope<T>(rows: readonly T[], onProject: (row: T) => boolean): { key: FlaScopeKey; rows: T[] }[] {
  const groups: [FlaScopeKey, T[]][] = [['team', rows.filter(onProject)], ['global', rows.filter(row => !onProject(row))]]
  return groups.filter(([, group]) => group.length).map(([key, group]) => ({ key, rows: group }))
}
