import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

import { usePinnedAgentRecords } from './usePinnedAgentRecords'

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

describe('usePinnedAgentRecords', () => {
  it('reads each new pin once and leaves out a pin whose Agent is gone', async () => {
    getJson.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/project-agents/gone?')) throw new ApiError('not found', 404)
      return agent(decodeURIComponent(url.split('/')[3]!.split('?')[0]!))
    })
    const pins = ref(['aster', 'gone'])
    const pinned = usePinnedAgentRecords(ref('space-a'), pins)
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
    const pinned = usePinnedAgentRecords(ref('space-a'), ref(['aster']))
    await flushPromises()
    expect(pinned.error.value).toBe('Synthetic outage')

    getJson.mockResolvedValueOnce(agent('aster'))
    await pinned.load({ force: true })
    expect(pinned.error.value).toBe('')
    expect(Object.keys(pinned.records.value)).toEqual(['aster'])
  })
})
