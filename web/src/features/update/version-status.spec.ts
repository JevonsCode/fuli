import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, ref } from 'vue'
import { offeredVersion, refreshVersionStatus, useChannelVersionStatus } from './version-status'

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

  // 11-18: the header's dot kept the start-up answer after 接收测试版 was turned off.
  it('moves the header dot with 设置: a channel switch or 「检查更新」 answers for the whole console', async () => {
    getJson.mockResolvedValueOnce({ ...answer('0.29.0-beta.2', true), checkedAt: '2026-11-18T09:00:00.000Z' })
    await refreshVersionStatus()
    expect(offeredVersion.value).toBe('0.29.0-beta.2')

    getJson.mockResolvedValueOnce({ ...answer('0.27.16', false), channel: 'stable', checkedAt: '2026-11-18T09:29:00.000Z' })
    let state!: ReturnType<typeof useChannelVersionStatus>
    mount(defineComponent({ setup() { state = useChannelVersionStatus(ref('stable')); return () => null } }))
    await flushPromises()
    expect(state.status.value?.updateAvailable).toBe(false)
    expect(offeredVersion.value).toBeNull()

    // A slower read checked before that answer does not bring the dot back.
    getJson.mockResolvedValueOnce({ ...answer('0.29.0-beta.2', true), checkedAt: '2026-11-18T09:10:00.000Z' })
    await refreshVersionStatus()
    expect(offeredVersion.value).toBeNull()

    getJson.mockResolvedValueOnce({ ...answer('0.27.17', true), channel: 'stable', checkedAt: '2026-11-18T10:29:00.000Z' })
    await refreshVersionStatus(undefined, { fresh: true })
    expect(getJson).toHaveBeenLastCalledWith('/api/system/version?fresh=1', expect.anything())
    expect(offeredVersion.value).toBe('0.27.17')
  })
})
