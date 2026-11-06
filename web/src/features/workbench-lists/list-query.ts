import type { LocationQuery, LocationQueryRaw } from 'vue-router'
import { NOTICE_KINDS } from '@/features/overview/notices'
import { CURRENT_WORK_STATUSES } from '@/features/overview/overview-data'
import type { ProjectAgentTaskStatus } from '@/types'

// The workbench's three lists, each with its own page (/workbench/<list>).
// They share a shell: search, a time range and a sort, inline. Each list then
// declares its own filters, folded under 「筛选」. Everything the person chose
// lives in the URL query, so a filtered list can be reloaded, shared and
// returned to; a default value stays out of the URL.
const WORKBENCH_LISTS = ['running', 'done', 'notices'] as const
export type WorkbenchList = typeof WORKBENCH_LISTS[number]

/**
 * One filter a list declares. `key` names it in the URL and in the state.
 * `options` are its fixed values, or the projects or FLAs the page fills in.
 * `fallback` is what the list opens with; empty means it does not narrow.
 */
export interface ListFilter {
  key: string
  multiple: boolean
  options: readonly string[] | 'projects' | 'flas'
  fallback: readonly string[]
}

const DONE_STATUSES = ['completed', 'cancelled'] satisfies ProjectAgentTaskStatus[]
// 最近你可能需要知道的事 splits into what asks the person to act and what only lets them know.
const NOTICE_NEEDS: Record<string, readonly string[]> = {
  act: ['topic_promoted', 'dreaming_found', 'dreaming_stopped', 'retrospective_ready', 'model_failing', 'update_available'],
  info: ['tonborg_confirmed', 'fla_joined', 'fla_left', 'delegated_change'],
}
const QUIET_DAYS: Record<string, number> = { '1d': 1, '3d': 3, '7d': 7 }
const HOUR_S = 60 * 60
const DAY_S = 24 * HOUR_S
// How long a finished task took, from creation to completion, in seconds: [at least, under].
const TOOK: Record<string, [number | null, number | null]> = { '1h': [null, HOUR_S], '1d': [HOUR_S, DAY_S], longer: [DAY_S, null] }

const PEOPLE: readonly ListFilter[] = [
  { key: 'fla', multiple: true, options: 'flas', fallback: [] },
  { key: 'project', multiple: true, options: 'projects', fallback: [] },
]
export const LIST_FILTERS: Record<WorkbenchList, readonly ListFilter[]> = {
  running: [
    { key: 'status', multiple: true, options: [...CURRENT_WORK_STATUSES], fallback: [] },
    ...PEOPLE,
    { key: 'quiet', multiple: false, options: Object.keys(QUIET_DAYS), fallback: [] },
  ],
  done: [
    // 最近完成 opens on what was finished; a cancelled task is one filter away.
    { key: 'status', multiple: true, options: DONE_STATUSES, fallback: ['completed'] },
    ...PEOPLE,
    { key: 'result', multiple: false, options: ['with', 'without'], fallback: [] },
    { key: 'took', multiple: false, options: Object.keys(TOOK), fallback: [] },
  ],
  notices: [
    { key: 'need', multiple: false, options: Object.keys(NOTICE_NEEDS), fallback: [] },
    { key: 'kind', multiple: true, options: NOTICE_KINDS, fallback: [] },
    { key: 'project', multiple: true, options: 'projects', fallback: [] },
  ],
}

// Notices are kept for 90 days at most (src/notices/recent-notices.js).
type ListRange = 'all' | '7d' | '14d' | '30d' | '90d'
export const LIST_RANGES: Record<WorkbenchList, readonly ListRange[]> = {
  running: ['all', '7d', '30d', '90d'],
  done: ['all', '7d', '30d', '90d'],
  notices: ['14d', '7d', '30d', '90d'],
}
export const LIST_SORTS = ['newest', 'oldest'] as const
type ListSort = typeof LIST_SORTS[number]

export interface ListQuery {
  text: string
  range: ListRange
  sort: ListSort
  /** Each declared filter's values; a single-choice filter has at most one. */
  filters: Record<string, string[]>
}

export const isWorkbenchList = (value: unknown): value is WorkbenchList => WORKBENCH_LISTS.includes(value as WorkbenchList)

export function defaultListQuery(list: WorkbenchList): ListQuery {
  return { text: '', range: LIST_RANGES[list][0], sort: 'newest',
    filters: Object.fromEntries(LIST_FILTERS[list].map(filter => [filter.key, [...filter.fallback]])) }
}

const values = (value: LocationQuery[string] | undefined) => (Array.isArray(value) ? value : [value])
  .filter((item): item is string => typeof item === 'string' && item.trim() !== '')
const one = (value: LocationQuery[string] | undefined) => values(value)[0] ?? ''

