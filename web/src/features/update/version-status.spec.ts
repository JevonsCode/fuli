import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, ref } from 'vue'
import { useChannelVersionStatus } from './version-status'

const { getJson } = vi.hoisted(() => ({ getJson: vi.fn() }))
vi.mock('@/api/client', () => ({ getJson }))

const answer = (latestVersion: string, updateAvailable: boolean) => ({
  status: 'ready', channel: 'beta', currentVersion: '0.23.0-beta.6', latestVersion, updateAvailable,
  packageUrl: '', checkedAt: '2026-11-03T10:00:00.000Z',
})

function setup() {
  let state!: ReturnType<typeof useChannelVersionStatus>
  mount(defineComponent({ setup() { state = useChannelVersionStatus(ref('beta')); return () => null } }))
  return state
}

describe('useChannelVersionStatus', () => {
  beforeEach(() => getJson.mockReset())

  it('asks for a fresh answer when the page opens and again on 「检查更新」', async () => {
    getJson.mockResolvedValueOnce(answer('0.23.0-beta.6', false))
    const state = setup()
    await flushPromises()
    expect(getJson).toHaveBeenCalledWith('/api/system/version?fresh=1', expect.anything())
    expect(state.status.value?.updateAvailable).toBe(false)

    let release!: (value: unknown) => void
    getJson.mockReturnValueOnce(new Promise(resolve => { release = resolve }))
    const recheck = state.recheck()
    expect(state.checking.value).toBe(true)
    // The last answer stays on screen while the recheck runs.
    expect(state.status.value?.latestVersion).toBe('0.23.0-beta.6')
    release(answer('0.23.0-beta.7', true))
    await recheck
    expect(getJson).toHaveBeenCalledTimes(2)
    expect(state.checking.value).toBe(false)
    expect(state.status.value?.latestVersion).toBe('0.23.0-beta.7')
  })
})
