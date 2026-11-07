import { describe, expect, it } from 'vitest'
import { activeFilterCount, defaultListQuery, isFiltered, listPageRequest, readListQuery, writeListQuery } from './list-query'

const NOW = Date.parse('2026-11-06T12:00:00.000Z')
const request = (list: 'running' | 'done' | 'notices', query: Record<string, string | string[]>) =>
  listPageRequest(list, readListQuery(list, query), 'space-a', NOW)

describe('workbench list query', () => {
  it('keeps defaults out of the URL and reads back what it wrote', () => {
    expect(writeListQuery('running', defaultListQuery('running'))).toEqual({})
    const state = { text: 'needle', range: '30d' as const, sort: 'oldest' as const,
      filters: { status: ['blocked'], fla: ['ada', 'bo'], project: ['project-a'], quiet: ['3d'] } }
    const query = writeListQuery('running', state)
    expect(query).toEqual({ q: 'needle', range: '30d', status: ['blocked'], fla: ['ada', 'bo'], project: ['project-a'], quiet: ['3d'], sort: 'oldest' })
    expect(readListQuery('running', query as never)).toEqual(state)
  })

  it('opens 最近完成 on finished work and keeps an emptied status filter apart from it', () => {
    expect(readListQuery('done', {}).filters.status).toEqual(['completed'])
    const all = writeListQuery('done', { ...defaultListQuery('done'), filters: { ...defaultListQuery('done').filters, status: [] } })
    expect(all).toEqual({ status: '' })
    expect(readListQuery('done', all as never).filters.status).toEqual([])
    expect(isFiltered('done', defaultListQuery('done'))).toBe(false)
    expect(isFiltered('done', readListQuery('done', all as never))).toBe(true)
    // A changed order neither narrows the list nor counts on 筛选.
    const oldest = { ...defaultListQuery('done'), sort: 'oldest' as const }
    expect(activeFilterCount('done', oldest)).toBe(0)
    expect(isFiltered('done', oldest)).toBe(false)
  })

  it('reads only the filters a list declares, and only values it knows', () => {
    const notices = readListQuery('notices', { range: 'all', sort: 'sideways', kind: ['fla_joined', 'running'], quiet: '1d', need: ['act', 'info'], q: '  ' })
    expect(notices).toEqual({ ...defaultListQuery('notices'), filters: { need: ['act'], kind: ['fla_joined'], project: [] } })
    expect(readListQuery('running', { status: ['fla_joined'], took: '1h' }).filters).toEqual({ status: [], fla: [], project: [], quiet: [] })
    expect(activeFilterCount('notices', notices)).toBe(2)
  })

  it('asks 进行中 for work started in the range and quiet as long as chosen', () => {
    const { path, params } = request('running', { range: '7d', quiet: '3d', fla: 'ada' })
    expect(path).toBe('/api/project-agent-task-pages')
    expect(params.getAll('status')).toEqual(['awaiting_recruitment', 'queued', 'running', 'paused', 'awaiting_review', 'blocked', 'failed'])
    expect(params.get('startedSince')).toBe('2026-10-30T12:00:00.000Z')
    expect(params.get('changedBefore')).toBe('2026-11-03T12:00:00.000Z')
    expect(params.has('since')).toBe(false)
    expect(params.getAll('agent')).toEqual(['ada'])
    expect(params.get('order')).toBe('updated')
  })

  it('asks 最近完成 for its finish window, result note and time taken', () => {
    const { params } = request('done', { range: '30d', result: 'without', took: '1d', q: 'needle' })
    expect(params.getAll('status')).toEqual(['completed'])
    expect(params.get('since')).toBe('2026-10-07T12:00:00.000Z')
    expect(params.get('hasResult')).toBe('false')
    expect([params.get('tookAtLeast'), params.get('tookAtMost')]).toEqual(['3600', '86400'])
    expect(params.get('order')).toBe('completed')
    expect(params.get('q')).toBe('needle')
    expect(request('done', { took: 'longer' }).params.has('tookAtMost')).toBe(false)
  })

  it('asks the notices for its window and the kinds within 要你动手 or 只是知会', () => {
    const { path, params } = request('notices', { range: '90d', need: 'info', project: 'garden', sort: 'oldest' })
    expect(path).toBe('/api/notices')
    expect(params.get('days')).toBe('90')
    expect(params.getAll('kind')).toEqual(['tonborg_confirmed', 'fla_joined', 'fla_left', 'delegated_change'])
    expect(params.getAll('project')).toEqual(['garden'])
    expect(request('notices', { need: 'act', kind: ['fla_joined', 'model_failing'] }).params.getAll('kind')).toEqual(['model_failing'])
    // Nothing in both: a kind no notice has, so nothing matches.
    expect(request('notices', { need: 'act', kind: 'fla_joined' }).params.getAll('kind')).toEqual(['none'])
    expect(request('notices', {}).params.get('days')).toBe('14')
  })
})
