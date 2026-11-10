import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ getJson: vi.fn(), putJson: vi.fn(), postJson: vi.fn() }))
const routing = vi.hoisted(() => ({ route: { query: {} as Record<string, string>, hash: '' }, replace: vi.fn() }))
vi.mock('vue-router', async (importOriginal) => ({
  ...await importOriginal<typeof import('vue-router')>(), useRoute: () => routing.route, useRouter: () => ({ replace: routing.replace }),
}))
vi.mock('@/api/client', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/api/client')>(), getJson: api.getJson, putJson: api.putJson, postJson: api.postJson,
}))

import { ApiError } from '@/api/client'
import { useConsoleStore } from '@/stores/console'
import { optionSelectStubs } from '@/test-support/OptionSelectStub'
import { reloadPage } from '@/layouts/page-refresh'
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
    requests: 2, failedRequests: 1, attempts: 3, failedAttempts: 2, unreportedAttempts: 1, unreportedFailedAttempts: 1,
    tokens: { input: { reported: 1200, unknownAttempts: 1 }, output: { reported: 300, unknownAttempts: 2 }, cachedInput: { reported: 0, unknownAttempts: 1 },
      total: { reported: 1500, unknownAttempts: 2 } } },
  { role: 'bole', provider: null, model: null, actualModels: [], channel: 'session', requests: 1, failedRequests: 0, attempts: 1, failedAttempts: 0,
    unreportedAttempts: 1, unreportedFailedAttempts: 0,
    tokens: { input: { reported: null, unknownAttempts: 1 }, output: { reported: null, unknownAttempts: 1 }, total: { reported: null, unknownAttempts: 1 } } },
] })

// rec#10 D-36: Tonborg's trust as the roles route reports it.
const trust = (overrides: Record<string, unknown> = {}) => ({ operation: 'knowledge_review', suggestionsOnly: false, warningSeen: false,
  warningSeenAt: null, warningVersion: 1, revision: 0, status: 'automatic', reason: null, evaluation: null, ...overrides })

let rolesPayload = roles()
const dreamingOff = { readiness: 'needs_model', projects: [] }
beforeEach(() => {
  setActivePinia(createPinia())
  const store = useConsoleStore()
  store.runtimeStatus = 'ready'
  store.state = { personalSpaces: [{ id: 'space-1' }], activePersonalSpaceId: 'space-1', personalProjects: [
    { project_id: 'alpha', personal_space_id: 'space-1', scope_type: 'registered', profile: { name: 'Alpha 项目' } },
    { project_id: 'beta', personal_space_id: 'space-1', scope_type: 'registered', profile: { name: 'Beta 项目' } },
  ] } as never
  rolesPayload = roles()
  routing.route.query = {}
  routing.route.hash = ''
  routing.replace.mockReset()
  api.getJson.mockReset()
  api.putJson.mockReset()
  api.postJson.mockReset()
  api.getJson.mockImplementation(async (url: string) => (url.startsWith('/api/model-backends/usage') ? usage()
    : url.startsWith('/api/model-backends/suggestions') || url.startsWith('/api/judgment/suggestions') ? { suggestions: [] }
      : url.startsWith('/api/model-backends/history') ? { entries: [] }
        : url.startsWith('/api/dreaming') ? dreamingOff : rolesPayload))
})

// Every page a test mounts leaves with it, so only the current test's page answers the top bar's refresh.
const mounted: ReturnType<typeof mount>[] = []
afterEach(() => { mounted.splice(0).forEach(wrapper => { if (!wrapper.vm.$.isUnmounted) wrapper.unmount() }) })
const mountPage = async () => {
  const wrapper = mount(ModelSettingsPage, { attachTo: document.body,
    global: { stubs: { RouterLink: true, OptionSelect: optionSelectStubs.OptionSelect } } })
  mounted.push(wrapper)
  await flushPromises()
  return wrapper
}

