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

// rec#10 D-36: Tonborg's trust as the roles route reports it.
const trust = (overrides: Record<string, unknown> = {}) => ({ operation: 'knowledge_review', suggestionsOnly: false, warningSeen: false,
  warningSeenAt: null, warningVersion: 1, revision: 0, status: 'automatic', reason: null, evaluation: null, ...overrides })

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
  api.getJson.mockImplementation(async (url: string) => (url.startsWith('/api/model-backends/usage') ? usage()
    : url.startsWith('/api/model-backends/suggestions') ? { suggestions: [] }
      : url.startsWith('/api/model-backends/history') ? { entries: [] } : rolesPayload))
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
    expect(wrapper.findAll('[data-model-role]').map(card => card.get('[data-model-role-name]').text())).toEqual(['Astro', 'Bole', 'Jefa', 'Tonborg'])
    const tonborg = wrapper.get('[data-model-role="tonborg"]')
    expect(tonborg.get('[data-model-role-state]').text()).toBe('已启用')
    expect(tonborg.get('[data-model-fact="secretRef"]').text()).toContain('local-ref')
    expect(tonborg.get('[data-model-fact="egress"]').text()).toContain('1 个项目')
    expect(tonborg.get('[data-model-fact="callBudget"]').text()).toContain('输入 4,000 · 输出 400 tokens · 30 秒')
    expect(tonborg.get('[data-model-fact="fallback"]').text()).toContain('允许')
    expect(wrapper.get('[data-model-role="assistant"]').get('[data-model-fact="answeredBy"]').text()).toContain('当前会话')
  })

  it('asks the person to read the warning before Tonborg\'s model executes by itself, and saves only that acknowledgement (D-36)', async () => {
    ;(rolesPayload.roles[3] as Record<string, unknown>).trust = trust({ status: 'suggestion', reason: 'warning_not_seen' })
    const wrapper = await mountPage()
    // The row waiting for the person opens by itself; the others stay closed until asked (rec#38).
    expect(wrapper.get('[data-model-role="tonborg"]').attributes('data-state')).toBe('open')
    expect(wrapper.get('[data-model-role="bole"]').attributes('data-state')).toBe('closed')
    // Roles with nothing that runs by themselves show no execution row.
    for (const role of ['assistant', 'bole', 'jefa']) expect(wrapper.find(`[data-model-role="${role}"] [data-model-trust]`).exists()).toBe(false)
    const section = wrapper.get('[data-model-role="tonborg"] [data-model-trust="tonborg"]')
    expect(section.get('[data-model-trust-status]').text()).toBe('看过下面的提示后自动执行')
    expect(section.get('[data-model-trust-warning]').text())
      .toBe('模型可能判断错，它的判断会直接生效；你可以随时改成「只给建议」，部分写入可在回执里撤回。')
    expect(section.get('[role="switch"]').attributes('aria-checked')).toBe('false')
    expect(section.find('[data-model-trust-evaluation]').exists()).toBe(false)
    expect(api.putJson).not.toHaveBeenCalled()

    let finish: (value: unknown) => void = () => {}
    api.putJson.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    await section.get('[data-model-trust-acknowledge]').trigger('click')
    expect(api.putJson).toHaveBeenCalledWith('/api/model-backends/roles/tonborg/trust', { expectedRevision: 0, acknowledgeWarning: 1 })
    expect(section.get('[data-model-trust-acknowledge]').text()).toContain('正在记录你已看过 Tonborg 的提示…')
    const next = roles()
    ;(next.roles[3] as Record<string, unknown>).trust = trust({ warningSeen: true, revision: 1 })
    finish(next)
    await flushPromises()
    expect(wrapper.get('[data-model-trust-status]').text()).toBe('由 qwen-test 自动执行')
    expect(wrapper.find('[data-model-trust-acknowledge]').exists()).toBe(false)
  })

  it('switches Tonborg to 「只给建议」 with a loading label, and shows a local evaluation with its set, day and model', async () => {
    ;(rolesPayload.roles[3] as Record<string, unknown>).trust = trust({ warningSeen: true, revision: 3, evaluation: { role: 'tonborg',
      operation: 'knowledge_review', model: 'qwen-test', set: 'tonborg-review-eval/holdout', evaluatedAt: '2026-10-22T08:00:00.000Z', agreed: 71, total: 162 } })
    const wrapper = await mountPage()
    expect(wrapper.get('[data-model-trust-evaluation]').text())
      .toBe('本机评测 2026/10/22 · tonborg-review-eval/holdout · qwen-test · 一致率 44%（不代表普遍准确率）')
    api.putJson.mockImplementation(() => new Promise(() => {}))
    await wrapper.get('[data-model-trust] [role="switch"]').trigger('click')
    expect(api.putJson).toHaveBeenCalledWith('/api/model-backends/roles/tonborg/trust', { expectedRevision: 3, suggestionsOnly: true })
    expect(wrapper.get('[data-model-trust]').text()).toContain('正在保存 Tonborg 的执行方式…')
    expect(wrapper.get('[data-model-trust] [role="switch"]').attributes('disabled')).toBeDefined()
  })

  it('reads an open change history again after a trust switch found the mode changed elsewhere and the page read it again', async () => {
    ;(rolesPayload.roles[3] as Record<string, unknown>).trust = trust({ warningSeen: true, revision: 3 })
    const wrapper = await mountPage()
    const historyReads = () => api.getJson.mock.calls.filter(([url]) => String(url).startsWith('/api/model-backends/history')).length
    const roleReads = () => api.getJson.mock.calls.filter(([url]) => url === '/api/model-backends/roles').length
    await wrapper.get('[data-model-role="tonborg"] [data-model-history-toggle]').trigger('click')
    await flushPromises()
    expect(historyReads()).toBe(1)
    const before = roleReads()
    api.putJson.mockRejectedValueOnce(new ApiError('changed', 409, JSON.stringify({ error: 'changed', code: 'model_trust_changed' })))
    await wrapper.get('[data-model-trust] [role="switch"]').trigger('click')
    await flushPromises()
    expect(roleReads()).toBe(before + 1)
    expect(historyReads()).toBe(2)
  })

  it('shows a role its model does not answer as suggestions only, with no switch', async () => {
    rolesPayload = roles()
    rolesPayload.roles[3] = { role: 'tonborg', state: 'not_configured', answeredBy: 'current_session',
      trust: trust({ status: 'suggestion', reason: 'session_answer' }) } as never
    const wrapper = await mountPage()
    expect(wrapper.get('[data-model-role="tonborg"] [data-model-fact="execution"]').text()).toContain('只给建议（由当前会话回答）')
    expect(wrapper.find('[data-model-trust]').exists()).toBe(false)
  })

  it('shows the local build observed after the latest answer beside the model: 12 characters, the full build and a caveat in a title', async () => {
    const digest = '0123456789abcdef'.repeat(4)
    ;(rolesPayload.roles[3] as Record<string, unknown>).localBuild = { status: 'observed', digest, completedAt: '2026-10-24T08:00:00.000Z' }
    const wrapper = await mountPage()
    const fact = wrapper.get('[data-model-role="tonborg"] [data-model-fact="localBuild"]')
    expect(fact.get('dt').text()).toBe('本地模型版本')
    expect(fact.get('dd code').text()).toBe('0123456789ab…')
    const title = fact.get('dd').attributes('title')!
    expect(title.startsWith(`${digest}\n最近一次回答（`)).toBe(true)
    expect(title).toContain('这是观察值，不是本次回答的版本证明。')
    // A role without a model shows no row at all.
    expect(wrapper.find('[data-model-role="assistant"] [data-model-fact="localBuild"]').exists()).toBe(false)
  })

  it('says no record and not observed in words, never a made-up build or a cause it cannot know', async () => {
    const cases = [
      [{ status: 'no_record', digest: null, completedAt: null }, '尚无记录', undefined],
      [{ status: 'not_observed', digest: null, completedAt: '2026-10-24T08:00:00.000Z' }, '未观察到', '可能是服务不支持、读取失败或未找到完整 tag'],
    ] as const
    for (const [localBuild, text, hint] of cases) {
      ;(rolesPayload.roles[3] as Record<string, unknown>).localBuild = localBuild
      const wrapper = await mountPage()
      const fact = wrapper.get('[data-model-role="tonborg"] [data-model-fact="localBuild"]')
      expect(fact.get('dd').text()).toBe(text)
      expect(fact.find('dd code').exists()).toBe(false)
      if (hint) expect(fact.get('dd').attributes('title')).toContain(hint)
      else expect(fact.get('dd').attributes('title')).toBeUndefined()
      expect(fact.get('dd').attributes('title') ?? '').not.toContain('审核门')
      wrapper.unmount()
    }
  })

  it('omits the row for a connection a local build is never read from', async () => {
    ;(rolesPayload.roles[3] as Record<string, unknown>).localBuild = { status: 'not_applicable', digest: null, completedAt: null }
    const wrapper = await mountPage()
    expect(wrapper.find('[data-model-role="tonborg"] [data-model-fact="localBuild"]').exists()).toBe(false)
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

  it('reads the settings again and locks the form when the file stopped validating during the edit', async () => {
    const wrapper = await mountPage()
    await wrapper.get('[data-model-role="tonborg"] [data-model-role-edit]').trigger('click')
    rolesPayload = roles({ state: 'invalid', error: 'roles.nobody is not a built-in Agent role', revision: null, connections: {},
      roles: ['assistant', 'bole', 'jefa', 'tonborg'].map(role => ({ role, state: 'invalid_config', answeredBy: null })) })
    api.putJson.mockRejectedValueOnce(new ApiError('invalid', 409, JSON.stringify({ error: 'invalid', code: 'model_config_invalid' })))
    await wrapper.get('[data-model-role-dialog] form').trigger('submit')
    await flushPromises()

    const dialog = wrapper.get('[data-model-role-dialog]')
    expect(dialog.get('[role="alert"]').text()).toContain('修好文件前不能编辑：roles.nobody is not a built-in Agent role')
    expect(dialog.get('[data-model-name]').attributes('disabled')).toBeDefined()
    expect(dialog.get('[data-model-save]').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-model-stale]').exists()).toBe(false)
    expect(wrapper.get('[data-model-config-invalid]').text()).toContain('roles.nobody')
    expect(wrapper.findAll('[data-model-role-edit]').every(button => button.attributes('disabled') !== undefined)).toBe(true)
    await dialog.get('form').trigger('submit')
    expect(api.putJson).toHaveBeenCalledTimes(1)
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

  it('reads the suggestions with the role settings and again on the top bar refresh, never showing an empty section', async () => {
    let answer: (value: unknown) => void = () => {}
    api.getJson.mockImplementation((url: string) => url.startsWith('/api/model-backends/suggestions')
      ? new Promise(resolve => { answer = resolve })
      : Promise.resolve(url.startsWith('/api/model-backends/usage') ? usage() : rolesPayload))
    const wrapper = await mountPage()
    const reads = () => api.getJson.mock.calls.map(([url]) => String(url).split('?')[0])
    expect(reads().slice(0, 2)).toEqual(['/api/model-backends/roles', '/api/model-backends/suggestions'])
    expect(wrapper.find('[data-role-suggestions]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('建议没有')
    answer({ suggestions: [] })
    await flushPromises()
    expect(wrapper.find('[data-role-suggestions]').exists()).toBe(false)

    useConsoleStore().runtimeStatus = 'loading'
    await flushPromises()
    expect(reads().filter(url => url === '/api/model-backends/suggestions')).toHaveLength(2)
  })

  it('names its pending reads with GrowthLoading', async () => {
    api.getJson.mockImplementation(() => new Promise(() => {}))
    const wrapper = mount(ModelSettingsPage, { attachTo: document.body, global: { stubs: { RouterLink: true } } })
    await flushPromises()
    expect(wrapper.get('[role="status"]').attributes('aria-label')).toBe('正在读取内置 Agent 的模型设置…')
  })
})
