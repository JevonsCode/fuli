import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ getJson: vi.fn(), putJson: vi.fn() }))
vi.mock('@/api/client', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/api/client')>(), getJson: api.getJson, putJson: api.putJson,
}))

import { ApiError } from '@/api/client'
import { useConsoleStore } from '@/stores/console'
import { UiSelectStub } from '@/test-support/UiSelectStub'
import ModelSettingsPage from './ModelSettingsPage.vue'

// Synthetic settings and usage only; no real key, model or data directory.
const REVISION = 'a'.repeat(64)
const roles = (overrides: Record<string, unknown> = {}) => ({
  state: 'ok', error: null, revision: REVISION,
  connections: { 'local-qwen': { protocol: 'openai_chat', endpoint: 'http://127.0.0.1:11434/v1', model: 'qwen-test',
    secretRef: 'local-ref', reasoningEffort: 'none', pricing: null } },
  roles: [
    { role: 'assistant', state: 'not_configured', answeredBy: 'current_session' },
    { role: 'bole', state: 'not_configured', answeredBy: 'current_session' },
    { role: 'jefa', state: 'not_configured', answeredBy: 'current_session' },
    { role: 'tonborg', state: 'enabled', answeredBy: 'model_api',
      connection: { id: 'local-qwen', protocol: 'openai_chat', endpointHost: '127.0.0.1:11434', model: 'qwen-test', secretRef: 'local-ref' },
      allowedOperations: ['knowledge_review'], egress: { approvedProjects: [{ personalSpaceId: 'space-1', personalProjectId: 'alpha' }], allowUnassigned: false },
      budget: { maxInputTokens: 4000, maxOutputTokens: 400, timeoutMs: 30_000, windowHours: 24, maxTokensPerWindow: 100_000, maxCostPerWindow: null },
      fallbackToSession: true },
  ],
  operations: { tonborg: ['knowledge_review'] },
  workPackages: [],
  ...overrides,
})
const usage = () => ({ groups: [
  { role: 'tonborg', provider: 'openai_chat@127.0.0.1:11434', model: 'qwen-test', actualModels: ['qwen-test'], channel: 'model_api',
    requests: 2, attempts: 3, failedAttempts: 1, tokens: { input: { reported: 1200, unknownAttempts: 1 }, output: { reported: null, unknownAttempts: 3 },
      total: { reported: null, unknownAttempts: 3 } }, estimatedCost: null },
  { role: 'bole', provider: null, model: null, actualModels: [], channel: 'session', requests: 1, attempts: 1, failedAttempts: 0,
    tokens: { input: { reported: null, unknownAttempts: 1 }, output: { reported: null, unknownAttempts: 1 }, total: { reported: null, unknownAttempts: 1 } },
    estimatedCost: null },
] })

let rolesPayload = roles()
beforeEach(() => {
  setActivePinia(createPinia())
  const store = useConsoleStore()
  store.runtimeStatus = 'ready'
  store.state = { personalProjects: [
    { project_id: 'alpha', personal_space_id: 'space-1', scope_type: 'registered', profile: { name: 'Alpha 项目' } },
    { project_id: 'beta', personal_space_id: 'space-1', scope_type: 'registered', profile: { name: 'Beta 项目' } },
  ] } as never
  rolesPayload = roles()
  api.getJson.mockReset()
  api.putJson.mockReset()
  api.getJson.mockImplementation(async (url: string) => (url.startsWith('/api/model-backends/usage') ? usage() : rolesPayload))
})

const mountPage = async () => {
  const wrapper = mount(ModelSettingsPage, { attachTo: document.body,
    global: { stubs: { RouterLink: true, UiSelect: UiSelectStub } } })
  await flushPromises()
  return wrapper
}

