import type { LocationQuery, LocationQueryRaw } from 'vue-router'
import { NOTICE_KINDS } from '@/features/overview/notices'
import { CURRENT_WORK_STATUSES } from '@/features/overview/overview-data'
import type { ProjectAgentTaskStatus } from '@/types'

// The workbench's three lists, each with its own page (/workbench/<list>).
// Everything the person chose lives in the URL query, so a filtered list can
// be reloaded, shared and returned to; a default value stays out of the URL.
const WORKBENCH_LISTS = ['running', 'done', 'notices'] as const
export type WorkbenchList = typeof WORKBENCH_LISTS[number]

/** What each list holds: the task statuses, or the notice kinds. */
export const LIST_KINDS: Record<WorkbenchList, readonly string[]> = {
  running: [...CURRENT_WORK_STATUSES],
  done: ['completed', 'cancelled'] satisfies ProjectAgentTaskStatus[],
  notices: NOTICE_KINDS,
}
// 最近完成 opens on what was finished; a cancelled task is one filter away.
const DEFAULT_KINDS: Record<WorkbenchList, readonly string[]> = { running: [], done: ['completed'], notices: [] }

// Notices are kept for 90 days at most (src/notices/recent-notices.js).
export const LIST_RANGES: Record<WorkbenchList, readonly ListRange[]> = {
  running: ['all', '7d', '30d', '90d'],
  done: ['all', '7d', '30d', '90d'],
  notices: ['14d', '7d', '30d', '90d'],
}
type ListRange = 'all' | '7d' | '14d' | '30d' | '90d'
export const LIST_SORTS = ['newest', 'oldest'] as const
type ListSort = typeof LIST_SORTS[number]

export interface ListQuery {
  text: string
  range: ListRange
  projects: string[]
  flas: string[]
  /** Task statuses or notice kinds; empty means all the list holds. */
  kinds: string[]
  sort: ListSort
}

export const isWorkbenchList = (value: unknown): value is WorkbenchList => WORKBENCH_LISTS.includes(value as WorkbenchList)

export function defaultListQuery(list: WorkbenchList): ListQuery {
  return { text: '', range: LIST_RANGES[list][0], projects: [], flas: [], kinds: [...DEFAULT_KINDS[list]], sort: 'newest' }
}

const values = (value: LocationQuery[string] | undefined) => (Array.isArray(value) ? value : [value])
  .filter((item): item is string => typeof item === 'string' && item.trim() !== '')
const one = (value: LocationQuery[string] | undefined) => values(value)[0] ?? ''

/** The list's query as the URL says it; anything the list does not know falls back to its default. */
export function readListQuery(list: WorkbenchList, query: LocationQuery): ListQuery {
  const fallback = defaultListQuery(list)
  const range = one(query.range) as ListRange
  const sort = one(query.sort) as ListSort
  const known = LIST_KINDS[list]
  const kinds = values(query.kind).filter(kind => known.includes(kind))
  return {
    text: one(query.q).trim(),
    range: LIST_RANGES[list].includes(range) ? range : fallback.range,
    projects: [...new Set(values(query.project))],
    flas: [...new Set(values(query.fla))],
    kinds: query.kind === undefined ? fallback.kinds : [...new Set(kinds)],
    sort: LIST_SORTS.includes(sort) ? sort : fallback.sort,
  }
}

/** The URL query for a list's state, defaults left out. */
export function writeListQuery(list: WorkbenchList, state: ListQuery): LocationQueryRaw {
  const fallback = defaultListQuery(list)
  const query: LocationQueryRaw = {}
  if (state.text.trim()) query.q = state.text.trim()
  if (state.range !== fallback.range) query.range = state.range
  if (state.projects.length) query.project = [...state.projects]
  if (state.flas.length) query.fla = [...state.flas]
  // An emptied filter differs from 最近完成's default, so it is written as one empty value.
  if (!sameSet(state.kinds, fallback.kinds)) query.kind = state.kinds.length ? [...state.kinds] : ''
  if (state.sort !== fallback.sort) query.sort = state.sort
  return query
}

/** How many filters (not the search) differ from what the list opens with. */
export function activeFilterCount(list: WorkbenchList, state: ListQuery) {
  const fallback = defaultListQuery(list)
  return [state.range !== fallback.range, state.projects.length > 0, state.flas.length > 0,
    !sameSet(state.kinds, fallback.kinds), state.sort !== fallback.sort].filter(Boolean).length
}

/** Whether the person narrowed the list beyond what it opens with; a changed order does not narrow it. */
export function isFiltered(list: WorkbenchList, state: ListQuery) {
  const reordered = state.sort !== defaultListQuery(list).sort ? 1 : 0
  return Boolean(state.text) || activeFilterCount(list, state) > reordered
}

const DAY_MS = 24 * 60 * 60 * 1000
const rangeDays = (range: ListRange) => (range === 'all' ? null : Number.parseInt(range, 10))

/** The task page request: `/api/project-agent-task-pages`. */
export function taskPageParams(list: Exclude<WorkbenchList, 'notices'>, state: ListQuery, spaceId: string, now: number) {
  const params = new URLSearchParams({ personalSpaceId: spaceId })
  for (const status of state.kinds.length ? state.kinds : LIST_KINDS[list]) params.append('status', status)
  for (const project of state.projects) params.append('project', project)
  for (const fla of state.flas) params.append('agent', fla)
  if (state.text) params.set('q', state.text)
  const days = rangeDays(state.range)
  if (days) params.set('since', new Date(now - days * DAY_MS).toISOString())
  params.set('order', list === 'done' ? 'completed' : 'updated')
  params.set('sort', state.sort)
  return params
}

/** The notice page request: `/api/notices`. */
export function noticePageParams(state: ListQuery) {
  const params = new URLSearchParams({ days: String(rangeDays(state.range) ?? 90), sort: state.sort })
  for (const kind of state.kinds) params.append('kind', kind)
  for (const project of state.projects) params.append('project', project)
  for (const fla of state.flas) params.append('agent', fla)
  if (state.text) params.set('q', state.text)
  return params
}

function sameSet(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every(item => right.includes(item))
}
