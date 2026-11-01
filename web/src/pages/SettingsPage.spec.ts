import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
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

// Picks an option the way the select reports it; reka-ui renders the list in a portal.
async function chooseOption(wrapper: VueWrapper, controlId: string, label: string) {
  const select = wrapper.findAllComponents({ name: 'OptionSelect' }).find((candidate) => candidate.props('controlId') === controlId)!
  const option = (select.props('options') as Array<{ value: string, label: string }>).find((candidate) => candidate.label === label)
  expect(option).toBeDefined()
  select.vm.$emit('update:modelValue', option!.value)
  await flushPromises()
}

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

  it('has no save button: a typed setting saves itself after a pause, and the capsule says so', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    useConsoleStore().runtimeStatus = 'ready'
    const withNotifications = { ...configured, notifications: { needsPersonUrl: '' } }
    const puts: Array<{ notifications: unknown }> = []
    vi.stubGlobal('fetch', vi.fn(async (input, init?: RequestInit) => {
      if (String(input) === '/api/system/settings' && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body))
        puts.push(body)
        return Response.json({ configured: body, active: body, restartRequired: false })
      }
      if (String(input) === '/api/system/settings') return Response.json({ configured: withNotifications, active: withNotifications, restartRequired: false })
      return Response.json({}, { status: 503 })
    }))
    const wrapper = mount(SettingsPage, { global: { plugins: [pinia, settingsRouter()] }, attachTo: document.body })
    await flushPromises()
    expect(wrapper.find('[data-settings-save]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('保存设置')
    expect(wrapper.find('[data-settings-save-capsule]').exists()).toBe(false)
    await wrapper.get('[data-needs-person-url]').setValue('http://127.0.0.1:9123/fuli')
    await flushPromises()
    // Still typing: nothing is sent yet.
    expect(puts).toHaveLength(0)
    await vi.waitFor(() => expect(puts).toHaveLength(1), { timeout: 2000 })
    expect(puts[0]!.notifications).toEqual({ needsPersonUrl: 'http://127.0.0.1:9123/fuli' })
    await vi.waitFor(() => expect(wrapper.get('[data-settings-save-capsule]').text()).toBe('已自动保存'))
    wrapper.unmount()
  })

  it('saves a switch at once, without waiting for a pause', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    useConsoleStore().runtimeStatus = 'ready'
    const puts: Array<typeof configured> = []
    vi.stubGlobal('fetch', vi.fn(async (input, init?: RequestInit) => {
      if (String(input) === '/api/system/settings' && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body))
        puts.push(body)
        return Response.json({ configured: body, active: body, restartRequired: false })
      }
      if (String(input) === '/api/system/settings') return Response.json({ configured, active: configured, restartRequired: false })
      return Response.json({}, { status: 503 })
    }))
    const wrapper = mount(SettingsPage, { global: { plugins: [pinia, settingsRouter()] } })
    await flushPromises()
    const codex = wrapper.findAll('.conversation-launcher-row').find((row) => row.text().includes('Codex'))!
    await codex.get('[role="switch"]').trigger('click')
    await flushPromises()
    expect(puts).toHaveLength(1)
    expect(puts[0]!.conversationLaunchers.codex.enabled).toBe(false)
    wrapper.unmount()
  })

  it('saves an edited Agent naming style and its restored default as no style', async () => {
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
    // Enter (the form's submit) saves at once instead of after the pause.
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    await wrapper.get('[data-agent-naming-reset]').trigger('click')
    expect(field.element.value).toContain('Lyra North')
    expect(wrapper.get('[data-agent-naming-reset]').attributes('disabled')).toBeDefined()
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(puts.map(body => body.agentNamingStyle)).toEqual(['像北欧神话里的名字', ''])
    expect(field.element.value).toContain('Lyra North')
    expect(wrapper.get('[data-settings-save-capsule]').text()).toBe('已自动保存')
    wrapper.unmount()
  })

  it('keeps the input after a failed save, says why in the capsule and retries', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    useConsoleStore().runtimeStatus = 'ready'
    let refuse = true
    const puts: Array<typeof configured> = []
    vi.stubGlobal('fetch', vi.fn(async (input, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body))
        puts.push(body)
        return refuse ? Response.json({ error: 'Synthetic refusal' }, { status: 400 }) : Response.json({ configured: body, active: body })
      }
      if (String(input) === '/api/system/settings') return Response.json({ configured, active: configured })
      return Response.json({}, { status: 503 })
    }))
    const wrapper = mount(SettingsPage, { global: { plugins: [pinia, settingsRouter()] } })
    await flushPromises()
    const cursor = wrapper.findAll('.conversation-launcher-row').find((row) => row.text().includes('Cursor'))!
    await cursor.get('[role="switch"]').trigger('click')
    await flushPromises()
    // Turned on without an address it cannot be saved: the field says why and nothing is sent.
    expect(puts).toHaveLength(0)
    const template = cursor.findAll<HTMLInputElement>('input[type="text"]')[1]!
    expect(template.attributes('aria-invalid')).toBe('true')
    expect(cursor.get('[data-settings-field-error]').text()).toBe('请填写这一项')
    expect(template.attributes('aria-describedby')).toBe(cursor.get('[data-settings-field-error]').attributes('id'))

    await template.setValue('cursor://conversation/{id}')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(puts).toHaveLength(1)
    expect(cursor.find('[data-settings-field-error]').exists()).toBe(false)
    const capsule = wrapper.get('[data-settings-save-capsule]')
    expect(capsule.attributes('data-state')).toBe('error')
    expect(capsule.get('[role="alert"]').text()).toBe('保存失败 · Synthetic refusal')
    // The person's input stays.
    expect(cursor.get('[role="switch"]').attributes('aria-checked')).toBe('true')
    expect(template.element.value).toBe('cursor://conversation/{id}')
    expect(wrapper.get('.settings-fields').attributes('disabled')).toBeUndefined()

    refuse = false
    await capsule.get('[data-settings-save-retry]').trigger('click')
    await flushPromises()
    expect(puts).toHaveLength(2)
    expect(puts[1]!.conversationLaunchers.cursor).toEqual({ enabled: true, idFormat: 'any', appName: 'Cursor', urlTemplate: 'cursor://conversation/{id}' })
    expect(wrapper.get('[data-settings-save-capsule]').text()).toBe('已自动保存')
    wrapper.unmount()
  })

  it('sends a change made during a save right after it, never locking the form', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    useConsoleStore().runtimeStatus = 'ready'
    let finish!: (value: Response) => void
    const puts: Array<typeof configured> = []
    vi.stubGlobal('fetch', vi.fn(async (input, init) => {
      if (String(input) === '/api/system/settings' && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body))
        puts.push(body)
        return new Promise<Response>(resolve => { finish = resolve })
      }
      if (String(input) === '/api/system/settings') return Response.json({ configured, active: configured })
      return Response.json({}, { status: 503 })
    }))
    const wrapper = mount(SettingsPage, { global: { plugins: [pinia, settingsRouter()] } })
    await flushPromises()
    await chooseOption(wrapper, 'settings-refresh-interval', '10 秒')
    expect(puts).toHaveLength(1)
    expect(wrapper.get('[data-settings-save-capsule] .growth-loading--inline').attributes('aria-label')).toBe('正在保存设置…')
    expect(wrapper.get('.settings-fields').attributes('disabled')).toBeUndefined()
    await chooseOption(wrapper, 'settings-refresh-interval', '30 秒')
    expect(puts).toHaveLength(1)
    finish(Response.json({ configured: puts[0], active: puts[0] }))
    await flushPromises()
    expect(puts.map(body => body.resourceRefreshSeconds)).toEqual([10, 30])
    finish(Response.json({ configured: puts[1], active: puts[1] }))
    await flushPromises()
    expect(wrapper.get('[data-settings-save-capsule]').text()).toBe('已自动保存')
    wrapper.unmount()
  })

  it('holds ports, LAN access and the runtime for 应用并重启, saving everything else meanwhile', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useConsoleStore()
    store.runtimeStatus = 'ready'
    const puts: Array<typeof configured> = []
    vi.stubGlobal('fetch', vi.fn(async (input, init?: RequestInit) => {
      if (String(input) === '/api/system/settings' && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body))
        puts.push(body)
        return Response.json({ configured: body, active: body, restartRequired: false })
      }
      if (String(input) === '/api/system/settings') return Response.json({ configured, active: configured, restartRequired: false })
      return Response.json({}, { status: 503 })
    }))
    const router = settingsRouter()
    const wrapper = mount(SettingsPage, { global: { plugins: [pinia, router] }, attachTo: document.body })
    await flushPromises()
    expect(wrapper.find('[data-settings-restart-notice]').exists()).toBe(false)
    await wrapper.get('[data-settings-tab="network"] [role="switch"]').trigger('click')
    await flushPromises()
    expect(puts).toHaveLength(0)
    expect(wrapper.get('[data-settings-tab="network"] [data-settings-restart-notice]').text()).toContain('重启 FULI 才生效')

    // A port left empty is not sent and says why when the person applies.
    const port = wrapper.get<HTMLInputElement>('.port-grid input')
    await port.setValue('')
    await wrapper.get('[data-settings-tab="network"] [data-settings-restart-apply]').trigger('click')
    await flushPromises()
    expect(puts).toHaveLength(0)
    expect(wrapper.get('.port-grid [data-settings-field-error]').text()).toBe('请填写这一项')
    expect(wrapper.get('[data-settings-tab="network"] [data-settings-restart-notice]').text()).toContain('有一项填写不对')
    await port.setValue('70000')
    await wrapper.get('[data-settings-tab="network"] [data-settings-restart-apply]').trigger('click')
    await flushPromises()
    expect(wrapper.get('.port-grid [data-settings-field-error]').text()).toBe('请填写 1 到 65535 之间的数字')

    // Other settings still save themselves, with the restart settings as FULI runs now.
    await port.setValue(3030)
    await wrapper.get('[data-settings-tab-trigger="system"]').trigger('mousedown')
    await flushPromises()
    expect(router.currentRoute.value.query.tab).toBe('system')
    await chooseOption(wrapper, 'settings-runtime-mode', '原生（低内存）')
    await chooseOption(wrapper, 'settings-refresh-interval', '10 秒')
    expect(puts).toHaveLength(1)
    expect(puts[0]).toMatchObject({ resourceRefreshSeconds: 10, lanAccess: false, graphRuntimeMode: 'container' })
    expect(puts[0]!.ports.console).toBe(2727)
    expect(wrapper.find('[data-settings-tab="system"] [data-settings-restart-notice]').exists()).toBe(true)

    await wrapper.get('[data-settings-tab="system"] [data-settings-restart-apply]').trigger('click')
    await flushPromises()
    expect(puts).toHaveLength(2)
    expect(puts[1]).toMatchObject({ resourceRefreshSeconds: 10, lanAccess: true, graphRuntimeMode: 'native' })
    expect(puts[1]!.ports.console).toBe(3030)
    expect(store.feedback?.message).toContain('设置已保存并生效')
    expect(wrapper.find('[data-settings-restart-notice]').exists()).toBe(false)
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
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
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
    expect(wrapper.findAll('.select-row > select')).toHaveLength(0)
    expect(wrapper.findAll('.settings-select [role="combobox"]')).toHaveLength(3)
    expect(wrapper.findAll('.conversation-launcher-row')).toHaveLength(7)
    expect(wrapper.get('.conversation-launcher-card').text()).toContain('会话打开方式')
    const claudeLauncher = wrapper
      .findAll('.conversation-launcher-row')
      .find((row) => row.text().includes('Claude') && !row.text().includes('Claude Code'))
    expect(claudeLauncher?.get('[role="switch"]').attributes('aria-checked')).toBe('false')
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