describe('ModelSettingsPage', () => {
  it('shows each built-in Agent with its model, key reference and limits, never a key', async () => {
    const wrapper = await mountPage()
    expect(wrapper.findAll('[data-model-role]').map(card => card.find('h2').text())).toEqual(['Astro', 'Bole', 'Jefa', 'Tonborg'])
    const tonborg = wrapper.get('[data-model-role="tonborg"]')
    expect(tonborg.get('[data-model-role-state]').text()).toBe('已启用')
    expect(tonborg.get('[data-model-fact="secretRef"]').text()).toContain('local-ref')
    expect(tonborg.get('[data-model-fact="egress"]').text()).toContain('1 个项目')
    expect(tonborg.get('[data-model-fact="callBudget"]').text()).toContain('输入 4,000 · 输出 400 tokens · 30 秒')
    expect(tonborg.get('[data-model-fact="fallback"]').text()).toContain('允许')
    // No gate fact until the server sends one (#283).
    expect(tonborg.find('[data-model-fact="gate"]').exists()).toBe(false)
    expect(wrapper.get('[data-model-role="assistant"]').get('[data-model-fact="answeredBy"]').text()).toContain('当前会话')
  })

  it('shows the review gate read-only when the server reports it', async () => {
    rolesPayload = roles()
    ;(rolesPayload.roles[3] as Record<string, unknown>).reviewGate = { status: 'suggestion_only' }
    const wrapper = await mountPage()
    expect(wrapper.get('[data-model-role="tonborg"] [data-model-fact="gate"]').text()).toContain('仅建议')
  })

  it('edits a role in a labelled form and saves it with the revision it read', async () => {
    const saved = roles()
    api.putJson.mockResolvedValue(saved)
    const wrapper = await mountPage()
    await wrapper.get('[data-model-role="tonborg"] [data-model-role-edit]').trigger('click')
    expect(wrapper.get('[data-model-role="tonborg"]').classes()).toContain('shadow-md')
    const dialog = wrapper.get('[data-model-role-dialog]')
    expect(dialog.get('[data-model-secret-ref]').attributes('id')).toBe('model-role-secret-ref')
    expect(dialog.find('label[for="model-role-secret-ref"]').text()).toBe('密钥引用')
    expect(dialog.text()).toContain('已接入：knowledge_review')
    await dialog.get('[data-model-name]').setValue('qwen-next')
    await dialog.get('[data-model-budget="maxOutputTokens"]').setValue('800')
    await dialog.get('form').trigger('submit')
    await flushPromises()

    const [url, body] = api.putJson.mock.calls[0]
    expect(url).toBe('/api/model-backends/roles/tonborg')
    expect(body.revision).toBe(REVISION)
    expect(body.connection).toMatchObject({ model: 'qwen-next', secretRef: 'local-ref' })
    expect(body.settings.budget.maxOutputTokens).toBe(800)
    expect(body.settings.egress.approvedProjects).toEqual([{ personalSpaceId: 'space-1', personalProjectId: 'alpha' }])
    expect(wrapper.find('[data-model-role-dialog]').exists()).toBe(false)
    expect(wrapper.text()).toContain('已保存 Tonborg 的模型设置。')
  })

  it('reads the settings again when they changed meanwhile, and shows a refusal in the form', async () => {
    const wrapper = await mountPage()
    await wrapper.get('[data-model-role="bole"] [data-model-role-edit]').trigger('click')
    api.putJson.mockRejectedValueOnce(new ApiError('bad', 400, JSON.stringify({ error: 'roles.bole.budget.maxInputTokens must be a positive integer' })))
    await wrapper.get('[data-model-role-dialog] form').trigger('submit')
    await flushPromises()
    expect(wrapper.get('[data-model-role-dialog] [role="alert"]').text()).toContain('maxInputTokens')

    api.putJson.mockRejectedValueOnce(new ApiError('changed', 409, JSON.stringify({ error: 'changed', code: 'model_config_changed' })))
    const reads = api.getJson.mock.calls.length
    await wrapper.get('[data-model-role-dialog] form').trigger('submit')
    await flushPromises()
    expect(wrapper.find('[data-model-role-dialog]').exists()).toBe(false)
    expect(wrapper.get('[data-model-stale]').text()).toContain('没有保存')
    expect(api.getJson.mock.calls.length).toBeGreaterThan(reads)
  })

  it('shows usage by role and model with 未上报 counts, and session fallbacks apart', async () => {
    const wrapper = await mountPage()
    const model = wrapper.get('[data-usage-list="model"]')
    expect(model.text()).toContain('Tonborg')
    expect(model.text()).toContain('2 次 · 3 次尝试')
    expect(model.get('[data-usage-cell="input"] dd').text()).toBe('1,200（另 1 次未上报）')
    // The note wraps as a whole, never inside 未上/报.
    expect(model.get('[data-usage-cell="input"] .model-usage-note').text()).toBe('（另 1 次未上报）')
    expect(model.get('[data-usage-cell="output"]').text()).toContain('未上报 · 3 次')
    expect(model.get('[data-usage-cell="cost"]').text()).toContain('未上报 · 3 次')
    expect(model.text()).not.toMatch(/(^|\s)0(\s|$)/)
    const session = wrapper.get('[data-usage-list="session"]')
    expect(session.get('h3').text()).toBe('回到当前会话')
    expect(session.text()).toContain('客户端上报')
    expect(session.get('[data-usage-cell="input"]').text()).toContain('未上报 · 1 次')

    await wrapper.get('[data-value="today"]').trigger('click')
    await flushPromises()
    expect(api.getJson.mock.calls.filter(([url]) => String(url).startsWith('/api/model-backends/usage')).length).toBe(2)
  })

  it('names its pending reads with GrowthLoading', async () => {
    api.getJson.mockImplementation(() => new Promise(() => {}))
    const wrapper = mount(ModelSettingsPage, { attachTo: document.body, global: { stubs: { RouterLink: true } } })
    await flushPromises()
    expect(wrapper.get('[role="status"]').attributes('aria-label')).toBe('正在读取内置 Agent 的模型设置…')
  })
})
