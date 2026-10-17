import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

import { useAgentRecords } from './useAgentRecords'

const { getJson, ApiError } = vi.hoisted(() => {
  class ApiError extends Error {
    constructor(message: string, readonly status: number) { super(message) }
  }
  return { getJson: vi.fn(), ApiError }
})
vi.mock('@/api/client', () => ({ getJson, ApiError }))

const agent = (agentId: string) => ({
  agentId, personalSpaceId: 'space-a',
  profile: { name: agentId, responsibility: '', capabilities: [], initialPreferences: [], status: 'active' },
})

beforeEach(() => { getJson.mockReset() })

describe('useAgentRecords', () => {
  it('reads each new pin once and leaves out a pin whose Agent is gone', async () => {
    getJson.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/project-agents/gone?')) throw new ApiError('not found', 404)
      return agent(decodeURIComponent(url.split('/')[3]!.split('?')[0]!))
    })
    const pins = ref(['aster', 'gone'])
    const pinned = useAgentRecords(ref('space-a'), pins)
    await flushPromises()

    expect(Object.keys(pinned.records.value)).toEqual(['aster'])
    expect(pinned.error.value).toBe('')

    pins.value = ['aster', 'gone', 'birch']
    await flushPromises()
    expect(getJson.mock.calls.map(([url]) => url)).toEqual([
      '/api/project-agents/aster?personalSpaceId=space-a',
      '/api/project-agents/gone?personalSpaceId=space-a',
      '/api/project-agents/birch?personalSpaceId=space-a',
    ])
    expect(Object.keys(pinned.records.value).sort()).toEqual(['aster', 'birch'])
  })

  it('reports a failed read instead of treating the pin as gone', async () => {
    getJson.mockRejectedValueOnce(new ApiError('Synthetic outage', 503))
    const pinned = useAgentRecords(ref('space-a'), ref(['aster']))
    await flushPromises()
    expect(pinned.error.value).toBe('Synthetic outage')

    getJson.mockResolvedValueOnce(agent('aster'))
    await pinned.load({ force: true })
    expect(pinned.error.value).toBe('')
    expect(Object.keys(pinned.records.value)).toEqual(['aster'])
  })

  it('reads a few Agents at a time and ignores a record from another space', async () => {
    let inFlight = 0
    let peak = 0
    getJson.mockImplementation(async (url: string) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await Promise.resolve()
      inFlight -= 1
      const id = decodeURIComponent(url.split('/')[3]!.split('?')[0]!)
      return id === 'foreign' ? { ...agent(id), personalSpaceId: 'space-b' } : agent(id)
    })
    const many = Array.from({ length: 9 }, (_, index) => `agent-${index}`)
    const records = useAgentRecords(ref('space-a'), ref([...many, 'foreign']))
    await flushPromises()

    expect(peak).toBeLessThanOrEqual(6)
    expect(Object.keys(records.records.value).sort()).toEqual([...many].sort())
  })
})
