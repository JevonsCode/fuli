import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'

import { useConsoleStore } from '@/stores/console'
import type { ConsoleState } from '@/types'
import { DEFAULT_CONVERSATION_LAUNCHERS } from '@/features/knowledge/source-adapters'
import SettingsPage from './SettingsPage.vue'

const configured = {
  version: 1 as const,
  graphRuntimeMode: 'container' as const,
  ports: {
    console: 2727,
    personalProvider: 8787,
    personalNeo4jHttp: 8060,
    personalNeo4jBolt: 7687,
    workspaceProvider: 8788,
    workspaceNeo4jHttp: 7475,
    workspaceNeo4jBolt: 7688,
  },
  lanAccess: false,
  resourceRefreshSeconds: 5 as const,
  conversationLaunchers: structuredClone(DEFAULT_CONVERSATION_LAUNCHERS),
}

// The open tab lives in the URL, so the page needs a router.
const settingsRouter = () => createRouter({ history: createMemoryHistory(), routes: [{ path: '/:any(.*)*', component: { template: '<div />' } }] })

describe('SettingsPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('renders older settings with a missing launcher without crashing or changing existing values', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    useConsoleStore().runtimeStatus = 'ready'
    const legacy = { ...configured, conversationLaunchers: { codex: { ...DEFAULT_CONVERSATION_LAUNCHERS.codex, enabled: false } } }
    vi.stubGlobal('fetch', vi.fn(async (input) => {
      if (String(input) === '/api/system/settings') return Response.json({ configured: legacy, active: configured, restartRequired: false })
      return Response.json({}, { status: 503 })
    }))
    const wrapper = mount(SettingsPage, { global: { plugins: [pinia, settingsRouter()] } })
    await flushPromises()
    expect(wrapper.findAll('.conversation-launcher-row')).toHaveLength(7)
    const codex = wrapper.findAll('.conversation-launcher-row').find((row) => row.text().includes('Codex'))!
    expect(codex.get('[role="switch"]').attributes('aria-checked')).toBe('false')
    expect(wrapper.find('#settings-form').exists()).toBe(true)
    wrapper.unmount()
  })

  it('narrows the page to matching settings and says when nothing matches', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    useConsoleStore().runtimeStatus = 'ready'
    vi.stubGlobal('fetch', vi.fn(async (input) => {
      if (String(input) === '/api/system/settings') return Response.json({ configured, active: configured, restartRequired: false })
      return Response.json({}, { status: 503 })
    }))
    const wrapper = mount(SettingsPage, { global: { plugins: [pinia, settingsRouter()] }, attachTo: document.body })
    await flushPromises()
    const search = wrapper.get('.settings-search input')
    await search.setValue('Neo4j Bolt')
    await flushPromises()
    const ports = wrapper.get('.ports-card')
    expect(ports.attributes('data-search-hidden')).toBeUndefined()
    expect(ports.attributes('data-state')).toBe('open')
    // A search looks through every tab, not only the open one.
    expect(wrapper.get('[data-settings-tab="network"]').attributes('hidden')).toBeUndefined()
    expect(wrapper.get('.behavior-card').attributes('data-search-hidden')).toBe('')
    await search.setValue('zzz-no-such-setting')
    await flushPromises()
    expect(wrapper.get('.settings-search-empty').text()).toContain('zzz-no-such-setting')
    await search.setValue('')
    await flushPromises()
    expect(wrapper.findAll('[data-search-hidden]')).toHaveLength(0)
    expect(ports.attributes('data-state')).toBe('closed')
    expect(wrapper.get('[data-settings-tab="network"]').attributes('hidden')).toBeDefined()
    wrapper.unmount()
  })

  it('saves the local address that is told when a person is needed', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    useConsoleStore().runtimeStatus = 'ready'
    const withNotifications = { ...configured, notifications: { needsPersonUrl: '' } }
    const puts: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (input, init?: RequestInit) => {
      if (String(input) === '/api/system/settings' && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body))
        puts.push(body)
        return Response.json({ configured: body, active: body, restartRequired: false })
      }
      if (String(input) === '/api/system/settings') return Response.json({ configured: withNotifications, active: withNotifications, restartRequired: false })
      return Response.json({}, { status: 503 })
    }))
    const wrapper = mount(SettingsPage, { global: { plugins: [pinia, settingsRouter()] } })
    await flushPromises()
    await wrapper.get('[data-needs-person-url]').setValue('http://127.0.0.1:9123/fuli')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(puts).toHaveLength(1)
    expect((puts[0] as { notifications: unknown }).notifications).toEqual({ needsPersonUrl: 'http://127.0.0.1:9123/fuli' })
    wrapper.unmount()
  })

  it('saves, edits and clears the Agent naming style with its suggested length', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    useConsoleStore().runtimeStatus = 'ready'
    const withStyle = { ...configured, agentNamingStyle: '用两个字的植物名' }
    const puts: Array<{ agentNamingStyle: string }> = []
    vi.stubGlobal('fetch', vi.fn(async (input, init?: RequestInit) => {
      if (String(input) === '/api/system/settings' && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body))
        puts.push(body)
        return Response.json({ configured: body, active: body, restartRequired: false })
      }
      if (String(input) === '/api/system/settings') return Response.json({ configured: withStyle, active: withStyle, restartRequired: false })
      return Response.json({}, { status: 503 })
    }))
    const wrapper = mount(SettingsPage, { global: { plugins: [pinia, settingsRouter()] } })
    await flushPromises()
    const card = wrapper.get('[data-agent-naming-card]')
    expect(card.text()).toContain('Agent 取名风格')
    expect(card.text()).toContain('建议 100 字左右')
    const field = wrapper.get<HTMLTextAreaElement>('[data-agent-naming-style]')
    expect(field.element.value).toBe('用两个字的植物名')
    expect(card.text()).toContain('8 / 建议 100 字')

    await field.setValue('像北欧神话里的名字')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    await wrapper.get('[data-agent-naming-clear]').trigger('click')
    expect(field.element.value).toBe('')
    expect(wrapper.get('[data-agent-naming-clear]').attributes('disabled')).toBeDefined()
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(puts.map(body => body.agentNamingStyle)).toEqual(['像北欧神话里的名字', ''])
    wrapper.unmount()
  })

  it('hides the runtime-mode choice once the install already runs native', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    useConsoleStore().runtimeStatus = 'ready'
    const native = { ...configured, graphRuntimeMode: 'native' as const }
    vi.stubGlobal('fetch', vi.fn(async (input) => String(input) === '/api/system/settings'
      ? Response.json({ configured: native, active: native, restartRequired: false })
      : Response.json({}, { status: 503 })))
    const wrapper = mount(SettingsPage, { global: { plugins: [pinia, settingsRouter()] } })
    await flushPromises()
    expect(wrapper.find('[data-select-id="settings-runtime-mode"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('turns decorative motion off for this browser without touching the saved settings', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    useConsoleStore().runtimeStatus = 'ready'
    const fetch = vi.fn(async (input) => {
      if (String(input) === '/api/system/settings') return Response.json({ configured, active: configured, restartRequired: false })
      return Response.json({}, { status: 503 })
    })
    vi.stubGlobal('fetch', fetch)
    const wrapper = mount(SettingsPage, { global: { plugins: [pinia, settingsRouter()] } })
    await flushPromises()
    const requests = fetch.mock.calls.length
    const toggle = wrapper.get('[data-reduce-motion]')
    expect(toggle.attributes('aria-checked')).toBe('false')

    await toggle.trigger('click')
    expect(document.documentElement.dataset.motion).toBe('reduced')
    expect(window.localStorage.getItem('fuli.motion')).toBe('reduced')

    await toggle.trigger('click')
    expect(document.documentElement.dataset.motion).toBeUndefined()
    expect(window.localStorage.getItem('fuli.motion')).toBeNull()
    expect(fetch.mock.calls).toHaveLength(requests)
    wrapper.unmount()
  })

  it('reports a failed save in the persistent global feedback and unlocks retry', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useConsoleStore()
    store.runtimeStatus = 'ready'
    vi.stubGlobal('fetch', vi.fn(async (input, init) => {
      if (init?.method === 'PUT') return Response.json({ error: 'Port unavailable' }, { status: 400 })
      if (String(input) === '/api/system/settings') return Response.json({ configured, active: configured })
      return Response.json({}, { status: 503 })
    }))
    const wrapper = mount(SettingsPage, { global: { plugins: [pinia, settingsRouter()] } })
    await flushPromises()
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(store.feedback?.tone).toBe('error')
    expect(store.feedback?.message).toContain('Port unavailable')
    expect(wrapper.get('[data-settings-save]').attributes('disabled')).toBeUndefined()
    expect(wrapper.get('.settings-fields').attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })

  it('opens the clients tab on its main section expanded, not on closed headings only', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    useConsoleStore().runtimeStatus = 'ready'
    vi.stubGlobal('fetch', vi.fn(async (input) => {
      if (String(input) === '/api/system/settings') return Response.json({ configured, active: configured, restartRequired: false })
      return Response.json({}, { status: 503 })
    }))
    const router = settingsRouter()
    await router.push('/settings?tab=clients')
    const wrapper = mount(SettingsPage, { global: { plugins: [pinia, router] }, attachTo: document.body })
    await flushPromises()
    expect(wrapper.get('[data-settings-tab="clients"]').attributes('hidden')).toBeUndefined()
    expect(wrapper.get('.conversation-launcher-card').attributes('data-state')).toBe('open')
    // The person can still close it.
    await wrapper.get('.conversation-launcher-card button').trigger('click')
    expect(wrapper.get('.conversation-launcher-card').attributes('data-state')).toBe('closed')
    wrapper.unmount()
  })

  it('opens the tab and section of an invalid field on save, focuses it and sends nothing', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    useConsoleStore().runtimeStatus = 'ready'
    const fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      if (String(input) === '/api/system/settings' && !init?.method) return Response.json({ configured, active: configured })
      return Response.json({}, { status: 503 })
    })
    vi.stubGlobal('fetch', fetch)
    const wrapper = mount(SettingsPage, { global: { plugins: [pinia, settingsRouter()] }, attachTo: document.body })
    await flushPromises()
    const ports = wrapper.get('.ports-card')
    expect(ports.attributes('data-state')).toBe('closed')
    expect(wrapper.get('[data-settings-tab="network"]').attributes('hidden')).toBeDefined()
    const port = ports.get<HTMLInputElement>('input')
    await port.setValue('')
    await wrapper.get('#settings-form').trigger('submit')
    await flushPromises()
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false)
    expect(wrapper.get('[data-settings-tab-trigger="network"]').attributes('aria-selected')).toBe('true')
    expect(wrapper.get('[data-settings-tab="network"]').attributes('hidden')).toBeUndefined()
    expect(ports.attributes('data-state')).toBe('open')
    // Focus waits for the opened section to show (a few frames at most).
    await vi.waitFor(() => expect(document.activeElement).toBe(port.element))
    expect(port.attributes('aria-invalid')).toBe('true')
    expect(wrapper.get('[data-settings-savebar]').text()).toContain('请先修正「管理界面」再保存')
    wrapper.unmount()
  })

  it('shows an invalid field that the search had hidden: the filter clears, then the field gets focus', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    useConsoleStore().runtimeStatus = 'ready'
    const fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      if (String(input) === '/api/system/settings' && !init?.method) return Response.json({ configured, active: configured })
      return Response.json({}, { status: 503 })
    })
    vi.stubGlobal('fetch', fetch)
    const wrapper = mount(SettingsPage, { global: { plugins: [pinia, settingsRouter()] }, attachTo: document.body })
    await flushPromises()
    const port = wrapper.get('.ports-card').get<HTMLInputElement>('input')
    await port.setValue('')
    const search = wrapper.get<HTMLInputElement>('.settings-search input')
    await search.setValue('Codex')
    await flushPromises()
    expect(port.element.closest('[data-search-hidden]')).not.toBeNull()
    await wrapper.get('#settings-form').trigger('submit')
    await flushPromises()
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false)
    // No ancestor keeps the field out of sight, and the search says it was cleared.
    expect(port.element.closest('[data-search-hidden]')).toBeNull()
    expect(search.element.value).toBe('')
    expect(wrapper.get('[data-settings-tab-trigger="network"]').attributes('aria-selected')).toBe('true')
    expect(wrapper.get('.ports-card').attributes('data-state')).toBe('open')
    await vi.waitFor(() => expect(document.activeElement).toBe(port.element))
    wrapper.unmount()
  })

  it('says what is wrong under the invalid field itself, not in a browser bubble', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    useConsoleStore().runtimeStatus = 'ready'
    vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
      if (String(input) === '/api/system/settings' && !init?.method) return Response.json({ configured, active: configured })
      return Response.json({}, { status: 503 })
    }))
    const bubble = vi.spyOn(HTMLInputElement.prototype, 'reportValidity')
    const wrapper = mount(SettingsPage, { global: { plugins: [pinia, settingsRouter()] }, attachTo: document.body })
    await flushPromises()
    const port = wrapper.get('.ports-card').get<HTMLInputElement>('input')
    await port.setValue('')
    await wrapper.get('#settings-form').trigger('submit')
    await flushPromises()
    await vi.waitFor(() => expect(document.activeElement).toBe(port.element))
    expect(bubble).not.toHaveBeenCalled()
    const message = wrapper.get('[data-settings-field-error]')
    expect(message.text()).toBe('请填写这一项')
    expect(port.attributes('aria-describedby')).toBe(message.attributes('id'))
    expect(port.attributes('aria-invalid')).toBe('true')
    // The bottom note stays as well.
    expect(wrapper.get('[data-settings-savebar]').text()).toContain('请先修正「管理界面」再保存')
    // A port out of range names the range.
    await port.setValue('70000')
    expect(wrapper.find('[data-settings-field-error]').exists()).toBe(false)
    expect(port.attributes('aria-invalid')).toBeUndefined()
    await wrapper.get('#settings-form').trigger('submit')
    await flushPromises()
    await vi.waitFor(() => expect(wrapper.get('[data-settings-field-error]').text()).toBe('请填写 1 到 65535 之间的数字'))
    wrapper.unmount()
  })

  it('locks settings and the shared save state until a pending save finishes, rejecting repeat submits', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useConsoleStore()
    store.runtimeStatus = 'ready'
    let finish!: (value: Response) => void
    let saves = 0
    vi.stubGlobal('fetch', vi.fn(async (input, init) => {
      if (String(input) === '/api/system/settings' && init?.method === 'PUT') {
        saves += 1
        return new Promise<Response>(resolve => { finish = resolve })
      }
      if (String(input) === '/api/system/settings') return Response.json({ configured, active: configured })
      return Response.json({}, { status: 503 })
    }))
    const wrapper = mount(SettingsPage, { global: { plugins: [pinia, settingsRouter()] } })
    await flushPromises()
    await wrapper.get('#settings-form').trigger('submit')
    await wrapper.get('#settings-form').trigger('submit')
    expect(saves).toBe(1)
    expect(wrapper.get('[data-settings-save]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('.settings-fields').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-settings-savebar] .growth-loading').attributes('aria-label')).toContain('正在保存运行设置')
    finish(Response.json({ configured, active: configured }))
    await flushPromises()
    expect(wrapper.get('[data-settings-save]').attributes('disabled')).toBeUndefined()
    expect(store.feedback).toEqual({ tone: 'success', message: '设置已保存并生效' })
    expect(wrapper.get('.settings-fields').attributes('disabled')).toBeUndefined()
    expect(wrapper.find('.growth-loading--inline').exists()).toBe(false)
    wrapper.unmount()
  })

  it('renders resource responses including native and unknown labels without translation warnings', async () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useConsoleStore()
    store.runtimeStatus = 'ready'
    store.state = {
      mode: 'personal_only',
      personalSpaces: [],
      projects: [],
      subscriptions: [],
      capturePolicy: { enabled: true },
      agentAccessPolicy: { enabled: true },
    }
    const requests: Array<{ url: string; init?: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      requests.push({ url, init })
      if (url === '/api/system/settings' && init?.method === 'PUT') {
        const next = JSON.parse(String(init.body))
        return Response.json({ configured: next, active: next, restartRequired: false })
      }
      if (url === '/api/system/settings') {
        return Response.json({ configured, active: configured, restartRequired: false })
      }
      if (url === '/api/system/resources') {
        return Response.json({
          sampledAt: '2026-08-01T10:00:00.000Z',
          status: 'ready',
          memory: {
            usedBytes: 1_073_741_824,
            hostTotalBytes: 16_000_000_000,
            hostFreeBytes: 8_000_000_000,
            complete: true,
            components: [
              { id: 'console', label: 'Management service', status: 'ready', bytes: 40_000_000 },
              { id: 'personal-neo4j', label: 'Personal Neo4j', status: 'ready', bytes: 900_000_000 },
              { id: 'synthetic-extension', label: 'Synthetic extension', status: 'ready', bytes: 1 },
            ],
          },
          disk: {
            usedBytes: 2_700_000_000,
            hostTotalBytes: 500_000_000_000,
            hostFreeBytes: 200_000_000_000,
            complete: true,
            measuredAt: '2026-08-01T10:00:00.000Z',
            temporaryBytes: 800_000_000,
            components: [
              { id: 'neo4jData', label: 'Neo4j data', status: 'ready', bytes: 500_000_000 },
            ],
          },
          exclusions: ['browser-tab-memory'],
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    }))

    const wrapper = mount(SettingsPage, { global: { plugins: [pinia, settingsRouter()] } })
    await flushPromises()

    expect(wrapper.text()).toContain('资源占用')
    expect(wrapper.text()).toContain('1.00 GiB')
    expect(wrapper.text()).toContain('个人 Neo4j')
    expect(wrapper.text()).toContain('Synthetic extension')
    expect(warnings).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('硬盘更新于')
    expect(wrapper.findAll('.port-grid input')).toHaveLength(4)
    expect(wrapper.get('.development-section').text()).toContain('开发中')
    expect(wrapper.get('.development-section').text()).toContain('fuli-server')
    // One save area, at the end of the form, submitting it.
    expect(wrapper.findAll('[data-settings-save]')).toHaveLength(1)
    expect(wrapper.get('[data-settings-savebar] [data-settings-save]').attributes('type')).toBe('submit')
    expect(wrapper.findAll('.select-row > select')).toHaveLength(0)
    expect(wrapper.findAll('.settings-select [role="combobox"]')).toHaveLength(3)
    expect(wrapper.findAll('.conversation-launcher-row')).toHaveLength(7)
    expect(wrapper.get('.conversation-launcher-card').text()).toContain('会话打开方式')

    const claudeLauncher = wrapper
      .findAll('.conversation-launcher-row')
      .find((row) => row.text().includes('Claude') && !row.text().includes('Claude Code'))
    expect(claudeLauncher).toBeDefined()
    expect(claudeLauncher?.get('[role="switch"]').attributes('aria-checked')).toBe('false')

    const cursorLauncher = wrapper
      .findAll('.conversation-launcher-row')
      .find((row) => row.text().includes('Cursor'))
    expect(cursorLauncher).toBeDefined()
    await cursorLauncher?.get('[role="switch"]').trigger('click')
    const cursorInputs = cursorLauncher?.findAll('input[type="text"]') ?? []
    expect(cursorInputs).toHaveLength(2)
    await cursorInputs[1]?.setValue('cursor://conversation/{id}')

    const refreshSelect = wrapper.get('[data-select-id="settings-refresh-interval"]')
    await refreshSelect.get('[role="combobox"]').trigger('click')
    const tenSecondOption = refreshSelect
      .findAll('[role="option"]')
      .find((option) => option.text() === '10 秒')
    expect(tenSecondOption).toBeDefined()
    await tenSecondOption?.trigger('click')

    expect(wrapper.text()).toContain('推荐原生模式')
    const runtimeSelect = wrapper.get('[data-select-id="settings-runtime-mode"]')
    await runtimeSelect.get('[role="combobox"]').trigger('click')
    const nativeOption = runtimeSelect
      .findAll('[role="option"]')
      .find((option) => option.text() === '原生（低内存）')
    expect(nativeOption).toBeDefined()
    await nativeOption?.trigger('click')

    await wrapper.get('input[type="number"]').setValue(3030)
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    const savedRequest = requests.find(({ init }) => init?.method === 'PUT')
    expect(JSON.parse(String(savedRequest?.init?.body)).ports.console).toBe(3030)
    expect(JSON.parse(String(savedRequest?.init?.body)).resourceRefreshSeconds).toBe(10)
    expect(JSON.parse(String(savedRequest?.init?.body)).graphRuntimeMode).toBe('native')
    expect(JSON.parse(String(savedRequest?.init?.body)).conversationLaunchers.cursor).toEqual({
      enabled: true,
      idFormat: 'any',
      appName: 'Cursor',
      urlTemplate: 'cursor://conversation/{id}',
    })
    expect(store.feedback?.message).toContain('设置已保存并生效')
    expect(wrapper.text()).not.toContain('需要重启')
    wrapper.unmount()
  })
  it('says when a change still needs saving, and keeps unsaved edits when switching tabs', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    useConsoleStore().runtimeStatus = 'ready'
    vi.stubGlobal('fetch', vi.fn(async (input, init?: RequestInit) => {
      if (String(input) === '/api/system/settings' && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body))
        return Response.json({ configured: body, active: body, restartRequired: false })
      }
      if (String(input) === '/api/system/settings') return Response.json({ configured, active: configured, restartRequired: false })
      return Response.json({}, { status: 503 })
    }))
    const router = settingsRouter()
    const wrapper = mount(SettingsPage, { global: { plugins: [pinia, router] } })
    await flushPromises()
    const status = () => wrapper.get('[data-settings-savebar] [role="status"]').text()
    expect(status()).toBe('')
    await wrapper.get('[data-settings-tab="network"] [role="switch"]').trigger('click')
    expect(status()).toBe('有未保存的更改')
    await wrapper.get('[data-settings-tab-trigger="system"]').trigger('mousedown')
    await flushPromises()
    expect(router.currentRoute.value.query.tab).toBe('system')
    expect(status()).toBe('有未保存的更改')
    await wrapper.get('#settings-form').trigger('submit')
    await flushPromises()
    expect(status()).toBe('已保存')
    wrapper.unmount()
  })

  it('switches capture per client while the clients keep reading memory', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useConsoleStore()
    store.runtimeStatus = 'ready'
    store.state = { mode: 'personal_only', activePersonalSpaceId: 'personal-1',
      personalSpaces: [{ id: 'personal-1', name: '我' }], personalProjects: [], projects: [], subscriptions: [],
      capturePolicy: { enabled: true, disabledSources: ['codex'] }, agentAccessPolicy: { enabled: true },
      capabilities: { browsePublicProjects: false, submitKnowledge: false, reviewProposals: false } } as never
    const update = vi.spyOn(store, 'updateCapturePolicy').mockResolvedValue(undefined)
    vi.stubGlobal('fetch', vi.fn(async (input) => {
      if (String(input) === '/api/system/settings') return Response.json({ configured, active: configured, restartRequired: false })
      return Response.json({}, { status: 503 })
    }))
    const wrapper = mount(SettingsPage, { global: { plugins: [pinia, settingsRouter()] } })
    await flushPromises()
    const codex = wrapper.get('[data-capture-source="codex"] [role="switch"]')
    const claude = wrapper.get('[data-capture-source="claude_code"] [role="switch"]')
    expect(codex.attributes('aria-checked')).toBe('false')
    expect(claude.attributes('aria-checked')).toBe('true')
    await claude.trigger('click')
    expect(update).toHaveBeenLastCalledWith(true, { disabledSources: ['codex', 'claude_code'], capturedSources: [] })
    await codex.trigger('click')
    expect(update).toHaveBeenLastCalledWith(true, { disabledSources: [], capturedSources: ['codex'] })
    store.state = { ...(store.state as ConsoleState), capturePolicy: { enabled: true, disabledSources: ['other'] } }
    await flushPromises()
    const opencode = wrapper.get('[data-capture-source="opencode"] [role="switch"]')
    expect(opencode.attributes('aria-checked')).toBe('false')
    await opencode.trigger('click')
    expect(update).toHaveBeenLastCalledWith(true, { disabledSources: ['other'], capturedSources: ['opencode'] })
    store.state = { ...store.state!, capturePolicy: { enabled: true, disabledSources: ['other'], capturedSources: ['opencode'] } }
    await flushPromises()
    expect(opencode.attributes('aria-checked')).toBe('true')
    await opencode.trigger('click')
    expect(update).toHaveBeenLastCalledWith(true, { disabledSources: ['other', 'opencode'], capturedSources: [] })
    wrapper.unmount()
  })

  it('answers from confirmed knowledge by default and lets the person require file checks', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useConsoleStore()
    store.runtimeStatus = 'ready'
    store.state = { mode: 'personal_only', activePersonalSpaceId: 'personal-1',
      personalSpaces: [{ id: 'personal-1', name: '我' }], personalProjects: [], projects: [], subscriptions: [],
      capturePolicy: { enabled: true }, agentAccessPolicy: { enabled: true },
      capabilities: { browsePublicProjects: false, submitKnowledge: false, reviewProposals: false } } as never
    const update = vi.spyOn(store, 'updateRecallPolicy').mockResolvedValue(undefined)
    vi.stubGlobal('fetch', vi.fn(async (input) => {
      if (String(input) === '/api/system/settings') return Response.json({ configured, active: configured, restartRequired: false })
      return Response.json({}, { status: 503 })
    }))
    const wrapper = mount(SettingsPage, { global: { plugins: [pinia, settingsRouter()] } })
    await flushPromises()
    const toggle = wrapper.get('[data-recall-answer-from-confirmed] [role="switch"]')
    expect(toggle.attributes('aria-checked')).toBe('true')
    await toggle.trigger('click')
    expect(update).toHaveBeenLastCalledWith(false)
    wrapper.unmount()
  })
})
