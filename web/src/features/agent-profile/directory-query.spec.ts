import { describe, expect, it } from 'vitest'
import { directoryFilterQuery, readDirectoryFilters, sameDirectoryFilters } from './directory-query'

describe('directory filter query', () => {
  it('reads one or many projects and rejects unknown statuses', () => {
    expect(readDirectoryFilters({ q: 'aster', project: ['p-1', 'p-2', 'p-1'], status: 'inactive' }))
      .toEqual({ search: 'aster', projects: ['p-1', 'p-2'], status: 'inactive', view: 'agents', sort: 'recent' })
    expect(readDirectoryFilters({ project: 'p-1', status: 'running', view: 'grid' }))
      .toEqual({ search: '', projects: ['p-1'], status: 'all', view: 'agents', sort: 'recent' })
    expect(readDirectoryFilters({ q: [null, ''] })).toEqual({ search: '', projects: [], status: 'all', view: 'agents', sort: 'recent' })
    expect(readDirectoryFilters({ view: 'projects' }).view).toBe('projects')
    expect(readDirectoryFilters({ sort: 'name' }).sort).toBe('name')
    expect(readDirectoryFilters({ sort: 'size' }).sort).toBe('recent')
  })

  it('writes only non-default filters and keeps unrelated query keys', () => {
    expect(directoryFilterQuery(
      { q: 'old', status: 'archived', task: 'task-1' },
      { search: '  birch ', projects: ['p-2'], status: 'all', view: 'projects', sort: 'name' },
    )).toEqual({ task: 'task-1', q: 'birch', project: ['p-2'], view: 'projects', sort: 'name' })
    expect(directoryFilterQuery({ project: 'p-1', view: 'projects', sort: 'name' }, { search: ' ', projects: [], status: 'all', view: 'agents', sort: 'recent' })).toEqual({})
  })

  it('compares filters as the URL would store them', () => {
    expect(sameDirectoryFilters(
      { search: 'aster ', projects: ['p-1'], status: 'all', view: 'agents', sort: 'recent' },
      { search: 'aster', projects: ['p-1'], status: 'all', view: 'agents', sort: 'recent' },
    )).toBe(true)
    expect(sameDirectoryFilters(
      { search: '', projects: ['p-1', 'p-2'], status: 'all', view: 'agents', sort: 'recent' },
      { search: '', projects: ['p-2', 'p-1'], status: 'all', view: 'agents', sort: 'recent' },
    )).toBe(false)
    expect(sameDirectoryFilters(
      { search: '', projects: [], status: 'all', view: 'agents', sort: 'recent' },
      { search: '', projects: [], status: 'all', view: 'agents', sort: 'name' },
    )).toBe(false)
  })
})
