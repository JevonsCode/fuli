import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
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
  const wrapper = mount(AgentAppsPage, { attachTo: document.body })
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
    expect(document.querySelector('[data-app-confirm="code"]')?.textContent).toContain('数据会留下')
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
