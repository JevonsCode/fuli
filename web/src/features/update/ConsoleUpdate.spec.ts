import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ getJson: vi.fn(), postJson: vi.fn() }))
vi.mock('@/api/client', async (importOriginal) => ({ ...await importOriginal<typeof import('@/api/client')>(), ...api }))

import GrowthLoading from '@/components/GrowthLoading.vue'
import { setLocale } from '@/i18n'
import ConsoleUpdate from './ConsoleUpdate.vue'

const job = (status: string, extra = {}) => ({ id: 'u1', status, fromVersion: '0.7.8', version: null, started: null,
  error: null, ...extra })

beforeEach(() => {
  setLocale('zh-CN', { persist: false })
  api.getJson.mockReset()
  api.postJson.mockReset()
  vi.useFakeTimers()
})
afterEach(() => vi.useRealTimers())

describe('ConsoleUpdate', () => {
  it('starts the update with one click, shows progress while FULI restarts, and reloads on the new version', async () => {
    const reload = vi.fn()
    const wrapper = mount(ConsoleUpdate, { props: { version: '0.8.0', reload } })
    expect(wrapper.text()).not.toMatch(/fuli |终端/)
    api.postJson.mockResolvedValueOnce(job('updating'))
    await wrapper.get('[data-console-update-start]').trigger('click')
    await flushPromises()
    expect(api.postJson).toHaveBeenCalledWith('/api/system/update', {})
    expect(wrapper.getComponent(GrowthLoading).props()).toMatchObject({ variant: 'inline',
      label: '正在更新到 v0.8.0，FULI 重新启动后页面会自动刷新…' })
    expect(wrapper.emitted('busy')?.[0]).toEqual([true])

    api.getJson.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await vi.advanceTimersByTimeAsync(3000)
    expect(reload).not.toHaveBeenCalled()
    api.getJson.mockResolvedValueOnce({ update: job('updated', { version: '0.8.0' }) })
    await vi.advanceTimersByTimeAsync(3000)
    expect(reload).toHaveBeenCalledOnce()
  })

  it('says why an update did not finish, without a command, and allows another try', async () => {
    const wrapper = mount(ConsoleUpdate, { props: { version: '0.8.0', reload: vi.fn() } })
    api.postJson.mockResolvedValueOnce(job('updating'))
    await wrapper.get('[data-console-update-start]').trigger('click')
    await flushPromises()
    api.getJson.mockResolvedValueOnce({ update: job('failed', { error: 'Global package installation failed (exit code 1).' }) })
    await vi.advanceTimersByTimeAsync(3000)
    expect(wrapper.get('[role="alert"]').text()).toBe('没有更新完成：Global package installation failed (exit code 1).')
    expect(wrapper.find('[data-console-update-start]').exists()).toBe(true)
    expect(wrapper.emitted('busy')?.at(-1)).toEqual([false])
  })

  it('names the installer for an installation the console does not update itself', () => {
    const wrapper = mount(ConsoleUpdate, { props: { version: '0.8.0', offered: false } })
    expect(wrapper.find('[data-console-update-start]').exists()).toBe(false)
    expect(wrapper.text()).toContain('安装程序')
    expect(wrapper.text()).not.toMatch(/fuli |终端|\.cmd/)
  })
})
