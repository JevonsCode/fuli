import { flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useAgentPins } from './agent-pins'

const { getJson, putJson } = vi.hoisted(() => ({
  getJson: vi.fn(),
  putJson: vi.fn(),
}))

vi.mock('@/api/client', () => ({ getJson, putJson }))
vi.mock('@/i18n', () => ({
  t: (key: string) => key,
  i18n: { global: { te: () => false } },
}))

describe('useAgentPins', () => {
  beforeEach(() => {
    getJson.mockReset()
    putJson.mockReset()
  })

  it('loads only the active space and keeps an explicit empty response empty', async () => {
    getJson
      .mockResolvedValueOnce({ revision: 4, agentIds: [] })
      .mockResolvedValueOnce({ revision: 8, agentIds: ['employee.jefa'] })
    const space = ref('space-isolation')
    const pins = useAgentPins(space)
    await flushPromises()

    expect(getJson).toHaveBeenCalledWith('/api/agent-pins?personalSpaceId=space-isolation')
    expect(pins.agentIds.value).toEqual([])

    space.value = 'space-b'
    await flushPromises()
    expect(pins.agentIds.value).toEqual(['employee.jefa'])

    space.value = 'space-isolation'
    await flushPromises()
    expect(pins.agentIds.value).toEqual([])
    expect(getJson).toHaveBeenCalledTimes(2)
  })

  it('writes the current revision and adopts the server response', async () => {
    getJson.mockResolvedValueOnce({ revision: 2, agentIds: ['employee.bole'] })
    putJson.mockResolvedValueOnce({ revision: 3, agentIds: ['employee.bole', 'employee.tonborg'] })
    const space = ref('space-write')
    const pins = useAgentPins(space)
    await flushPromises()

    await expect(pins.setPinned('employee.tonborg', true)).resolves.toBe(true)
    expect(putJson).toHaveBeenCalledWith('/api/agent-pins', {
      personalSpaceId: 'space-write',
      agentId: 'employee.tonborg',
      pinned: true,
      expectedRevision: 2,
    })
    expect(pins.agentIds.value).toEqual(['employee.bole', 'employee.tonborg'])
    expect(pins.revision.value).toBe(3)
  })

  it('refreshes after a stale revision and reports the conflict', async () => {
    getJson
      .mockResolvedValueOnce({ revision: 2, agentIds: ['employee.bole'] })
      .mockResolvedValueOnce({ revision: 6, agentIds: [] })
    putJson.mockRejectedValueOnce({ status: 409 })
    const space = ref('space-stale')
    const pins = useAgentPins(space)
    await flushPromises()

    await expect(pins.setPinned('employee.bole', false)).resolves.toBe(false)
    expect(getJson).toHaveBeenLastCalledWith('/api/agent-pins?personalSpaceId=space-stale')
    expect(pins.agentIds.value).toEqual([])
    expect(pins.error.value).toBe('The pin list changed. Try again.')
  })

  it('does not request the pins endpoint before a real space exists', async () => {
    const space = ref('')
    const pins = useAgentPins(space)
    await flushPromises()

    expect(getJson).not.toHaveBeenCalled()
    expect(pins.agentIds.value).toEqual([])
    expect(pins.revision.value).toBeNull()
  })
})
