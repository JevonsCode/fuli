import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

import { forgetLoadedRosters, useAgentRosterPages } from './useAgentRosterPages'

const { getJson } = vi.hoisted(() => ({ getJson: vi.fn() }))
vi.mock('@/api/client', () => ({ getJson }))

const agent = (id: string, personalSpaceId = 'space-a') => ({
  agentId: id, personalSpaceId,
  profile: { name: id, responsibility: '', capabilities: [], initialPreferences: [], status: 'active' },
})
const page = (ids: string[], nextCursor: string | null) => ({
  items: ids.map(id => agent(id)), nextCursor, complete: nextCursor === null,
})
const ids = (agents: Array<{ agentId: string }>) => agents.map(item => item.agentId)

beforeEach(() => {
  forgetLoadedRosters()
  getJson.mockReset()
})

describe('useAgentRosterPages', () => {
  it('reads open work first, then the roster a page at a time without repeating anyone', async () => {
    getJson.mockImplementation(async (url: string) => {
      const query = new URL(url, 'http://local').searchParams
      if (query.get('work') === 'open') return page(['busy'], null)
      if (!query.get('cursor')) return page(['aster', 'busy'], 'c1')
      if (query.get('cursor') === 'c1') return page(['birch'], null)
      throw new Error(url)
    })
    const roster = useAgentRosterPages(ref('space-a'), ref('all'))
    await flushPromises()

    expect(getJson.mock.calls.map(([url]) => url)).toEqual([
      '/api/project-agent-pages?personalSpaceId=space-a&limit=50&work=open',
      '/api/project-agent-pages?personalSpaceId=space-a&limit=50',
    ])
    expect(ids(roster.agents.value)).toEqual(['busy', 'aster'])
    expect(roster.complete.value).toBe(false)

    await roster.loadMore()
    expect(getJson).toHaveBeenLastCalledWith('/api/project-agent-pages?personalSpaceId=space-a&limit=50&cursor=c1')
    expect(ids(roster.agents.value)).toEqual(['busy', 'aster', 'birch'])
    expect(roster.complete.value).toBe(true)

    await roster.loadMore()
    expect(getJson).toHaveBeenCalledTimes(3)
  })

  it('asks the server for one status and never keeps another space’s rows', async () => {
    getJson.mockImplementation(async (url: string) => ({
      items: [agent('mine'), agent('foreign', 'space-b')], nextCursor: null, complete: true,
    }))
    const roster = useAgentRosterPages(ref('space-a'), ref('archived'))
    await flushPromises()

    expect(getJson.mock.calls[0]![0]).toBe('/api/project-agent-pages?personalSpaceId=space-a&limit=50&status=archived&work=open')
    expect(ids(roster.agents.value)).toEqual(['mine'])
  })

  it('keeps loaded rows when a later page fails and resumes from the same cursor', async () => {
    let fail = true
    getJson.mockImplementation(async (url: string) => {
      const query = new URL(url, 'http://local').searchParams
      if (query.get('work') === 'open') return page([], null)
      if (!query.get('cursor')) return page(['aster'], 'c1')
      if (fail) throw new Error('Synthetic outage')
      return page(['birch'], null)
    })
    const roster = useAgentRosterPages(ref('space-a'), ref('all'))
    await flushPromises()
    await roster.loadMore()

    expect(roster.error.value).toBe('Synthetic outage')
    expect(ids(roster.agents.value)).toEqual(['aster'])
    expect(roster.complete.value).toBe(false)

    fail = false
    await roster.loadMore()
    expect(getJson).toHaveBeenLastCalledWith('/api/project-agent-pages?personalSpaceId=space-a&limit=50&cursor=c1')
    expect(roster.error.value).toBe('')
    expect(ids(roster.agents.value)).toEqual(['aster', 'birch'])
  })

  it('does not call a page without a cursor or an end the whole roster', async () => {
    getJson.mockResolvedValue({ items: [agent('aster')], nextCursor: null, complete: false })
    const roster = useAgentRosterPages(ref('space-a'), ref('all'))
    await flushPromises()

    expect(roster.complete.value).toBe(false)
    expect(roster.error.value).not.toBe('')
  })

  it('returns to the pages already read and drops them only on reload', async () => {
    getJson.mockImplementation(async (url: string) => {
      const query = new URL(url, 'http://local').searchParams
      if (query.get('work') === 'open') return page([], null)
      return query.get('cursor') ? page(['birch'], null) : page(['aster'], 'c1')
    })
    const first = useAgentRosterPages(ref('space-a'), ref('all'))
    await flushPromises()
    await first.loadMore()
    getJson.mockClear()

    const back = useAgentRosterPages(ref('space-a'), ref('all'))
    await flushPromises()
    expect(getJson).not.toHaveBeenCalled()
    expect(ids(back.agents.value)).toEqual(['aster', 'birch'])
    expect(back.complete.value).toBe(true)

    await back.reload()
    await flushPromises()
    expect(getJson).toHaveBeenCalledTimes(2)
    expect(ids(back.agents.value)).toEqual(['aster'])
  })
})
