import { currentLocale } from '@/i18n'
import { occupationDescription, occupationName, type OccupationEntry } from './occupation-catalog'

// The 职业 table: which rows show (status filter and search) and in what
// order (one sortable column at a time). Active occupations show by default;
// archived ones stay in the catalog and come back with their filter.
export const OCCUPATION_FILTERS = ['active', 'archived', 'custom', 'all'] as const
export type OccupationFilter = (typeof OCCUPATION_FILTERS)[number]
export const OCCUPATION_SORT_KEYS = ['name', 'description', 'agents', 'status', 'updated'] as const
export type OccupationSortKey = (typeof OCCUPATION_SORT_KEYS)[number]
export interface OccupationSort { key: OccupationSortKey; direction: 'asc' | 'desc' }
export const DEFAULT_OCCUPATION_SORT: OccupationSort = { key: 'name', direction: 'asc' }

// Counts and dates read best largest and newest first; text reads A to Z.
const FIRST_DIRECTION: Record<OccupationSortKey, OccupationSort['direction']> = {
  name: 'asc', description: 'asc', agents: 'desc', status: 'asc', updated: 'desc',
}

export function occupationCounts(entries: readonly OccupationEntry[]): Record<OccupationFilter, number> {
  return {
    active: entries.filter(entry => entry.status === 'active').length,
    archived: entries.filter(entry => entry.status === 'archived').length,
    custom: entries.filter(entry => !entry.builtin).length,
    all: entries.length,
  }
}

const inFilter = (entry: OccupationEntry, filter: OccupationFilter) =>
  filter === 'all' || (filter === 'custom' ? !entry.builtin : entry.status === filter)

/** The sort a header click gives: the same column flips, another starts in its natural direction. */
export function nextOccupationSort(current: OccupationSort, key: OccupationSortKey): OccupationSort {
  if (current.key === key) return { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
  return { key, direction: FIRST_DIRECTION[key] }
}

function compare(a: OccupationEntry, b: OccupationEntry, key: OccupationSortKey, text: Intl.Collator) {
  switch (key) {
    case 'description': return text.compare(occupationDescription(a), occupationDescription(b))
    case 'agents': return a.agent_count - b.agent_count
    // Active before archived.
    case 'status': return Number(a.status === 'archived') - Number(b.status === 'archived')
    case 'updated': return Date.parse(a.updated_at) - Date.parse(b.updated_at)
    default: return text.compare(occupationName(a), occupationName(b))
  }
}

export function visibleOccupations(
  entries: readonly OccupationEntry[],
  view: { filter: OccupationFilter; query: string; sort: OccupationSort },
) {
  const query = view.query.trim().toLowerCase()
  const text = new Intl.Collator(currentLocale())
  const sign = view.sort.direction === 'asc' ? 1 : -1
  return entries
    .filter(entry => inFilter(entry, view.filter) && (!query
      || [entry.name_zh, entry.name_en, entry.description_zh, entry.description_en].some(value => value.toLowerCase().includes(query))))
    // Equal values keep a stable, readable order: by name.
    .sort((a, b) => sign * compare(a, b, view.sort.key, text) || compare(a, b, 'name', text))
}
