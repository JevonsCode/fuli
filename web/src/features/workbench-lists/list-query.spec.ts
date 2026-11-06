import { describe, expect, it } from 'vitest'
import { activeFilterCount, defaultListQuery, isFiltered, noticePageParams, readListQuery, taskPageParams, writeListQuery } from './list-query'

const NOW = Date.parse('2026-11-06T12:00:00.000Z')

describe('workbench list query', () => {
  it('keeps defaults out of the URL and reads back what it wrote', () => {
    expect(writeListQuery('running', defaultListQuery('running'))).toEqual({})
    const state = { text: 'needle', range: '30d' as const, projects: ['project-a'], flas: ['ada', 'bo'], kinds: ['blocked'], sort: 'oldest' as const }
    const query = writeListQuery('running', state)
    expect(query).toEqual({ q: 'needle', range: '30d', project: ['project-a'], fla: ['ada', 'bo'], kind: ['blocked'], sort: 'oldest' })
    expect(readListQuery('running', query as never)).toEqual(state)
  })

  it('opens 最近完成 on finished work and keeps an emptied status filter apart from it', () => {
    expect(readListQuery('done', {}).kinds).toEqual(['completed'])
    const all = writeListQuery('done', { ...defaultListQuery('done'), kinds: [] })
    expect(all).toEqual({ kind: '' })
    expect(readListQuery('done', all as never).kinds).toEqual([])
    expect(isFiltered('done', defaultListQuery('done'))).toBe(false)
    expect(isFiltered('done', readListQuery('done', all as never))).toBe(true)
    // A changed order counts on the 筛选 button but does not narrow the list.
    const oldest = { ...defaultListQuery('done'), sort: 'oldest' as const }
    expect(activeFilterCount('done', oldest)).toBe(1)
    expect(isFiltered('done', oldest)).toBe(false)
  })

  it('drops what a list does not know instead of sending it on', () => {
    const state = readListQuery('notices', { range: 'all', sort: 'sideways', kind: ['fla_joined', 'running'], q: '  ' })
    expect(state).toEqual({ ...defaultListQuery('notices'), kinds: ['fla_joined'] })
    expect(readListQuery('running', { kind: ['fla_joined'] }).kinds).toEqual([])
  })

  it('asks the task pages for every status the list holds when none is picked, and its own time order', () => {
    const running = taskPageParams('running', { ...defaultListQuery('running'), range: '7d', flas: ['ada'] }, 'space-a', NOW)
    expect(running.getAll('status')).toEqual(['awaiting_recruitment', 'queued', 'running', 'paused', 'awaiting_review', 'blocked', 'failed'])
    expect(running.get('since')).toBe('2026-10-30T12:00:00.000Z')
    expect(running.getAll('agent')).toEqual(['ada'])
    expect(running.get('order')).toBe('updated')
    const done = taskPageParams('done', { ...defaultListQuery('done'), text: 'needle' }, 'space-a', NOW)
    expect(done.getAll('status')).toEqual(['completed'])
    expect(done.get('order')).toBe('completed')
    expect(done.get('q')).toBe('needle')
    expect(done.has('since')).toBe(false)
  })

  it('asks the notices for its window, kinds and filters', () => {
    const params = noticePageParams({ ...defaultListQuery('notices'), range: '90d', kinds: ['fla_left'], projects: ['garden'], sort: 'oldest' })
    expect(Object.fromEntries(params)).toEqual({ days: '90', sort: 'oldest', kind: 'fla_left', project: 'garden' })
    expect(noticePageParams(defaultListQuery('notices')).get('days')).toBe('14')
  })
})