// A use's 「查看详情」: facts, trust and history open in a dialog, not in place.
const openDetails = async (wrapper: Awaited<ReturnType<typeof mountPage>>, role: string) => {
  await wrapper.get(`[data-model-role="${role}"] [data-model-role-details]`).trigger('click')
  return wrapper.get('[data-model-use-details]')
}
const closeDetails = (wrapper: Awaited<ReturnType<typeof mountPage>>) => wrapper.get('[data-model-use-details] button[aria-label="关闭"]').trigger('click')

describe('ModelSettingsPage', () => {
  it('shows every use as a card with its state, its model, one line of how it stands and one quick action', async () => {
    const wrapper = await mountPage()
    expect(wrapper.findAll('.model-use-grid > article h3').map(heading => heading.text()))
      .toEqual(['语义搜索', 'Astro', 'Dreaming', '补检索词', 'Jefa', 'Tonborg', 'Bole'])
    // No accordion or disclosure on the page: every use is an open card.
    expect(wrapper.find('[data-model-role] [aria-expanded]').exists()).toBe(false)
    const tonborg = wrapper.get('[data-model-role="tonborg"]')
    expect(tonborg.get('[data-model-use-state]').text()).toBe('已接上')
    expect(tonborg.get('[data-model-use-model]').text()).toBe('qwen-test127.0.0.1:11434')
    // With a model the line says how the connection stands; the recommendation is in the details.
    expect(tonborg.get('[data-model-role-health]').text()).toBe('还没调用过')
    expect(tonborg.find('[data-model-use-advice]').exists()).toBe(false)
    expect(tonborg.get('[data-model-role-edit]').text()).toBe('编辑')
    const astro = wrapper.get('[data-model-role="assistant"]')
    expect(astro.get('[data-model-use-state]').text()).toBe('未接')
    expect(astro.get('[data-model-use-model]').text()).toBe('没接模型，用当前会话回答')
    expect(astro.get('[data-model-use-advice]').text()).toBe('推荐能回 JSON 的小型聊天模型就够，本机 Ollama 跑得动。')
    expect(astro.get('[data-model-role-edit]').text()).toBe('接入')
    expect(wrapper.get('[data-dreaming] [data-model-use-model]').text()).toBe('Astro 还没接模型')
    // Every card keeps the same room for its one line, whatever it says.
    expect(wrapper.findAll('.model-use-grid > article [data-model-use-note]')).toHaveLength(7)
  })

  it("opens Tonborg's details from a link to its confirmation settings and rings the switch", async () => {
    routing.route.query = { details: 'tonborg', tab: 'x' }
    routing.route.hash = '#delegation'
    const wrapper = await mountPage()
    const details = wrapper.get('[data-model-use-details]')
    expect(details.get('h2').text()).toBe('Tonborg')
    expect(details.get('[data-tonborg-delegation]').attributes('data-model-details-linked')).toBe('')
    expect(routing.replace).toHaveBeenCalledWith({ query: { tab: 'x' }, hash: '' })
    await closeDetails(wrapper)
    expect(wrapper.find('[data-model-use-details] [data-tonborg-delegation]').exists()).toBe(false)
  })

  it("lists a model's key reference and limits in 查看详情, never a key, with the guide section of that use", async () => {
    const wrapper = await mountPage()
    let details = await openDetails(wrapper, 'tonborg')
    expect(details.get('h2').text()).toBe('Tonborg')
    expect(details.get('[data-model-guide]').attributes('href')).toBe('https://xn--8ovp9s.xn--m8txu.com/fuli/models/zh/#tonborg')
    expect(details.get('[data-model-fact="secretRef"]').text()).toContain('local-ref')
    expect(details.get('[data-model-fact="egress"]').text()).toContain('1 个项目')
    expect(details.get('[data-model-fact="callBudget"]').text()).toContain('输入 4,000 · 输出 400 tokens · 30 秒')
    expect(details.get('[data-model-fact="fallback"]').text()).toContain('允许')
    expect(details.find('[data-model-check]').exists()).toBe(true)
    await closeDetails(wrapper)
    details = await openDetails(wrapper, 'assistant')
    expect(details.get('[data-model-fact="answeredBy"]').text()).toContain('当前会话')
    expect(details.find('[data-model-check]').exists()).toBe(false)
  })

  it('asks the person to read the warning before Tonborg\'s model executes by itself, and saves only that acknowledgement (D-36)', async () => {
    ;(rolesPayload.roles[3] as Record<string, unknown>).trust = trust({ status: 'suggestion', reason: 'warning_not_seen' })
    const wrapper = await mountPage()
    // The card waiting for the person lifts and says so; the others stay as they are.
    const tonborg = wrapper.get('[data-model-role="tonborg"]')
    expect(tonborg.attributes('data-model-needs-person')).toBeDefined()
    expect(tonborg.classes()).toContain('shadow-md')
    expect(tonborg.get('[data-model-role-waiting]').text()).toBe('有一条提示等你看过，打开详情确认。')
    expect(wrapper.get('[data-model-role="bole"]').attributes('data-model-needs-person')).toBeUndefined()
    // Roles with nothing that runs by themselves show no execution section.
    for (const role of ['assistant', 'bole', 'jefa']) {
      expect((await openDetails(wrapper, role)).find('[data-model-trust]').exists()).toBe(false)
      await closeDetails(wrapper)
    }
    const section = (await openDetails(wrapper, 'tonborg')).get('[data-model-trust="tonborg"]')
    expect(section.get('[data-model-trust-status]').text()).toBe('看过下面的提示后自动执行')
    expect(section.get('[data-model-trust-warning]').text())
      .toBe('模型可能判断错，它的判断会直接生效。你可以随时改成「只给建议」，部分写入可在回执里撤回。')
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
    await openDetails(wrapper, 'tonborg')
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
    await (await openDetails(wrapper, 'tonborg')).get('[data-model-history-toggle]').trigger('click')
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
    expect((await openDetails(wrapper, 'tonborg')).get('[data-model-fact="execution"]').text()).toContain('只给建议（由当前会话回答）')
    expect(wrapper.find('[data-model-trust]').exists()).toBe(false)
  })

  it('shows the local build observed after the latest answer beside the model: 12 characters, the full build and a caveat in a title', async () => {
    const digest = '0123456789abcdef'.repeat(4)
    ;(rolesPayload.roles[3] as Record<string, unknown>).localBuild = { status: 'observed', digest, completedAt: '2026-10-24T08:00:00.000Z' }
    const wrapper = await mountPage()
    const fact = (await openDetails(wrapper, 'tonborg')).get('[data-model-fact="localBuild"]')
    expect(fact.get('dt').text()).toBe('本地模型版本')
    expect(fact.get('dd code').text()).toBe('0123456789ab…')
    const title = fact.get('dd').attributes('title')!
    expect(title.startsWith(`${digest}\n最近一次回答（`)).toBe(true)
    expect(title).toContain('这是观察值，不是本次回答的版本证明。')
    // A role without a model shows no row at all.
    await closeDetails(wrapper)
    expect((await openDetails(wrapper, 'assistant')).find('[data-model-fact="localBuild"]').exists()).toBe(false)
  })

  it('says no record and not observed in words, never a made-up build or a cause it cannot know', async () => {
    const cases = [
      [{ status: 'no_record', digest: null, completedAt: null }, '尚无记录', undefined],
      [{ status: 'not_observed', digest: null, completedAt: '2026-10-24T08:00:00.000Z' }, '未观察到', '可能是服务不支持、读取失败或未找到完整 tag'],
    ] as const
    for (const [localBuild, text, hint] of cases) {
      ;(rolesPayload.roles[3] as Record<string, unknown>).localBuild = localBuild
      const wrapper = await mountPage()
      const fact = (await openDetails(wrapper, 'tonborg')).get('[data-model-fact="localBuild"]')
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
    expect((await openDetails(wrapper, 'tonborg')).find('[data-model-fact="localBuild"]').exists()).toBe(false)
  })

  it('edits a role in a labelled form, saves it with the revision it read, and tests the saved model at once', async () => {
    const saved = roles()
    api.putJson.mockResolvedValue(saved)
    api.postJson.mockResolvedValue({ ok: true, receipt: { status: 'completed', actualModel: 'qwen-next' } })
    const wrapper = await mountPage()
    await wrapper.get('[data-model-role="tonborg"] [data-model-role-edit]').trigger('click')
    expect(wrapper.get('[data-model-role="tonborg"]').classes()).toContain('shadow-md')
    const dialog = wrapper.get('[data-model-role-dialog]')
    expect(dialog.get('[data-model-secret-ref]').attributes('id')).toBe('model-role-secret-ref')
    expect(dialog.find('label[for="model-role-secret-ref"]').text()).toBe('密钥引用')
    expect(dialog.find('[data-model-budget="maxOutputTokens"]').exists()).toBe(false)
    await dialog.get('[data-model-advanced] button').trigger('click')
    await flushPromises()
    expect(dialog.text()).toContain('已接入：knowledge_review')
    await dialog.get('[data-model-name] input').setValue('qwen-next')
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
    // The saved model is on, so it is tested; the floating toast says both, and nothing is pushed into the page.
    expect(api.postJson).toHaveBeenCalledWith('/api/model-backends/roles/tonborg/check', {})
    expect(useConsoleStore().feedback).toMatchObject({ tone: 'success', message: '已保存 Tonborg 的模型设置。 连接正常，qwen-next 回答了。' })
    expect(wrapper.find('.model-settings-column .ui-notice').exists()).toBe(false)
  })

  it('says at once when a saved model does not answer: the reason in the toast, and on its card with 测试连接', async () => {
    api.putJson.mockResolvedValue(roles())
    api.postJson.mockResolvedValue({ ok: false, receipt: { status: 'failed', reason: 'auth_failed' } })
    const wrapper = await mountPage()
    await wrapper.get('[data-model-role="tonborg"] [data-model-role-edit]').trigger('click')
    // The settings read after the test carry the failed call.
    rolesPayload.roles[3] = { ...(rolesPayload.roles[3] as object), health: { status: 'failing', at: new Date().toISOString(), reason: 'auth_failed' } } as never
    await wrapper.get('[data-model-role-dialog] form').trigger('submit')
    await flushPromises()
    expect(useConsoleStore().feedback).toMatchObject({ tone: 'error', message: '已保存 Tonborg 的模型设置。 没有连上：密钥不对' })
    const tonborg = wrapper.get('[data-model-role="tonborg"]')
    expect(tonborg.get('[data-model-use-state]').text()).toBe('没回应')
    expect(tonborg.get('[data-model-failure-text]').text()).toContain('没回应：密钥不对')
    expect(wrapper.get('[data-model-connection-id="local-qwen"] [data-model-connection-health]').text()).toContain('没回应：密钥不对')

    // 测试连接 on the card tests again, answers in place, and the page reads the settings again.
    api.postJson.mockResolvedValue({ ok: true, receipt: { status: 'completed', actualModel: 'qwen-test' } })
    rolesPayload.roles[3] = { ...(rolesPayload.roles[3] as object), health: { status: 'ok', at: new Date().toISOString(), reason: null } } as never
    const reads = () => api.getJson.mock.calls.filter(([url]) => url === '/api/model-backends/roles').length
    const before = reads()
    await tonborg.get('[data-model-check]').trigger('click')
    await flushPromises()
    expect(reads()).toBe(before + 1)
    expect(wrapper.get('[data-model-role="tonborg"] [data-model-use-state]').text()).toBe('已接上')
    expect(wrapper.find('[data-model-role="tonborg"] [data-model-failure]').exists()).toBe(false)
  })

  it('says why a key name is refused, keeps it from saving, and offers the names already known', async () => {
    const wrapper = await mountPage()
    await wrapper.get('[data-model-role="tonborg"] [data-model-role-edit]').trigger('click')
    const dialog = wrapper.get('[data-model-role-dialog]')
    await dialog.get('[data-model-secret-ref]').setValue('my key')
    expect(dialog.get('[data-model-secret-ref-error]').text()).toContain('不能有空格')
    expect(dialog.get('[data-model-save]').attributes('disabled')).toBeDefined()
    await dialog.get('form').trigger('submit')
    await flushPromises()
    expect(api.putJson).not.toHaveBeenCalled()

    await dialog.get('[data-model-secret-choice="local-ref"]').trigger('click')
    expect((dialog.get('[data-model-secret-ref]').element as HTMLInputElement).value).toBe('local-ref')
    expect(dialog.find('[data-model-secret-ref-error]').exists()).toBe(false)
    expect(dialog.get('[data-model-save]').attributes('disabled')).toBeUndefined()
  })

  it('greys out the model settings while the role uses the chat client\'s model', async () => {
    const wrapper = await mountPage()
    await wrapper.get('[data-model-role="tonborg"] [data-model-role-edit]').trigger('click')
    const dialog = wrapper.get('[data-model-role-dialog]')
    expect(dialog.get('[data-model-endpoint] input').attributes('disabled')).toBeUndefined()
    expect(dialog.get('[data-model-enabled-hint]').text()).toContain('不用聊天客户端里的模型')

    await dialog.get('#model-role-enabled').trigger('click')
    expect(dialog.get('[data-model-endpoint] input').attributes('disabled')).toBeDefined()
    expect(dialog.get('[data-model-secret-ref]').attributes('disabled')).toBeDefined()
    expect(dialog.get('[data-model-enabled-hint]').text()).toContain('现在用你聊天客户端里的模型')
    expect(dialog.get('[data-model-save]').attributes('disabled')).toBeUndefined()
  })

  it('finds a project by name and says when none matches', async () => {
    const wrapper = await mountPage()
    await wrapper.get('[data-model-role="tonborg"] [data-model-role-edit]').trigger('click')
    const dialog = wrapper.get('[data-model-role-dialog]')
    const shown = dialog.findAll('[data-model-egress-project]').length
    expect(shown).toBeGreaterThan(0)
    await dialog.get('[data-model-project-search]').setValue('no-such-synthetic-project')
    expect(dialog.findAll('[data-model-egress-project]')).toHaveLength(0)
    expect(dialog.text()).toContain('没有匹配的项目。')
    await dialog.get('[data-model-project-search]').setValue('')
    expect(dialog.findAll('[data-model-egress-project]')).toHaveLength(shown)
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
    expect(dialog.get('[data-model-name] input').attributes('disabled')).toBeDefined()
    expect(dialog.get('[data-model-save]').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-model-stale]').exists()).toBe(false)
    expect(wrapper.get('[data-model-config-invalid]').text()).toContain('roles.nobody')
    expect(wrapper.findAll('[data-model-role-edit]').every(button => button.attributes('disabled') !== undefined)).toBe(true)
    await dialog.get('form').trigger('submit')
    expect(api.putJson).toHaveBeenCalledTimes(1)
  })

  it('shows usage in plain words: calls that add up, one note for tries without usage, no cost', async () => {
    const wrapper = await mountPage()
    const model = wrapper.get('[data-usage-list="model"]')
    expect(model.text()).toContain('Tonborg')
    expect(model.text()).toContain('用量由模型服务返回')
    // Calls are calls; failures are calls that failed in the end; tries are apart.
    expect(model.get('.model-usage-failed').text()).toBe('1 次失败')
    expect(model.get('dl > div:first-child dd').text()).toBe('2 次1 次失败（含重试共试了 3 次）')
    // The failed try without usage is said once for the row, not on every cell.
    expect(model.get('[data-usage-row-note]').text()).toBe('1 次失败的尝试没返回用量，上面的数没算它们。')
    expect(model.get('[data-usage-cell="input"] dd').text()).toBe('1,200')
    // The note wraps as a whole, never inside a word.
    expect(model.get('[data-usage-cell="output"] .model-usage-note').text()).toBe('（另 1 次没返回）')
    // A returned 0 is a real 0; a cache nothing returned has no cell at all.
    expect(model.get('[data-usage-cell="cache"] dd').text()).toBe('0')
    expect(model.find('[data-usage-cell="cacheWrite"]').exists()).toBe(false)
    expect(model.find('[data-usage-cell="cost"]').exists()).toBe(false)
    expect(wrapper.get('[data-model-usage]').text()).not.toMatch(/费用|估算|上报|US\$/)
    const session = wrapper.get('[data-usage-list="session"]')
    expect(session.get('h3').text()).toBe('回到当前会话')
    expect(session.text()).toContain('用量由客户端会话记录')
    expect(session.get('[data-usage-cell="input"] dd').text()).toBe('没返回')
    expect(session.find('[data-usage-row-note]').exists()).toBe(false)

    await wrapper.get('[data-value="today"]').trigger('click')
    await flushPromises()
    expect(api.getJson.mock.calls.filter(([url]) => String(url).startsWith('/api/model-backends/usage')).length).toBe(2)
  })

  it('reads the suggestions with the role settings and again on the top bar refresh, never showing an empty section', async () => {
    let answer: (value: unknown) => void = () => {}
    api.getJson.mockImplementation((url: string) => url.startsWith('/api/model-backends/suggestions')
      ? new Promise(resolve => { answer = resolve })
      : Promise.resolve(url.startsWith('/api/model-backends/usage') ? usage() : url.startsWith('/api/dreaming') ? dreamingOff : rolesPayload))
    const wrapper = await mountPage()
    const reads = () => api.getJson.mock.calls.map(([url]) => String(url).split('?')[0])
    expect(reads().slice(0, 2)).toEqual(['/api/model-backends/roles', '/api/model-backends/suggestions'])
    expect(wrapper.find('[data-role-suggestions]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('建议没有')
    answer({ suggestions: [] })
    await flushPromises()
    expect(wrapper.find('[data-role-suggestions]').exists()).toBe(false)

    void reloadPage()
    await flushPromises()
    expect(reads().filter(url => url === '/api/model-backends/suggestions')).toHaveLength(2)
    expect(reads().filter(url => url === '/api/model-backends/roles')).toHaveLength(2)
  })

  it('reads Tonborg\'s suggestions of the active space into the same section, also when the space arrives later', async () => {
    const store = useConsoleStore()
    const state = store.state
    store.state = null
    const review = { id: 'judgment-1', createdAt: '2026-10-24T08:00:00.000Z', personalSpaceId: 'space-1', personalProjectId: 'alpha',
      target: 'entity:seed-rule', title: 'Seed rule', summary: 'Supported by two sessions.', confidence: 0.7,
      aiReview: { state: 'ai_suggested', modelOutcome: 'approve', interceptions: ['gate_not_passed'], gate: { status: 'not_passed', reason: 'suggestions_only', modelId: 'qwen-test' } },
      model: 'qwen-test', client: null, judgedBy: { mode: 'model_api', independent: true } }
    api.getJson.mockImplementation(async (url: string) => url.startsWith('/api/judgment/suggestions') ? { suggestions: [review] }
      : url.startsWith('/api/model-backends/suggestions') ? { suggestions: [] }
        : url.startsWith('/api/model-backends/usage') ? usage() : url.startsWith('/api/model-backends/history') ? { entries: [] }
          : url.startsWith('/api/dreaming') ? dreamingOff : rolesPayload)
    const wrapper = await mountPage()
    const reviewReads = () => api.getJson.mock.calls.map(([url]) => String(url)).filter(url => url.startsWith('/api/judgment/suggestions'))
    expect(reviewReads()).toEqual([])
    expect(wrapper.find('[data-role-suggestions]').exists()).toBe(false)
    store.state = state
    await flushPromises()
    expect(reviewReads()).toEqual(['/api/judgment/suggestions?personalSpaceId=space-1'])
    const card = wrapper.get('[data-role-suggestions] article[data-role-suggestion="tonborg"]')
    expect(card.get('[data-suggestion-text]').text()).toBe('Seed rule · 模型认为可以通过审核')
    expect(card.get('[data-suggestion-held]').text()).toBe('留给你你选了「只给建议」')
  })

  it('says once that no model is connected, and offers 接入 on every role', async () => {
    rolesPayload = roles({ connections: {}, roles: ['assistant', 'bole', 'jefa', 'tonborg', 'semantic']
      .map(role => ({ role, state: 'not_configured', answeredBy: role === 'semantic' ? null : 'current_session' })) })
    const wrapper = await mountPage()
    expect(wrapper.get('[data-model-list-empty]').text()).toBe('还没有接模型。接一个，FULI 就能按意思找和整理。')
    expect(wrapper.findAll('[data-model-connection-id]')).toHaveLength(0)
    expect(wrapper.findAll('[data-model-role-edit]').map(button => button.text())).toEqual(['接入', '接入', '接入', '接入', '接入'])
  })

  it('lists a model two roles share once, with both and Astro\'s allowed tasks as who uses it, and opens a use', async () => {
    const shared = { id: 'local-qwen', protocol: 'openai_chat', endpointHost: '127.0.0.1:11434', model: 'qwen-test', secretRef: 'local-ref' }
    rolesPayload = roles()
    rolesPayload.roles[0] = { role: 'assistant', state: 'enabled', answeredBy: 'model_api', connection: shared,
      allowedOperations: ['conversation_attribution', 'retrieval_terms'] } as never
    rolesPayload.roles[2] = { role: 'jefa', state: 'disabled', answeredBy: 'current_session', connection: shared } as never
    const wrapper = await mountPage()
    const rows = wrapper.findAll('[data-model-connection-id]')
    expect(rows.map(row => row.attributes('data-model-connection-id'))).toEqual(['local-qwen'])
    expect(rows[0]!.get('code').text()).toBe('qwen-test')
    expect(rows[0]!.findAll('[data-model-use-chip]').map(chip => chip.text())).toEqual(['Astro', '补检索词', 'Jefa', 'Tonborg'])
    // A use that is off stays listed, quieter, and says so.
    expect(rows[0]!.get('[data-model-use-chip="jefa"]').attributes('title')).toBe('已停用')
    expect(rows[0]!.get('[data-model-use-chip="assistant"]').attributes('title')).toBeUndefined()
    expect(wrapper.get('[data-retrieval-terms] [data-model-use-state]').text()).toBe('已打开')
    expect(wrapper.get('[data-dreaming] [data-model-use-state]').text()).toBe('未打开')
    expect(wrapper.get('[data-dreaming] [data-model-use-model]').text()).toBe('qwen-testAstro 的模型')
    // An Astro task opens Astro's details.
    await rows[0]!.get('[data-model-use-chip="retrieval_terms"]').trigger('click')
    expect(wrapper.get('[data-model-use-details] h2').text()).toBe('Astro')
    await wrapper.get('[data-model-details-edit]').trigger('click')
    expect(wrapper.find('[data-model-use-details]').exists()).toBe(false)
    expect(wrapper.get('[data-model-role-dialog]').text()).toContain('这个连接也用于 Jefa, Tonborg')
  })

  it('names its pending reads with GrowthLoading', async () => {
    api.getJson.mockImplementation(() => new Promise(() => {}))
    const wrapper = mount(ModelSettingsPage, { attachTo: document.body, global: { stubs: { RouterLink: true } } })
    await flushPromises()
    expect(wrapper.get('[role="status"]').attributes('aria-label')).toBe('正在读取内置 Agent 的模型设置…')
  })
})
