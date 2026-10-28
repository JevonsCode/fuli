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

  it('updates a tray installation with one click and labels each real step it reports', async () => {
    const reload = vi.fn()
    const wrapper = mount(ConsoleUpdate, { props: { version: '0.8.0', kind: 'windows-tray', reload } })
    expect(wrapper.text()).toContain('Windows 安装包')
    expect(wrapper.text()).not.toMatch(/fuli |终端|\.cmd|托盘的安装程序/)
    api.postJson.mockResolvedValueOnce(job('updating', { kind: 'windows-tray', step: null }))
    await wrapper.get('[data-console-update-start]').trigger('click')
    await flushPromises()
    expect(api.postJson).toHaveBeenCalledWith('/api/system/update', {})
    const label = () => wrapper.getComponent(GrowthLoading).props('label')
    api.getJson.mockResolvedValueOnce({ update: job('updating', { kind: 'windows-tray', step: 'downloading' }) })
    await vi.advanceTimersByTimeAsync(3000)
    expect(label()).toBe('正在下载 v0.8.0 的 Windows 安装包…')
    api.getJson.mockResolvedValueOnce({ update: job('updating', { kind: 'windows-tray', step: 'exitingTray' }) })
    await vi.advanceTimersByTimeAsync(3000)
    expect(label()).toBe('正在关闭 FULI 桌面客户端，它手上的操作结束后继续…')
    // FULI is stopped while the new version is installed; the last real step stays.
    api.getJson.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await vi.advanceTimersByTimeAsync(3000)
    expect(label()).toBe('正在关闭 FULI 桌面客户端，它手上的操作结束后继续…')
    expect(wrapper.findAllComponents(GrowthLoading)).toHaveLength(1)
    api.getJson.mockResolvedValueOnce({ update: job('updated', { kind: 'windows-tray', version: '0.8.0' }) })
    await vi.advanceTimersByTimeAsync(3000)
    expect(reload).toHaveBeenCalledOnce()
  })

  it('names the FULI processes that blocked the update and stops exactly those on the next click', async () => {
    const wrapper = mount(ConsoleUpdate, { props: { version: '0.8.0', kind: 'windows-tray', reload: vi.fn() } })
    api.postJson.mockResolvedValueOnce(job('updating', { kind: 'windows-tray' }))
    await wrapper.get('[data-console-update-start]').trigger('click')
    await flushPromises()
    const blockers = [{ role: 'console', pid: 40, createdFileTime: '133', executable: 'C:\\Program Files\\nodejs\\node.exe' }]
    api.getJson.mockResolvedValueOnce({ update: job('failed', { kind: 'windows-tray', error: 'Another Fuli program runs on this data folder.', blockers }) })
    await vi.advanceTimersByTimeAsync(3000)
    expect(wrapper.get('[data-console-update-blockers]').text()).toBe('管理页，进程 40：C:\\Program Files\\nodejs\\node.exe')
    api.postJson.mockResolvedValueOnce(job('updating', { id: 'u2', kind: 'windows-tray' }))
    await wrapper.get('[data-console-update-stop-blockers]').trigger('click')
    await flushPromises()
    expect(api.postJson).toHaveBeenLastCalledWith('/api/system/update', { stopProcesses: ['40:133'] })
    expect(wrapper.find('[data-console-update-blockers]').exists()).toBe(false)
  })
})
