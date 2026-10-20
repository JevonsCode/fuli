import type { LocationQuery, LocationQueryRaw } from 'vue-router'
import { scheduleState, type TaskSchedule } from './task-schedules'

// The schedules table: filters and sort live in the URL (?q=, ?state=,
// ?sort=), so Back, a refresh or a shared link shows the same rows.
export const SCHEDULE_STATE_FILTERS = ['all', 'enabled', 'paused', 'circuit_open'] as const
type ScheduleStateFilter = typeof SCHEDULE_STATE_FILTERS[number]
export const SCHEDULE_SORTS = ['next', 'name'] as const
type ScheduleSort = typeof SCHEDULE_SORTS[number]

export interface ScheduleTableQuery { search: string; state: ScheduleStateFilter; sort: ScheduleSort }

const QUERY_KEYS = ['q', 'state', 'sort']

function first(value: LocationQuery[string]) {
  const values = Array.isArray(value) ? value : [value]
  return values.find((item): item is string => typeof item === 'string' && item !== '') ?? ''
}

function oneOf<T extends string>(allowed: readonly T[], value: string, fallback: T): T {
  return (allowed as readonly string[]).includes(value) ? value as T : fallback
}

/** Read the table's filters from the URL; unknown values fall back to defaults. */
export function readScheduleTableQuery(query: LocationQuery): ScheduleTableQuery {
  return {
    search: first(query.q),
    state: oneOf(SCHEDULE_STATE_FILTERS, first(query.state), 'all'),
    sort: oneOf(SCHEDULE_SORTS, first(query.sort), 'next'),
  }
}

/** Write the filters into the URL, keeping every unrelated key (the open quick look, for one). */
export function scheduleTableLocationQuery(query: LocationQuery, value: ScheduleTableQuery): LocationQueryRaw {
  const next: LocationQueryRaw = Object.fromEntries(Object.entries(query).filter(([key]) => !QUERY_KEYS.includes(key)))
  if (value.search.trim()) next.q = value.search.trim()
  if (value.state !== 'all') next.state = value.state
  if (value.sort !== 'next') next.sort = value.sort
  return next
}

/** The rows to show: matching name or project, in the chosen state, soonest slot first or by name. */
export function visibleSchedules(schedules: readonly TaskSchedule[], query: ScheduleTableQuery,
  projectName: (id: string) => string, locale: string): TaskSchedule[] {
  const needle = query.search.trim().toLocaleLowerCase(locale)
  const rows = schedules.filter(schedule =>
    (query.state === 'all' || scheduleState(schedule) === query.state)
    && (!needle || `${schedule.body.title} ${projectName(schedule.personalProjectId)}`.toLocaleLowerCase(locale).includes(needle)))
  return query.sort === 'name'
    ? [...rows].sort((a, b) => a.body.title.localeCompare(b.body.title, locale))
    : [...rows].sort((a, b) => (Date.parse(a.nextRunAt) || Infinity) - (Date.parse(b.nextRunAt) || Infinity))
}

// Optional columns. Low-priority ones show by default only when the table has
// room for them; the person's own choice (kept in this browser) always wins.
export const SCHEDULE_COLUMNS = [
  { key: 'project', priority: 'high' },
  { key: 'interval', priority: 'high' },
  { key: 'next', priority: 'high' },
  { key: 'recent', priority: 'high' },
  { key: 'startMode', priority: 'low' },
  { key: 'threshold', priority: 'low' },
] as const
export type ScheduleColumn = typeof SCHEDULE_COLUMNS[number]['key']
/** Below this table width the low-priority columns start hidden. */
const WIDE_TABLE_PX = 1200

export function scheduleColumnVisible(column: ScheduleColumn, tableWidth: number, chosen: Partial<Record<ScheduleColumn, boolean>>) {
  const choice = chosen[column]
  if (typeof choice === 'boolean') return choice
  return SCHEDULE_COLUMNS.find(item => item.key === column)?.priority !== 'low' || tableWidth >= WIDE_TABLE_PX
}