/** The list's query as the URL says it; anything the list does not know falls back to its default. */
export function readListQuery(list: WorkbenchList, query: LocationQuery): ListQuery {
  const fallback = defaultListQuery(list)
  const range = one(query.range) as ListRange
  const sort = one(query.sort) as ListSort
  const filters: Record<string, string[]> = {}
  for (const filter of LIST_FILTERS[list]) {
    if (query[filter.key] === undefined) { filters[filter.key] = [...filter.fallback]; continue }
    const known = [...new Set(values(query[filter.key]))]
      .filter(value => typeof filter.options === 'string' || filter.options.includes(value))
    filters[filter.key] = filter.multiple ? known : known.slice(0, 1)
  }
  return {
    text: one(query.q).trim(),
    range: LIST_RANGES[list].includes(range) ? range : fallback.range,
    sort: LIST_SORTS.includes(sort) ? sort : fallback.sort,
    filters,
  }
}

/** The URL query for a list's state, defaults left out. */
export function writeListQuery(list: WorkbenchList, state: ListQuery): LocationQueryRaw {
  const fallback = defaultListQuery(list)
  const query: LocationQueryRaw = {}
  if (state.text.trim()) query.q = state.text.trim()
  if (state.range !== fallback.range) query.range = state.range
  for (const filter of LIST_FILTERS[list]) {
    const chosen = state.filters[filter.key] ?? []
    // An emptied filter differs from a default that narrows (最近完成's status), so it is written as one empty value.
    if (!sameSet(chosen, filter.fallback)) query[filter.key] = chosen.length ? [...chosen] : ''
  }
  if (state.sort !== fallback.sort) query.sort = state.sort
  return query
}

/** How many of the list's own filters differ from what it opens with: the count on 「筛选」. */
export function activeFilterCount(list: WorkbenchList, state: ListQuery) {
  return LIST_FILTERS[list].filter(filter => !sameSet(state.filters[filter.key] ?? [], filter.fallback)).length
}

/** Whether the person narrowed the list beyond what it opens with; a changed order does not narrow it. */
export function isFiltered(list: WorkbenchList, state: ListQuery) {
  return Boolean(state.text) || state.range !== LIST_RANGES[list][0] || activeFilterCount(list, state) > 0
}

const MS = 1000
const rangeDays = (range: ListRange) => (range === 'all' ? null : Number.parseInt(range, 10))
const daysAgo = (days: number, now: number) => new Date(now - days * DAY_S * MS).toISOString()

/** The request for one page of the list: its path and its query, without the cursor. */
export function listPageRequest(list: WorkbenchList, state: ListQuery, spaceId: string, now: number) {
  const chosen = (key: string) => state.filters[key] ?? []
  const params = new URLSearchParams()
  const days = rangeDays(state.range)
  if (list === 'notices') {
    params.set('days', String(days ?? 90))
    params.set('sort', state.sort)
    for (const kind of noticeKinds(chosen('kind'), chosen('need')[0])) params.append('kind', kind)
    for (const project of chosen('project')) params.append('project', project)
    if (state.text) params.set('q', state.text)
    return { path: '/api/notices', params }
  }
  params.set('personalSpaceId', spaceId)
  const statuses = chosen('status').length ? chosen('status') : list === 'running' ? [...CURRENT_WORK_STATUSES] : DONE_STATUSES
  for (const status of statuses) params.append('status', status)
  for (const project of chosen('project')) params.append('project', project)
  for (const fla of chosen('fla')) params.append('agent', fla)
  if (state.text) params.set('q', state.text)
  if (list === 'running') {
    // 进行中: the range is when the work started; quiet is how long nothing has changed.
    if (days) params.set('startedSince', daysAgo(days, now))
    const quiet = QUIET_DAYS[chosen('quiet')[0] ?? '']
    if (quiet) params.set('changedBefore', daysAgo(quiet, now))
    params.set('order', 'updated')
  } else {
    // 最近完成: the range is when it finished.
    if (days) params.set('since', daysAgo(days, now))
    const result = chosen('result')[0]
    if (result) params.set('hasResult', String(result === 'with'))
    const [least, most] = TOOK[chosen('took')[0] ?? ''] ?? [null, null]
    if (least) params.set('tookAtLeast', String(least))
    if (most) params.set('tookAtMost', String(most))
    params.set('order', 'completed')
  }
  params.set('sort', state.sort)
  return { path: '/api/project-agent-task-pages', params }
}

// The kinds asked for, within the 要你动手 / 只是知会 group when one is chosen.
// Nothing in both asks for a kind no notice has, so the list says nothing matches.
const NO_KIND = 'none'
function noticeKinds(kinds: readonly string[], need: string | undefined) {
  const group = need ? NOTICE_NEEDS[need] : null
  if (!group) return kinds
  const within = (kinds.length ? kinds : group).filter(kind => group.includes(kind))
  return within.length ? within : [NO_KIND]
}

function sameSet(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every(item => right.includes(item))
}
