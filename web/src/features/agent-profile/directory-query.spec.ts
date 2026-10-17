import { describe, expect, it } from 'vitest'
import { directoryFilterQuery, readDirectoryFilters, sameDirectoryFilters } from './directory-query'

describe('directory filter query', () => {
  it('reads one or many projects and rejects unknown statuses', () => {
    expect(readDirectoryFilters({ q: 'aster', project: ['p-1', 'p-2', 'p-1'], status: 'inactive' }))
      .toEqual({ search: 'aster', projects: ['p-1', 'p-2'], status: 'inactive' })
    expect(readDirectoryFilters({ project: 'p-1', status: 'running' }))
      .toEqual({ search: '', projects: ['p-1'], status: 'all' })
    expect(readDirectoryFilters({ q: [null, ''] })).toEqual({ search: '', projects: [], status: 'all' })
  })

  it('writes only non-default filters and keeps unrelated query keys', () => {
    expect(directoryFilterQuery(
      { q: 'old', status: 'archived', task: 'task-1' },
      { search: '  birch ', projects: ['p-2'], status: 'all' },
    )).toEqual({ task: 'task-1', q: 'birch', project: ['p-2'] })
    expect(directoryFilterQuery({ project: 'p-1' }, { search: ' ', projects: [], status: 'all' })).toEqual({})
  })

  it('compares filters as the URL would store them', () => {
    expect(sameDirectoryFilters(
      { search: 'aster ', projects: ['p-1'], status: 'all' },
      { search: 'aster', projects: ['p-1'], status: 'all' },
    )).toBe(true)
    expect(sameDirectoryFilters(
      { search: '', projects: ['p-1', 'p-2'], status: 'all' },
      { search: '', projects: ['p-2', 'p-1'], status: 'all' },
    )).toBe(false)
  })
})
