import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/client'
import { setLocale } from '@/i18n'
import { useConsoleStore } from '@/stores/console'

const { getJson, postJson } = vi.hoisted(() => ({ getJson: vi.fn(), postJson: vi.fn() }))
vi.mock('@/api/client', async (original) => ({ ...(await original<typeof import('@/api/client')>()), getJson, postJson }))

const { default: AgentAppsPage } = await import('./AgentAppsPage.vue')

// Synthetic apps only.
const row = (appId: string, patch: Record<string, unknown> = {}) => ({
  appId, agentId: 'agent-a', name: appId, title: `Synthetic ${appId}`, type: 'page', status: 'active', version: '1.0.0',
  pendingVersions: [], approval: null, run: { status: 'ready' }, instance: null, lastUsedAt: null, dataBytes: 4096, ...patch,
})
const detail = (appId: string, patch: Record<string, unknown> = {}) => ({
  appId, agentId: 'agent-a', name: appId, status: 'active', version: '1.0.0', run: { status: 'ready' }, instance: null, dataBytes: 4096,
  versions: [{ version: '1.0.0', state: 'approved', digest: 'sha256:synthetic', type: 'page', permissions: {}, resident: false,
    approval: { verification: 'terminal_confirmation', trustMode: 'trusted' }, submittedAt: '2026-11-01T00:00:00Z' }],
  history: [{ action: 'approved', at: '2026-11-01T00:00:00Z' }], ...patch,
})
const apps = [
  row('app-new', { pendingVersions: ['1.1.0'] }),
  row('app-live', { instance: { state: 'running' } }),
  row('app-old', { status: 'code_deleted', version: null }),
]

function answer(routes: Record<string, unknown>) {
  getJson.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/project-agents/')) throw new ApiError('Not found', 404)
    for (const [prefix, value] of Object.entries(routes)) if (url.startsWith(prefix)) return value
    throw new ApiError('Not found', 404)
  })
}

async function mountPage() {
  const store = useConsoleStore()
  store.state = { mode: 'connected', activePersonalSpaceId: 'space-a', personalSpaces: [{ id: 'space-a', name: 'Synthetic' }], projects: [], subscriptions: [] } as never
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:path(.*)*', component: { render: () => null } }] })
  const wrapper = mount(AgentAppsPage, { attachTo: document.body, global: { plugins: [router] } })
  await flushPromises()
  return wrapper
}

beforeEach(() => { setActivePinia(createPinia()); setLocale('zh-CN', { persist: false }) })
afterEach(() => { getJson.mockReset(); postJson.mockReset(); document.body.innerHTML = '' })

describe('应用', () => {
  it('groups apps by what they need from the person, each with one status line', async () => {
    answer({ '/api/agent-apps?': { apps } })
    const wrapper = await mountPage()
    expect(wrapper.findAll('[data-apps-group]').map(group => group.attributes('data-apps-group'))).toEqual(['attention', 'running', 'removed'])
    expect(wrapper.get('[data-app="app-new"]').text()).toContain('新版本 1.1.0 等你批准')
    expect(wrapper.get('[data-app="app-live"]').text()).toContain('运行中')
    expect(wrapper.get('[data-app="app-old"]').text()).toContain('代码已删除，数据还在')
  })

  it('shows versions with whether each approval was confirmed', async () => {
    answer({ '/api/agent-apps?': { apps }, '/api/agent-apps/app-new': detail('app-new') })
    const wrapper = await mountPage()
    await wrapper.get('[data-app="app-new"]').trigger('click')
    await flushPromises()
    expect(document.querySelector('[data-app-version="1.0.0"]')?.textContent).toContain('已批准 · 已确认')
    // The console never sends the person to a terminal.
    expect(document.querySelector('[data-app-sheet]')?.textContent).not.toMatch(/终端|fl app/)
  })

  it('deletes the code only after a confirmation that says the data stays', async () => {
    answer({ '/api/agent-apps?': { apps }, '/api/agent-apps/app-live': detail('app-live'), '/api/agent-apps/app-old': detail('app-old', { status: 'code_deleted', version: null }) })
    postJson.mockResolvedValue({})
    const wrapper = await mountPage()
    await wrapper.get('[data-app="app-live"]').trigger('click')
    await flushPromises()
    ;(document.querySelector('[data-app-delete-code]') as HTMLElement).click()
    await flushPromises()
    expect(document.querySelector('[data-app-confirm-step="code"]')?.textContent).toContain('数据会留下')
    expect(postJson).not.toHaveBeenCalled()
    ;(document.querySelector('[data-app-delete-code-confirm]') as HTMLElement).click()
    await flushPromises()
    expect(postJson).toHaveBeenCalledWith('/api/agent-apps/app-live/delete-code', {}, expect.anything())
  })

  it('says plainly when this FULI cannot manage apps', async () => {
    getJson.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/agent-apps')) throw new ApiError('x', 503, JSON.stringify({ error: 'Agent apps need a local FULI installation', code: 'agent_apps_unavailable' }))
      throw new ApiError('Not found', 404)
    })
    const wrapper = await mountPage()
    expect(wrapper.text()).toContain('这台电脑上的 FULI 还不能管理应用')
  })
})

