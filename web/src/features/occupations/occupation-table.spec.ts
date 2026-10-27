import { describe, expect, it } from 'vitest'
import type { OccupationEntry } from './occupation-catalog'
import {
  DEFAULT_OCCUPATION_SORT, nextOccupationSort, occupationCounts, visibleOccupations, type OccupationSort,
} from './occupation-table'

const entry = (key: string, extra: Partial<OccupationEntry> = {}): OccupationEntry => ({
  key, name_zh: key, name_en: key, description_zh: `${key} 的职责说明`, description_en: `${key} duties`,
  builtin: true, status: 'active', revision: 0, agent_count: 0,
  created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', ...extra,
})
const catalog = [
  entry('b-writing', { agent_count: 2, updated_at: '2026-10-03T00:00:00Z' }),
  entry('a-design', { agent_count: 5 }),
  entry('c-legacy', { status: 'archived', agent_count: 1, updated_at: '2026-10-09T00:00:00Z' }),
  entry('d-custom', { builtin: false, description_zh: '维护合成数据的说明' }),
]
const keys = (sort: OccupationSort, filter: Parameters<typeof visibleOccupations>[1]['filter'] = 'all', query = '') =>
  visibleOccupations(catalog, { filter, query, sort }).map(item => item.key)

describe('occupation table', () => {
  it('shows only active occupations by default and archived ones on their own filter', () => {
    expect(keys(DEFAULT_OCCUPATION_SORT, 'active')).toEqual(['a-design', 'b-writing', 'd-custom'])
    expect(keys(DEFAULT_OCCUPATION_SORT, 'archived')).toEqual(['c-legacy'])
    expect(keys(DEFAULT_OCCUPATION_SORT, 'custom')).toEqual(['d-custom'])
    expect(occupationCounts(catalog)).toEqual({ active: 3, archived: 1, custom: 1, all: 4 })
  })

  it('sorts by each column, flipping on a second click', () => {
    expect(keys({ key: 'agents', direction: 'desc' })).toEqual(['a-design', 'b-writing', 'c-legacy', 'd-custom'])
    expect(keys({ key: 'updated', direction: 'desc' })[0]).toBe('c-legacy')
    expect(keys({ key: 'status', direction: 'desc' })[0]).toBe('c-legacy')
    expect(keys({ key: 'name', direction: 'desc' })).toEqual(['d-custom', 'c-legacy', 'b-writing', 'a-design'])
    expect(nextOccupationSort(DEFAULT_OCCUPATION_SORT, 'name')).toEqual({ key: 'name', direction: 'desc' })
    expect(nextOccupationSort(DEFAULT_OCCUPATION_SORT, 'agents')).toEqual({ key: 'agents', direction: 'desc' })
    expect(nextOccupationSort(DEFAULT_OCCUPATION_SORT, 'description')).toEqual({ key: 'description', direction: 'asc' })
  })

  it('searches names and duties in both languages', () => {
    expect(keys(DEFAULT_OCCUPATION_SORT, 'all', '合成数据')).toEqual(['d-custom'])
    expect(keys(DEFAULT_OCCUPATION_SORT, 'all', 'WRITING DUTIES')).toEqual(['b-writing'])
  })
})
