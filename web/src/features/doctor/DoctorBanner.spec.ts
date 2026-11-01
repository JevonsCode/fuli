import { flushPromises, mount, RouterLinkStub } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ getJson: vi.fn(), postJson: vi.fn() }))
vi.mock('@/api/client', async (importOriginal) => ({ ...await importOriginal<typeof import('@/api/client')>(), ...api }))

import GrowthLoading from '@/components/GrowthLoading.vue'
import { setLocale } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import DoctorBanner from './DoctorBanner.vue'
import type { DoctorItem, DoctorReport } from './model'

const item = (id: string, kind: string, severity: DoctorItem['severity'], fix: DoctorItem['fix'], data = {}): DoctorItem =>
  ({ id, kind, severity, fix, data })
const report = (overall: DoctorReport['overall'], items: DoctorItem[]): DoctorReport =>
  ({ checkedAt: '2026-10-28T08:00:00.000Z', version: '0.22.0', overall, items, unchecked: [] })

const OUTDATED = item('client_outdated:codex', 'client_outdated', 'warning', 'auto', { clientId: 'codex', label: 'Codex', status: 'changed' })
const WAITING = item('data_format_waiting:graph (personal)', 'data_format_waiting', 'blocking', 'person',
  { store: 'graph', label: 'graph (personal)', steps: ['graph-0007'] })
const SESSIONS = item('sessions_outdated:claude_code:0.21.0', 'sessions_outdated', 'warning', 'person',
  { client: 'claude_code', count: 2, runningVersion: '0.21.0' })
const UPDATE = item('update_available', 'update_available', 'info', 'person', { latest: '0.23.0' })

function mountBanner() {
  setActivePinia(createPinia())
  const wrapper = mount(DoctorBanner, { global: { stubs: { RouterLink: RouterLinkStub } } })
  return { wrapper, store: useConsoleStore() }
}

beforeEach(() => {
  setLocale('zh-CN', { persist: false })
  api.getJson.mockReset()
  api.postJson.mockReset()
  vi.useFakeTimers()
})
afterEach(() => vi.useRealTimers())