describe('应用 lifecycle', () => {
  const click = async (selector: string) => { (document.querySelector(selector) as HTMLElement).click(); await flushPromises() }
  async function openSheet(appId: string, routes: Record<string, unknown>) {
    answer(routes)
    const wrapper = await mountPage()
    await wrapper.get(`[data-app="${appId}"]`).trigger('click')
    await flushPromises()
    return wrapper
  }

  it('opens FULI’s confirmation window for a waiting version, then reads the app again', async () => {
    postJson.mockResolvedValue({ opened: true })
    await openSheet('app-new', { '/api/agent-apps?': { apps }, '/api/agent-apps/app-new': detail('app-new') })
    const callout = document.querySelector('[data-app-confirmation]')!
    expect(callout.textContent).toContain('新版本 1.1.0 确认后就能运行')
    expect(callout.textContent).toContain('FULI 不会隔离它')
    await click('[data-app-confirm]')
    expect(postJson).toHaveBeenCalledWith('/api/agent-apps/app-new/confirm', { action: 'approve', version: '1.1.0' }, expect.anything())
    expect(document.querySelector('[data-app-confirm-opened]')?.textContent).toContain('输入应用名「app-new」')
    expect(document.querySelector('[data-app-sheet]')?.textContent).not.toMatch(/终端|fl app/)
  })

  it('starts a ready tool, and stops or restarts a running one', async () => {
    postJson.mockResolvedValue({ status: 'running', instance: { state: 'running' } })
    const tools = [row('app-tool', { type: 'tool' }), row('app-live', { type: 'service', instance: { state: 'running' } })]
    const first = await openSheet('app-tool', { '/api/agent-apps?': { apps: tools }, '/api/agent-apps/app-tool': detail('app-tool') })
    await click('[data-app-start]')
    expect(postJson).toHaveBeenCalledWith('/api/agent-apps/app-tool/start', {}, expect.anything())
    first.unmount()
    await openSheet('app-live', { '/api/agent-apps?': { apps: tools }, '/api/agent-apps/app-live': detail('app-live') })
    expect(document.querySelector('[data-app-start]')).toBeNull()
    await click('[data-app-restart]')
    expect(postJson).toHaveBeenLastCalledWith('/api/agent-apps/app-live/restart', {}, expect.anything())
    await click('[data-app-stop]')
    expect(postJson).toHaveBeenLastCalledWith('/api/agent-apps/app-live/stop', {}, expect.anything())
  })

  it('says why a start was refused, in the person’s words', async () => {
    postJson.mockRejectedValue(new ApiError('409', 409, JSON.stringify({ code: 'reconfirmation_required', error: 'internal wording' })))
    await openSheet('app-tool', { '/api/agent-apps?': { apps: [row('app-tool', { type: 'tool' })] }, '/api/agent-apps/app-tool': detail('app-tool') })
    await click('[data-app-start]')
    expect(document.querySelector('.app-sheet')?.textContent).toContain('要你重新确认后才能运行')
  })

  it('offers a page app as a link to open it inside FULI', async () => {
    await openSheet('app-page', { '/api/agent-apps?': { apps: [row('app-page')] }, '/api/agent-apps/app-page': detail('app-page') })
    expect(document.querySelector('[data-app-open]')?.getAttribute('href')).toBe('/project-agents/apps/app-page')
    expect(document.querySelector('[data-app-start]')).toBeNull()
  })

  it('exports before deleting data, and deletes it only with the offer’s ticket and the typed app id', async () => {
    postJson.mockImplementation(async (url: string) => {
      if (url.endsWith('/export')) return { path: 'C:/synthetic/FULI app exports/app-old-20261101T000000Z', files: 2, bytes: 4096 }
      if (url.endsWith('/data-deletion')) return { ticket: 'ticket-synthetic', expiresAt: '2026-11-01T01:00:00Z', dataBytes: 4096, dataFiles: 2 }
      return {}
    })
    await openSheet('app-old', { '/api/agent-apps?': { apps }, '/api/agent-apps/app-old': detail('app-old', { status: 'code_deleted', version: null, history: [{ action: 'instance_started', at: '2026-11-01T00:00:00Z' }] }) })
    await click('[data-app-export]')
    expect(document.querySelector('[data-app-exported]')?.textContent).toContain('app-old-20261101T000000Z')
    await click('[data-app-reveal]')
    expect(postJson).toHaveBeenLastCalledWith('/api/agent-apps/app-old/reveal-export', { path: 'C:/synthetic/FULI app exports/app-old-20261101T000000Z' }, expect.anything())
    await click('[data-app-delete-data]')
    const confirm = document.querySelector('[data-app-delete-data-confirm]') as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    const input = document.querySelector('[data-app-type-id]') as HTMLInputElement
    input.value = 'app-old'
    input.dispatchEvent(new Event('input'))
    await flushPromises()
    confirm.click()
    await flushPromises()
    expect(postJson).toHaveBeenLastCalledWith('/api/agent-apps/app-old/delete-data', { ticket: 'ticket-synthetic', confirm: 'app-old' }, expect.anything())
  })

  it('greys out export for an app that has no data and never ran', async () => {
    await openSheet('app-old', { '/api/agent-apps?': { apps: [row('app-old', { status: 'code_deleted', version: null, dataBytes: 0 })] }, '/api/agent-apps/app-old': detail('app-old', { status: 'code_deleted', history: [] }) })
    expect((document.querySelector('[data-app-export]') as HTMLButtonElement).disabled).toBe(true)
  })
})
