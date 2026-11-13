import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'

import { setLocale } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import type { ConsoleState } from '@/types'
import { DEFAULT_CONVERSATION_LAUNCHERS } from '@/features/knowledge/source-adapters'
import { tour } from '@/features/onboarding-tour/onboarding-tour'
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

  it('gives each subject one tab, starting with what gets recorded', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    useConsoleStore().runtimeStatus = 'ready'
    vi.stubGlobal('fetch', vi.fn(async (input) => String(input) === '/api/system/settings'
      ? Response.json({ configured, active: configured, restartRequired: false })
      : Response.json({}, { status: 503 })))
    const wrapper = mount(SettingsPage, { global: { plugins: [pinia, settingsRouter()] } })
    await flushPromises()
    expect(wrapper.findAll('[data-settings-tab-trigger]').map(tab => [tab.attributes('data-settings-tab-trigger'), tab.text()])).toEqual([
      ['recording', '记录'], ['ai', 'AI 能做什么'], ['clients', '客户端'], ['connections', '连接'], ['system', '系统']])
    expect(wrapper.get('[data-settings-tab="recording"]').attributes('hidden')).toBeUndefined()
    const tab = (id: string) => wrapper.get(`[data-settings-tab="${id}"]`)
    expect(tab('recording').find('[data-capture-projects-card]').exists()).toBe(true)
    expect(tab('ai').find('[data-agent-delegation-settings]').exists()).toBe(true)
    expect(tab('ai').find('[data-recall-answer-from-confirmed]').exists()).toBe(true)
    // The clients' status comes first; connecting by hand and the other ways in sit below, open.
    expect(tab('clients').get('.settings-card').attributes('data-client-connection')).toBeDefined()
    expect(tab('clients').get('[data-clients-more]').find('[data-client-manual-connection]').exists()).toBe(true)
    expect(tab('clients').get('[data-clients-more]').find('[data-client-links-settings]').exists()).toBe(true)
    expect(tab('connections').find('[data-local-graph]').exists()).toBe(true)
    expect(tab('connections').find('#external-knowledge').exists()).toBe(true)
    expect(tab('connections').find('.ports-card').exists()).toBe(true)
    expect(tab('system').find('[data-version-settings]').exists()).toBe(true)
    expect(tab('system').find('[data-diagnostics-card]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('links to Tonborg\'s standards and to the models instead of showing them', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useConsoleStore()
    store.runtimeStatus = 'ready'
    store.state = { mode: 'connected', activePersonalSpaceId: 'space-a', personalSpaces: [{ id: 'space-a', name: '我' }], personalProjects: [], projects: [], subscriptions: [] } as never
    const fetchSettings = vi.fn(async (input: unknown) => String(input) === '/api/system/settings'
      ? Response.json({ configured, active: configured, restartRequired: false })
      : Response.json({}, { status: 503 }))
    vi.stubGlobal('fetch', fetchSettings)
    const wrapper = mount(SettingsPage, { global: { plugins: [pinia, settingsRouter()] } })
    await flushPromises()

    expect(wrapper.get('[data-open-judgment-standards]').attributes('href')).toBe('/employees/tonborg?view=standards')
    expect(wrapper.get('[data-open-model-settings]').attributes('href')).toBe('/models')
    expect(wrapper.get('[data-open-model-settings]').text()).toBe('模型与用量')
    expect(wrapper.find('#settings-models-title').exists()).toBe(false)
    expect(wrapper.find('.judgment-policy-fields').exists()).toBe(false)
    expect(fetchSettings.mock.calls.some(([url]) => String(url).startsWith('/api/judgment/'))).toBe(false)
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
    // A search looks through every tab, not only the open one.
    expect(wrapper.get('[data-settings-tab="connections"]').attributes('hidden')).toBeUndefined()
    expect(wrapper.get('.behavior-card').attributes('data-search-hidden')).toBe('')
    await search.setValue('zzz-no-such-setting')
    await flushPromises()
    expect(wrapper.get('.settings-search-empty').text()).toContain('zzz-no-such-setting')
    await search.setValue('')
    await flushPromises()
    expect(wrapper.findAll('[data-search-hidden]')).toHaveLength(0)
    expect(wrapper.get('[data-settings-tab="connections"]').attributes('hidden')).toBeDefined()
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

  it('turns the clients\' /fla menu off at once, and saves the console language for it', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    useConsoleStore().runtimeStatus = 'ready'
    const current = { ...configured, flaSlashMenu: true, consoleLanguage: '' as const }
    const puts: Array<typeof current> = []
    vi.stubGlobal('fetch', vi.fn(async (input, init?: RequestInit) => {
      if (String(input) === '/api/system/settings' && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body))
        puts.push(body)
        return Response.json({ configured: body, active: body, restartRequired: false })
      }
      if (String(input) === '/api/system/settings') return Response.json({ configured: current, active: current, restartRequired: false })
      return Response.json({}, { status: 503 })
    }))
    const wrapper = mount(SettingsPage, { global: { plugins: [pinia, settingsRouter()] } })
    await flushPromises()
    const card = wrapper.get('[data-fla-slash-menu-card]')
    expect(card.text()).toContain('/fla')
    await card.get('[role="switch"]').trigger('click')
    await flushPromises()
    expect(puts.at(-1)!.flaSlashMenu).toBe(false)
    await chooseOption(wrapper, 'settings-language', 'English')
    await flushPromises()
    expect(puts.at(-1)!.consoleLanguage).toBe('en-US')
    wrapper.unmount()
    setLocale('zh-CN', { persist: false })
  })

  it('leaves the FLA naming preference to the person\'s home page', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    useConsoleStore().runtimeStatus = 'ready'
    const withStyle = { ...configured, agentNamingStyle: '用两个字的植物名' }
    vi.stubGlobal('fetch', vi.fn(async (input) => {
      if (String(input) === '/api/system/settings') return Response.json({ configured: withStyle, active: withStyle, restartRequired: false })
      return Response.json({}, { status: 503 })
    }))
    const wrapper = mount(SettingsPage, { global: { plugins: [pinia, settingsRouter()] } })
    await flushPromises()
    expect(wrapper.find('#settings-form').exists()).toBe(true)
    expect(wrapper.find('[data-agent-naming-style]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('取名')
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
    await wrapper.get('[data-settings-tab="connections"] [role="switch"]').trigger('click')
    await flushPromises()
    expect(puts).toHaveLength(0)
    expect(wrapper.get('[data-settings-tab="connections"] [data-settings-restart-notice]').text()).toContain('重启 FULI 才生效')

    // A port left empty is not sent and says why when the person applies.
    const port = wrapper.get<HTMLInputElement>('.port-grid input')
    await port.setValue('')
    await wrapper.get('[data-settings-tab="connections"] [data-settings-restart-apply]').trigger('click')
    await flushPromises()
    expect(puts).toHaveLength(0)
    expect(wrapper.get('.port-grid [data-settings-field-error]').text()).toBe('请填写这一项')
    expect(wrapper.get('[data-settings-tab="connections"] [data-settings-restart-notice]').text()).toContain('有一项填写不对')
    await port.setValue('70000')
    await wrapper.get('[data-settings-tab="connections"] [data-settings-restart-apply]').trigger('click')
    await flushPromises()
    expect(wrapper.get('.port-grid [data-settings-field-error]').text()).toBe('请填写 1 到 65535 之间的数字')

    // Other settings still save themselves, with the restart settings as FULI runs now.
    await port.setValue(3030)
    await wrapper.get('[data-settings-tab-trigger="system"]').trigger('mousedown')
    await flushPromises()
    expect(router.currentRoute.value.query.tab).toBe('system')
    await chooseOption(wrapper, 'settings-refresh-interval', '10 秒')
    expect(puts).toHaveLength(1)
    expect(puts[0]).toMatchObject({ resourceRefreshSeconds: 10, lanAccess: false, graphRuntimeMode: 'container' })
    expect(puts[0]!.ports.console).toBe(2727)
    // A Docker graph is moved by the migration, never switched here (src/system/graph-migration.js).
    expect(wrapper.find('[data-graph-migration]').exists()).toBe(true)
    expect(wrapper.find('[data-select-id="settings-runtime-mode"]').exists()).toBe(false)

    await wrapper.get('[data-settings-tab-trigger="connections"]').trigger('mousedown')
    await flushPromises()
    await wrapper.get('[data-settings-tab="connections"] [data-settings-restart-apply]').trigger('click')
    await flushPromises()
    expect(puts).toHaveLength(2)
    expect(puts[1]).toMatchObject({ resourceRefreshSeconds: 10, lanAccess: true, graphRuntimeMode: 'container' })
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
    expect(wrapper.text()).toContain('1 GB')
    expect(wrapper.text()).toContain('个人 Neo4j')
    expect(wrapper.text()).toContain('Synthetic extension')
    expect(warnings).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('硬盘更新于')
    expect(wrapper.findAll('.port-grid input')).toHaveLength(4)
    // No placeholder for a public service: public projects were removed.
    expect(wrapper.find('.development-section').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('公共服务')
    expect(wrapper.findAll('.select-row > select')).toHaveLength(0)
    expect(wrapper.findAll('.settings-select [role="combobox"]')).toHaveLength(2)
    expect(wrapper.findAll('.conversation-launcher-row')).toHaveLength(7)
    expect(wrapper.get('.conversation-launcher-card').text()).toContain('会话打开方式')
    const claudeLauncher = wrapper
      .findAll('.conversation-launcher-row')
      .find((row) => row.text().includes('Claude') && !row.text().includes('Claude Code'))
    expect(claudeLauncher?.get('[role="switch"]').attributes('aria-checked')).toBe('false')
    wrapper.unmount()
  })

  it('offers no migration once the install already runs native', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    useConsoleStore().runtimeStatus = 'ready'
    const native = { ...configured, graphRuntimeMode: 'native' as const }
    vi.stubGlobal('fetch', vi.fn(async (input) => String(input) === '/api/system/settings'
      ? Response.json({ configured: native, active: native, restartRequired: false })
      : Response.json({}, { status: 503 })))
    const wrapper = mount(SettingsPage, { global: { plugins: [pinia, settingsRouter()] } })
    await flushPromises()
    expect(wrapper.find('[data-graph-migration]').exists()).toBe(false)
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

  it('starts the beginner\'s guide again from step 1 in 系统 › 界面, saving nothing', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    useConsoleStore().runtimeStatus = 'ready'
    const fetch = vi.fn(async (input) => String(input) === '/api/system/settings'
      ? Response.json({ configured, active: configured, restartRequired: false })
      : Response.json({}, { status: 503 }))
    vi.stubGlobal('fetch', fetch)
    Object.assign(tour, { open: false, paused: true, step: 3 })
    const wrapper = mount(SettingsPage, { global: { plugins: [pinia, settingsRouter()] } })
    await flushPromises()
    const requests = fetch.mock.calls.length
    const row = wrapper.get('[data-settings-tab="system"] [data-tour-show-again]')
    expect(row.text()).toBe('再看一遍')
    expect(row.element.closest('.setting-row')?.textContent).toContain('新手引导')
    await row.trigger('click')
    expect([tour.open, tour.paused, tour.step]).toEqual([true, false, 0])
    expect(fetch.mock.calls).toHaveLength(requests)
    Object.assign(tour, { open: false })
    wrapper.unmount()
  })

  it('shows every settings topic as its own open card, with no accordion or 高级 box', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    useConsoleStore().runtimeStatus = 'ready'
    const withNotifications = { ...configured, notifications: { needsPersonUrl: '' } }
    vi.stubGlobal('fetch', vi.fn(async (input) => {
      if (String(input) === '/api/system/settings') return Response.json({ configured: withNotifications, active: withNotifications, restartRequired: false })
      return Response.json({}, { status: 503 })
    }))
    const wrapper = mount(SettingsPage, { global: { plugins: [pinia, settingsRouter()] } })
    await flushPromises()
    expect(wrapper.find('details, [data-slot="accordion"], [data-slot="accordion-trigger"]').exists()).toBe(false)
    const titles = wrapper.findAll('.settings-card [data-slot="card-title"]').map(title => title.text())
    for (const title of ['会话链接', '会话打开方式', '通知', '服务端口']) expect(titles).toContain(title)
    expect(titles).not.toContain('高级')
    expect(new Set(titles).size).toBe(titles.length)
    // A launcher that is off shows only its name and switch.
    const claude = wrapper.findAll('.conversation-launcher-row').find((row) => row.text().includes('Claude') && !row.text().includes('Claude Code'))!
    expect(claude.find('.conversation-launcher-fields').exists()).toBe(false)
    wrapper.unmount()
  })

  it('opens a linked card in its tab, scrolls to it and marks it', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    useConsoleStore().runtimeStatus = 'ready'
    vi.stubGlobal('fetch', vi.fn(async (input) => {
      if (String(input) === '/api/system/settings') return Response.json({ configured, active: configured, restartRequired: false })
      return Response.json({}, { status: 503 })
    }))
    const scrolled: Element[] = []
    vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(function (this: HTMLElement) { scrolled.push(this) })
    window.history.replaceState(null, '', '/settings#conversation-launchers')
    const wrapper = mount(SettingsPage, { global: { plugins: [pinia, settingsRouter()] }, attachTo: document.body })
    await flushPromises()
    const launchers = wrapper.get('.conversation-launcher-card')
    expect(wrapper.get('[data-settings-tab="clients"]').attributes('hidden')).toBeUndefined()
    expect(scrolled).toEqual([launchers.element])
    expect(launchers.attributes('data-settings-linked')).toBe('')
    // Moving on to another tab clears the mark.
    await wrapper.get('[data-settings-tab-trigger="connections"]').trigger('mousedown', { button: 0 })
    await flushPromises()
    expect(launchers.attributes('data-settings-linked')).toBeUndefined()
    wrapper.unmount()
    window.history.replaceState(null, '', '/')
  })

  it('narrows a ?setting= link to its card and scrolls to it', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    useConsoleStore().runtimeStatus = 'ready'
    vi.stubGlobal('fetch', vi.fn(async (input) => {
      if (String(input) === '/api/system/settings') return Response.json({ configured, active: configured, restartRequired: false })
      return Response.json({}, { status: 503 })
    }))
    const scrolled: Element[] = []
    vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(function (this: HTMLElement) { scrolled.push(this) })
    window.history.replaceState(null, '', '/settings?setting=ports')
    const wrapper = mount(SettingsPage, { global: { plugins: [pinia, settingsRouter()] }, attachTo: document.body })
    await flushPromises()
    const ports = wrapper.get('.ports-card')
    expect(ports.attributes('data-search-hidden')).toBeUndefined()
    expect(scrolled).toEqual([ports.element])
    expect(ports.attributes('data-settings-linked')).toBe('')
    wrapper.unmount()
    window.history.replaceState(null, '', '/')
  })

  it('switches capture per client while the clients keep reading memory', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useConsoleStore()
    store.runtimeStatus = 'ready'
    store.state = { mode: 'personal_only', activePersonalSpaceId: 'personal-1',
      personalSpaces: [{ id: 'personal-1', name: '我' }], personalProjects: [], projects: [], subscriptions: [],
      capturePolicy: { enabled: true, disabledSources: ['codex'] }, agentAccessPolicy: { enabled: true } } as never
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

  it('shows a capture switch for each detected client and any turned off, after finding them', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useConsoleStore()
    store.runtimeStatus = 'ready'
    store.state = { mode: 'personal_only', activePersonalSpaceId: 'personal-1',
      personalSpaces: [{ id: 'personal-1', name: '我' }], personalProjects: [], projects: [], subscriptions: [],
      capturePolicy: { enabled: true, disabledSources: ['cursor'] }, agentAccessPolicy: { enabled: true } } as never
    const answers: Array<(response: Response) => void> = []
    vi.stubGlobal('fetch', vi.fn(async (input) => {
      if (String(input) === '/api/system/settings') return Response.json({ configured, active: configured, restartRequired: false })
      if (String(input) === '/api/system/client-connection/status') return new Promise<Response>(resolve => { answers.push(resolve) })
      return Response.json({}, { status: 503 })
    }))
    const wrapper = mount(SettingsPage, { global: { plugins: [pinia, settingsRouter()] } })
    await flushPromises()
    const card = wrapper.get('.behavior-card')
    expect(card.find('[data-capture-source]').exists()).toBe(false)
    expect(card.get('.growth-loading').attributes('aria-label')).toBe('正在查找本机的客户端…')
    const client = (id: string, status: string) => ({ id, label: id, status, detected: status !== 'not_detected', previouslyConnected: false, changes: [] })
    for (const answer of answers) answer(Response.json({ observedAt: '2026-11-02T08:00:00.000Z', historySaved: true, clients: [
      client('claude-code', 'connected'), client('codex', 'not_connected'),
      client('cursor', 'not_detected'), client('opencode', 'not_detected'), client('claude-desktop', 'connected')] }))
    await flushPromises()
    expect(card.find('.growth-loading').exists()).toBe(false)
    expect(card.findAll('[data-capture-source]').map(row => row.attributes('data-capture-source'))).toEqual(['claude_code', 'codex', 'cursor'])
    expect(card.get('[data-capture-source="cursor"] [role="switch"]').attributes('aria-checked')).toBe('false')
    wrapper.unmount()
  })

  it('keeps every capture switch, without a warning, when the clients cannot be read', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useConsoleStore()
    store.runtimeStatus = 'ready'
    store.state = { mode: 'personal_only', activePersonalSpaceId: 'personal-1',
      personalSpaces: [{ id: 'personal-1', name: '我' }], personalProjects: [], projects: [], subscriptions: [],
      capturePolicy: { enabled: true }, agentAccessPolicy: { enabled: true } } as never
    vi.stubGlobal('fetch', vi.fn(async (input) => {
      if (String(input) === '/api/system/settings') return Response.json({ configured, active: configured, restartRequired: false })
      return Response.json({}, { status: 503 })
    }))
    const wrapper = mount(SettingsPage, { global: { plugins: [pinia, settingsRouter()] } })
    await flushPromises()
    const card = wrapper.get('.behavior-card')
    expect(card.findAll('[data-capture-source]').map(row => row.attributes('data-capture-source')))
      .toEqual(['claude_code', 'codex', 'cursor', 'opencode', 'dsh'])
    expect(card.find('.ui-notice').exists()).toBe(false)
    expect(card.find('[role="alert"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('answers from confirmed knowledge by default and lets the person require file checks', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useConsoleStore()
    store.runtimeStatus = 'ready'
    store.state = { mode: 'personal_only', activePersonalSpaceId: 'personal-1',
      personalSpaces: [{ id: 'personal-1', name: '我' }], personalProjects: [], projects: [], subscriptions: [],
      capturePolicy: { enabled: true }, agentAccessPolicy: { enabled: true } } as never
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

  describe('two layouts to compare', () => {
    // jsdom has no matchMedia: a test says whether the window is wide enough for the topics on the left.
    function windowWide(wide: boolean) {
      vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: wide && query === '(min-width: 861px)', media: query,
        addEventListener: vi.fn(), removeEventListener: vi.fn() })))
    }

    async function mountSettings(path = '/settings') {
      const pinia = createPinia()
      setActivePinia(pinia)
      useConsoleStore().runtimeStatus = 'ready'
      vi.stubGlobal('fetch', vi.fn(async (input) => String(input) === '/api/system/settings'
        ? Response.json({ configured, active: configured, restartRequired: false })
        : Response.json({}, { status: 503 })))
      const router = settingsRouter()
      await router.push(path)
      const wrapper = mount(SettingsPage, { global: { plugins: [pinia, router] }, attachTo: document.body })
      await flushPromises()
      return wrapper
    }
    const outlineLabels = (wrapper: VueWrapper) => wrapper.findAll('[data-settings-outline-item]').map(item => item.text())
    const pressedLayout = (wrapper: VueWrapper) => wrapper.get('[data-settings-layout] [aria-pressed="true"]').attributes('data-value')

    it('opens with the tabs on top, and keeps the topics on the left once the person picks them', async () => {
      windowWide(true)
      const first = await mountSettings()
      expect(first.findAll('[data-settings-tab-trigger]')).toHaveLength(5)
      expect(first.find('[data-settings-side]').exists()).toBe(false)
      expect(pressedLayout(first)).toBe('tabs')
      await first.get('[data-settings-layout] [data-value="side"]').trigger('click')
      await flushPromises()
      expect(first.find('[data-settings-side]').exists()).toBe(true)
      expect(first.find('[data-settings-tab-trigger]').exists()).toBe(false)
      expect(first.get('[data-settings-topic="recording"]').attributes('aria-current')).toBe('true')
      first.unmount()

      const again = await mountSettings()
      expect(again.find('[data-settings-side]').exists()).toBe(true)
      expect(pressedLayout(again)).toBe('side')
      again.unmount()
    })

    it('opens a ?layout= link in that layout for the visit without keeping it', async () => {
      windowWide(true)
      const side = await mountSettings('/settings?layout=side')
      expect(side.find('[data-settings-side]').exists()).toBe(true)
      expect(window.localStorage.getItem('fuli.settings.layout')).toBeNull()
      side.unmount()
      window.localStorage.setItem('fuli.settings.layout', 'side')
      const tabs = await mountSettings('/settings?layout=tabs')
      expect(tabs.find('[data-settings-side]').exists()).toBe(false)
      expect(window.localStorage.getItem('fuli.settings.layout')).toBe('side')
      tabs.unmount()
    })

    it('outlines exactly the open topic\'s rendered cards on the left and scrolls to the one clicked', async () => {
      windowWide(true)
      const scrolled: Element[] = []
      vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(function (this: HTMLElement) { scrolled.push(this) })
      const wrapper = await mountSettings('/settings?layout=side')
      // No topic promotion in these settings: its card is not rendered, so it has no entry.
      expect(wrapper.find('[data-topic-promotion-card]').exists()).toBe(false)
      expect(outlineLabels(wrapper)).toEqual(['自动沉淀', '按项目记录'])
      expect(wrapper.get('[data-settings-outline-item][aria-current]').text()).toBe('自动沉淀')
      await wrapper.findAll('[data-settings-outline-item]')[1]!.trigger('click')
      expect(scrolled).toEqual([wrapper.get('[data-capture-projects-card]').element])
      expect(wrapper.get('[data-settings-outline-item][aria-current]').text()).toBe('按项目记录')

      await wrapper.get('[data-settings-topic="connections"]').trigger('click')
      await flushPromises()
      expect(wrapper.get('[data-settings-topic="connections"]').attributes('aria-current')).toBe('true')
      expect(wrapper.get('[data-settings-tab="connections"]').attributes('hidden')).toBeUndefined()
      const cards = wrapper.get('[data-settings-tab="connections"]').findAll('.settings-card')
      expect(outlineLabels(wrapper)).toHaveLength(cards.length)
      expect(outlineLabels(wrapper)).toContain('服务端口')
      expect(outlineLabels(wrapper)).not.toContain('自动沉淀')
      wrapper.unmount()
    })

    it('opens a linked card\'s topic on the left, scrolls to it and marks it', async () => {
      windowWide(true)
      const scrolled: Element[] = []
      vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(function (this: HTMLElement) { scrolled.push(this) })
      window.history.replaceState(null, '', '/settings#conversation-launchers')
      const wrapper = await mountSettings('/settings?layout=side')
      const launchers = wrapper.get('.conversation-launcher-card')
      expect(wrapper.get('[data-settings-topic="clients"]').attributes('aria-current')).toBe('true')
      expect(wrapper.get('[data-settings-tab="clients"]').attributes('hidden')).toBeUndefined()
      expect(scrolled).toEqual([launchers.element])
      expect(launchers.attributes('data-settings-linked')).toBe('')
      wrapper.unmount()
      window.history.replaceState(null, '', '/')
    })

    it('shows matches from every topic while searching on the left, with no outline under the topics', async () => {
      windowWide(true)
      const wrapper = await mountSettings('/settings?layout=side')
      expect(outlineLabels(wrapper).length).toBeGreaterThan(0)
      await wrapper.get('.settings-search input').setValue('Neo4j Bolt')
      await flushPromises()
      expect(wrapper.get('.ports-card').attributes('data-search-hidden')).toBeUndefined()
      expect(wrapper.get('[data-settings-tab="connections"]').attributes('hidden')).toBeUndefined()
      expect(wrapper.get('.behavior-card').attributes('data-search-hidden')).toBe('')
      expect(wrapper.find('.settings-search-note').exists()).toBe(true)
      expect(outlineLabels(wrapper)).toEqual([])
      await wrapper.get('.settings-search input').setValue('')
      await flushPromises()
      expect(outlineLabels(wrapper)).toEqual(['自动沉淀', '按项目记录'])
      wrapper.unmount()
    })

    it('shows the tabs on top in a narrow window, even when the topics on the left were chosen', async () => {
      windowWide(false)
      window.localStorage.setItem('fuli.settings.layout', 'side')
      const wrapper = await mountSettings()
      expect(wrapper.findAll('[data-settings-tab-trigger]')).toHaveLength(5)
      expect(wrapper.find('[data-settings-side]').exists()).toBe(false)
      // The choice does not apply here, so no switch offers it.
      expect(wrapper.find('[data-settings-layout]').exists()).toBe(false)
      wrapper.unmount()
    })
  })
})