describe('DoctorBanner', () => {
  it('says nothing while FULI is ok, info items included', async () => {
    api.getJson.mockResolvedValue(report('ok', [UPDATE]))
    const { wrapper } = mountBanner()
    await flushPromises()
    expect(api.getJson).toHaveBeenCalledWith('/api/system/doctor')
    expect(wrapper.find('[data-doctor-banner]').exists()).toBe(false)
  })

  it('counts what needs the person and lists it in plain words, with where to handle it', async () => {
    api.getJson.mockResolvedValue(report('degraded', [WAITING, OUTDATED, SESSIONS, UPDATE]))
    const { wrapper } = mountBanner()
    await flushPromises()
    expect(wrapper.get('[data-doctor-banner]').text()).toContain('有 3 件事需要你')
    expect(wrapper.find('[data-doctor-items]').exists()).toBe(false)
    await wrapper.get('[data-doctor-toggle]').trigger('click')
    const list = wrapper.get('[data-doctor-items]')
    expect(list.text()).toContain('数据格式更新等你确认：graph (personal)')
    expect(list.text()).toContain('客户端的 FULI 连接需要更新：Codex')
    expect(list.text()).toContain('Claude Code')
    expect(list.text()).toContain('2 个会话还在用 0.21.0')
    // Never a raw kind code, and an info item is not one of the things that need the person.
    expect(list.text()).not.toMatch(/client_outdated|data_format|sessions_outdated|update_available/)
    expect(wrapper.findAllComponents(RouterLinkStub).map(link => link.props('to'))).toEqual(['/settings/data-format'])
  })

  it('says when a waiting graph step was last seen while the graph is idle', async () => {
    const remembered = item('data_format_waiting:graph (personal)', 'data_format_waiting', 'blocking', 'person',
      { store: 'graph', label: 'graph (personal)', steps: ['graph/12-builtin-occupations'], lastSeenAt: '2026-10-31T09:00:00.000Z' })
    api.getJson.mockResolvedValue(report('degraded', [remembered]))
    const { wrapper } = mountBanner()
    await flushPromises()
    await wrapper.get('[data-doctor-toggle]').trigger('click')
    const text = wrapper.get('[data-doctor-items]').text()
    expect(text).toContain('数据格式更新等你确认：graph (personal)')
    expect(text).toContain('它现在空闲没有运行。确认之前 FULI 写不进图谱')
    expect(text).toContain('2026')
    expect(text).not.toMatch(/fuli |migrate|lastSeenAt/)
    expect(wrapper.getComponent(RouterLinkStub).props('to')).toBe('/settings/data-format')
  })

  it('asks for its sessions when the panel opens and offers to open the ones the launcher links', async () => {
    const withSessions = item('sessions_outdated:codex:0.21.0', 'sessions_outdated', 'warning', 'person', { client: 'codex', count: 4,
      runningVersion: '0.21.0', sessions: [
        { sourceApplication: 'codex', sessionId: 'synthetic-thread-a1b2c3' },
        { sourceApplication: 'codex', sessionId: 'synthetic-thread-d4e5f6' },
      ] })
    let answer!: (value: unknown) => void
    api.getJson.mockImplementation((path: string) => path === '/api/system/doctor'
      ? Promise.resolve(report('needs_person', [withSessions]))
      : new Promise((resolve) => { answer = resolve }))
    const { wrapper } = mountBanner()
    await flushPromises()
    expect(api.getJson).toHaveBeenCalledTimes(1)
    await wrapper.get('[data-doctor-toggle]').trigger('click')
    expect(api.getJson).toHaveBeenLastCalledWith(
      '/api/session-launch/offers?session=codex%3Asynthetic-thread-a1b2c3&session=codex%3Asynthetic-thread-d4e5f6')
    expect(wrapper.getComponent(GrowthLoading).props()).toMatchObject({ variant: 'inline', label: '正在查找这些会话的打开链接…' })
    answer({ launcher: 'available', offers: [
      { sourceApplication: 'codex', sessionId: 'synthetic-thread-a1b2c3', client: 'codex', offer: 'link', href: 'codex://threads/synthetic-thread-a1b2c3' },
      { sourceApplication: 'codex', sessionId: 'synthetic-thread-d4e5f6', client: 'codex', offer: 'none' },
    ] })
    await flushPromises()
    expect(wrapper.findComponent(GrowthLoading).exists()).toBe(false)
    const sessions = wrapper.get('[data-doctor-sessions]')
    expect(sessions.findAll('li').map(row => row.text())).toEqual(['Codex …a1b2c3打开'])
    const open = sessions.get('[data-doctor-session-open]')
    expect(open.attributes()).toMatchObject({ href: 'codex://threads/synthetic-thread-a1b2c3', rel: 'noreferrer' })
    expect(wrapper.get('[data-doctor-items]').text()).toContain('4 个会话还在用 0.21.0')
    expect(wrapper.text()).not.toContain('synthetic-thread')
  })

  it('keeps the one-line hint when no session can be opened', async () => {
    const withSessions = item('sessions_outdated:codex:0.21.0', 'sessions_outdated', 'warning', 'person', { client: 'codex', count: 1,
      runningVersion: '0.21.0', sessions: [{ sourceApplication: 'codex', sessionId: 'synthetic-thread-a1b2c3' }] })
    api.getJson.mockImplementation((path: string) => Promise.resolve(path === '/api/system/doctor'
      ? report('needs_person', [withSessions])
      : { launcher: 'available', offers: [{ sourceApplication: 'codex', sessionId: 'synthetic-thread-a1b2c3', client: 'codex', offer: 'none' }] }))
    const { wrapper } = mountBanner()
    await flushPromises()
    await wrapper.get('[data-doctor-toggle]').trigger('click')
    await flushPromises()
    expect(api.getJson).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[data-doctor-sessions]').exists()).toBe(false)
    expect(wrapper.findComponent(GrowthLoading).exists()).toBe(false)
    expect(wrapper.get('[data-doctor-items]').text()).toContain('1 个会话还在用 0.21.0，重启这些会话就会用上新版。')
  })

  it('reads a kind it does not know yet as something to look at', async () => {
    api.getJson.mockResolvedValue(report('needs_person', [item('graph_offline', 'graph_offline', 'warning', 'person')]))
    const { wrapper } = mountBanner()
    await flushPromises()
    await wrapper.get('[data-doctor-toggle]').trigger('click')
    expect(wrapper.get('[data-doctor-items]').text()).toBe('还有一件事需要你看看')
    expect(wrapper.find('[data-doctor-repair]').exists()).toBe(false)
  })

  it('repairs what needs no decision, shows the pending action, then shows the fresh answer', async () => {
    api.getJson.mockResolvedValue(report('needs_person', [OUTDATED, SESSIONS]))
    const { wrapper, store } = mountBanner()
    await flushPromises()
    let finish!: (value: unknown) => void
    api.postJson.mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
    await wrapper.get('[data-doctor-toggle]').trigger('click')
    await wrapper.get('[data-doctor-repair]').trigger('click')
    expect(api.postJson).toHaveBeenCalledWith('/api/system/doctor/repair', {})
    expect(wrapper.getComponent(GrowthLoading).props()).toMatchObject({ variant: 'inline', label: '正在自动修复：重新连接客户端…' })
    finish({ results: [{ id: OUTDATED.id, outcome: 'fixed' }], doctor: report('needs_person', [SESSIONS]) })
    await flushPromises()
    expect(store.feedback).toEqual({ tone: 'success', message: '已自动修复 1 件事' })
    expect(wrapper.text()).toContain('有 1 件事需要你')
    expect(wrapper.find('[data-doctor-repair]').exists()).toBe(false)
  })

  it('says what could not be repaired and keeps the banner', async () => {
    api.getJson.mockResolvedValue(report('needs_person', [OUTDATED]))
    const { wrapper } = mountBanner()
    await flushPromises()
    api.postJson.mockResolvedValueOnce({ results: [{ id: OUTDATED.id, outcome: 'failed', error: 'Client is unavailable for automatic connection' }],
      doctor: report('needs_person', [OUTDATED]) })
    await wrapper.get('[data-doctor-toggle]').trigger('click')
    await wrapper.get('[data-doctor-repair]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-doctor-failure]').text()).toBe('有 1 件没能自动修复：Client is unavailable for automatic connection')
    expect(wrapper.find('[data-doctor-repair]').exists()).toBe(true)
  })

  it('is a chip whose panel floats over the page and closes on Escape or a click outside', async () => {
    api.getJson.mockResolvedValue(report('needs_person', [OUTDATED, SESSIONS]))
    const { wrapper } = mountBanner()
    await flushPromises()
    const chip = wrapper.get('[data-doctor-toggle]')
    expect(chip.text()).toBe('有 2 件事需要你')
    expect(chip.attributes('aria-expanded')).toBe('false')
    expect(wrapper.find('[data-doctor-panel]').exists()).toBe(false)
    await chip.trigger('click')
    expect(chip.attributes('aria-expanded')).toBe('true')
    expect(wrapper.find('[data-doctor-panel]').exists()).toBe(true)
    await wrapper.get('[data-doctor-banner]').trigger('keydown', { key: 'Escape' })
    expect(wrapper.find('[data-doctor-panel]').exists()).toBe(false)
    await chip.trigger('click')
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-doctor-panel]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('says once that FULI moved its port by itself, not on the next read or the next visit', async () => {
    window.localStorage.clear()
    const moved = item('ports_moved:2026-10-27T08:00:00.000Z', 'ports_moved', 'info', 'person',
      { movedAt: '2026-10-27T08:00:00.000Z', moves: [{ key: 'console', from: 2727, to: 2734, reason: 'reserved' }] })
    api.getJson.mockResolvedValue(report('ok', [moved]))
    const first = mountBanner()
    await flushPromises()
    expect(first.store.feedback).toEqual({ tone: 'success', message: '端口 2727 被系统保留，FULI 已自动改用 2734，不用你做什么。' })
    expect(first.wrapper.find('[data-doctor-banner]').exists()).toBe(false)
    first.store.feedback = null
    await vi.advanceTimersByTimeAsync(60_000)
    expect(first.store.feedback).toBeNull()
    first.wrapper.unmount()

    const again = mountBanner()
    await flushPromises()
    expect(again.store.feedback).toBeNull()
    again.wrapper.unmount()

    // A later start that moves again is said again; graph services alone get one sentence.
    api.getJson.mockResolvedValue(report('ok', [item('ports_moved:2026-10-30T08:00:00.000Z', 'ports_moved', 'info', 'person',
      { moves: [{ key: 'personalProvider', from: 8787, to: 8789, reason: 'reserved' }] })]))
    const later = mountBanner()
    await flushPromises()
    expect(later.store.feedback?.message).toBe('有端口不能用，FULI 已自动给图谱服务换了端口，不用你做什么。')
    later.wrapper.unmount()
    window.localStorage.clear()
  })

  it('reads again every minute and keeps the last answer when a read fails', async () => {
    api.getJson.mockResolvedValueOnce(report('needs_person', [OUTDATED]))
    const { wrapper } = mountBanner()
    await flushPromises()
    api.getJson.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(api.getJson).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).toContain('有 1 件事需要你')
    api.getJson.mockResolvedValueOnce(report('ok', []))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(wrapper.find('[data-doctor-banner]').exists()).toBe(false)
    wrapper.unmount()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(api.getJson).toHaveBeenCalledTimes(3)
  })
})
