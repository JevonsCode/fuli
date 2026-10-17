import { describe, expect, it } from 'vitest'
import { directoryFilterQuery, readDirectoryFilters, sameDirectoryFilters } from './directory-query'

describe('directory filter query', () => {
  it('reads one or many projects and rejects unknown statuses', () => {
    expect(readDirectoryFilters({ q: 'aster', project: ['p-1', 'p-2', 'p-1'], status: 'inactive' }))
      .toEqual({ search: 'aster', projects: ['p-1', 'p-2'], status: 'inactive', view: 'agents' })
    expect(readDirectoryFilters({ project: 'p-1', status: 'running', view: 'grid' }))
      .toEqual({ search: '', projects: ['p-1'], status: 'all', view: 'agents' })
    expect(readDirectoryFilters({ q: [null, ''] })).toEqual({ search: '', projects: [], status: 'all', view: 'agents' })
    expect(readDirectoryFilters({ view: 'projects' }).view).toBe('projects')
  })

  it('writes only non-default filters and keeps unrelated query keys', () => {
    expect(directoryFilterQuery(
      { q: 'old', status: 'archived', task: 'task-1' },
      { search: '  birch ', projects: ['p-2'], status: 'all', view: 'projects' },
    )).toEqual({ task: 'task-1', q: 'birch', project: ['p-2'], view: 'projects' })
    expect(directoryFilterQuery({ project: 'p-1', view: 'projects' }, { search: ' ', projects: [], status: 'all', view: 'agents' })).toEqual({})
  })

  it('compares filters as the URL would store them', () => {
    expect(sameDirectoryFilters(
      { search: 'aster ', projects: ['p-1'], status: 'all', view: 'agents' },
      { search: 'aster', projects: ['p-1'], status: 'all', view: 'agents' },
    )).toBe(true)
    expect(sameDirectoryFilters(
      { search: '', projects: ['p-1', 'p-2'], status: 'all', view: 'agents' },
      { search: '', projects: ['p-2', 'p-1'], status: 'all', view: 'agents' },
    )).toBe(false)
  })
})
