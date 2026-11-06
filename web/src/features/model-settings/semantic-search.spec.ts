import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ getJson: vi.fn(), putJson: vi.fn(), postJson: vi.fn() }))
vi.mock('@/api/client', async importOriginal => ({
  ...await importOriginal<typeof import('@/api/client')>(), getJson: api.getJson, putJson: api.putJson, postJson: api.postJson,
}))
// The page reads a link into a use's details from its address; these tests open it plainly.
vi.mock('vue-router', async importOriginal => ({
  ...await importOriginal<typeof import('vue-router')>(), useRoute: () => ({ query: {}, hash: '' }), useRouter: () => ({ replace: vi.fn() }),
}))

import { messages } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import { optionSelectStubs } from '@/test-support/OptionSelectStub'
import { openCombobox, optionLabels, toggleOption } from '@/test-support/option-pickers'
import ModelSettingsPage from '@/pages/ModelSettingsPage.vue'
import { roleDraft, roleEdit, semanticPreset, withSemanticPreset, type ModelRolesPayload } from './model'

// rec#88 语义搜索: synthetic settings only; no request reaches a model.
const REVISION = 'b'.repeat(64)
const OLLAMA = 'http://127.0.0.1:11434/v1'
const QWEN = 'https://dashscope.aliyuncs.com/compatible-mode/v1'

const notConfigured = (role: string) => ({ role, state: 'not_configured', answeredBy: 'current_session' })
const payload = (semantic: Record<string, unknown> = notConfigured('semantic'), connections = {}): ModelRolesPayload => ({
  state: 'ok', error: null, revision: REVISION, connections,
  roles: [...['assistant', 'bole', 'jefa', 'tonborg'].map(notConfigured), semantic],
  operations: { semantic: ['knowledge_embedding'] },
} as ModelRolesPayload)
const configured = () => payload({ role: 'semantic', state: 'enabled', answeredBy: 'model_api',
  connection: { id: 'semantic', protocol: 'openai_embeddings', endpointHost: '127.0.0.1:11434', model: 'synthetic-embed', secretRef: null },
  allowedOperations: ['knowledge_embedding'], egress: { approvedProjects: [], allowUnassigned: false },
  budget: { maxInputTokens: null, maxOutputTokens: null, timeoutMs: null, windowHours: null, maxTokensPerWindow: null, maxCostPerWindow: null },
  fallbackToSession: false }, { semantic: { protocol: 'openai_embeddings', endpoint: OLLAMA, model: 'synthetic-embed', secretRef: null,
  reasoningEffort: null, pricing: null } })

describe('semantic search presets', () => {
  it('local Ollama fills its address and needs no key; 在线服务 empties only that address', () => {
    const draft = { ...roleDraft(payload(), 'semantic'), model: 'synthetic-embed', secretRef: 'qwen-key' }
    expect(draft.protocol).toBe('openai_embeddings')
    expect(draft.fallbackToSession).toBe(false)
    const ollama = withSemanticPreset(draft, 'ollama')
    expect([ollama.endpoint, ollama.model, ollama.secretRef]).toEqual([OLLAMA, 'synthetic-embed', ''])
    expect(withSemanticPreset(ollama, 'online').endpoint).toBe('')
    const own = { ...draft, endpoint: QWEN }
    expect(withSemanticPreset(own, 'online')).toBe(own)
  })

  it('read back from the saved address: a saved 千问 address is 在线服务', () => {
    expect(semanticPreset(`${OLLAMA}/`)).toBe('ollama')
    expect(semanticPreset(QWEN)).toBe('online')
    expect(semanticPreset('https://embed.example.test/v1')).toBe('online')
    expect(semanticPreset('')).toBe('online')
  })

  it('save the embeddings protocol, its one operation and no session fallback', () => {
    const draft = withSemanticPreset({ ...roleDraft(payload(), 'semantic'), enabled: true, model: 'synthetic-embed' }, 'ollama')
    const edit = roleEdit(draft, REVISION)
    expect(edit.connection).toMatchObject({ protocol: 'openai_embeddings', endpoint: OLLAMA, model: 'synthetic-embed', secretRef: null })
    expect(edit.settings).toMatchObject({ allowedOperations: ['knowledge_embedding'], fallbackToSession: false })
  })

  it('keep their copy plain and short, without the technical word', () => {
    for (const locale of ['zh-CN', 'en-US'] as const) {
      const copy = messages[locale].modelSettings.semantic
      for (const text of [copy.title, copy.preset, copy.enabledOffHint, copy.enabledOnHint, copy.passed, ...Object.values(copy.presets)]) {
        expect(text.length).toBeLessThanOrEqual(100)
        expect(text).not.toMatch(/embed|向量|嵌入/i)
      }
    }
  })
})

describe('语义搜索 on the model page', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const store = useConsoleStore()
    store.runtimeStatus = 'ready'
    store.state = { personalSpaces: [{ id: 'space-1' }], activePersonalSpaceId: 'space-1', personalProjects: [
      { project_id: 'alpha', personal_space_id: 'space-1', scope_type: 'registered', profile: { name: 'Alpha 项目' } },
    ] } as never
    api.getJson.mockReset()
    api.putJson.mockReset()
    api.postJson.mockReset()
    // The model field asks the typed address for its models; a test that checks the connection answers that instead.
    api.postJson.mockImplementation(async (url: string) => (url === '/api/model-backends/models' ? { models: [], source: 'models' } : undefined))
  })

  const mountPage = async (roles: ModelRolesPayload) => {
    api.getJson.mockImplementation(async (url: string) => (url.startsWith('/api/model-backends/usage') ? { groups: [] }
      : url.startsWith('/api/model-backends/suggestions') || url.startsWith('/api/judgment/suggestions') ? { suggestions: [] }
        : url.startsWith('/api/model-backends/history') ? { entries: [] }
          : url.startsWith('/api/model-backends/keys') ? { saved: [] }
            : url.startsWith('/api/dreaming') ? { readiness: 'needs_model', projects: [] } : roles))
    // The address and model fields are real comboboxes that take typing; other single choices are native selects.
    const wrapper = mount(ModelSettingsPage, { attachTo: document.body, global: { stubs: { RouterLink: true, OptionSelect: optionSelectStubs.OptionSelect } } })
    await flushPromises()
    return wrapper
  }

  it('is the first, wide use card: what it does without a model, what is enough, and 接入', async () => {
    const wrapper = await mountPage(payload())
    const card = wrapper.get('[data-semantic-search]')
    expect(wrapper.get('.model-use-grid > *').attributes('data-model-role')).toBe('semantic')
    expect(card.findAll('h3').map(heading => heading.text())).toEqual(['语义搜索'])
    expect(card.get('[data-model-use-model]').text()).toBe('没接模型，只按字面找')
    expect(card.get('[data-model-use-advice]').text()).toContain('qwen3-embedding:0.6b')
    expect(card.get('[data-model-use-state]').text()).toBe('未接')
    expect(card.get('[data-model-role-edit]').text()).toBe('接入')
    expect(card.find('[data-model-check]').exists()).toBe(false)
  })

  it('links the website model guide in the language of the console, from the card and the dialog', async () => {
    const wrapper = await mountPage(payload())
    const link = wrapper.get('.model-uses [data-model-guide]')
    expect(link.attributes('href')).toBe('https://xn--8ovp9s.xn--m8txu.com/fuli/models/zh/')
    expect(link.attributes('target')).toBe('_blank')
    await wrapper.get('[data-semantic-search] [data-model-role-details]').trigger('click')
    expect(wrapper.get('[data-model-use-details] [data-model-guide]').attributes('href'))
      .toBe('https://xn--8ovp9s.xn--m8txu.com/fuli/models/zh/#semantic-search')
    await wrapper.get('[data-model-details-edit]').trigger('click')
    expect(wrapper.find('[data-model-use-details]').exists()).toBe(false)
    expect(wrapper.get('[data-model-role-dialog] [data-model-guide]').text()).toContain('查看详情')
  })

  it('opens the shared dialog with the presets, the address, the model, the key and the projects, and saves the role', async () => {
    api.putJson.mockResolvedValue(configured())
    const wrapper = await mountPage(payload())
    await wrapper.get('[data-semantic-search] [data-model-role-edit]').trigger('click')
    const dialog = wrapper.get('[data-model-role-dialog]')
    expect(dialog.find('[data-model-advanced]').exists()).toBe(false)
    expect(dialog.find('#model-role-protocol').exists()).toBe(false)
    await dialog.get('#model-role-enabled').trigger('click')
    const presets = dialog.get('[data-semantic-presets]')
    expect(presets.findAll('button').map(button => button.text())).toEqual(['本机 Ollama', '在线服务'])
    const endpoint = () => (dialog.get('[data-model-endpoint] input').element as HTMLInputElement).value
    expect(endpoint()).toBe('')
    expect(dialog.find('[data-model-secret-ref]').exists()).toBe(true)
    // 千问 is one suggested address of 在线服务, not a tab of its own.
    await openCombobox(dialog.get('[data-model-endpoint]'))
    expect(optionLabels(dialog.get('[data-model-endpoint]'))).toEqual([`${QWEN}千问（阿里云百炼）`, 'https://api.openai.com/v1OpenAI'])
    await toggleOption(dialog.get('[data-model-endpoint]'), '千问')
    expect(endpoint()).toBe(QWEN)
    expect(presets.get('[data-value="online"]').attributes('aria-pressed')).toBe('true')
    await presets.get('[data-value="ollama"]').trigger('click')
    expect(endpoint()).toBe(OLLAMA)
    expect(dialog.find('[data-model-secret-ref]').exists()).toBe(false)
    await dialog.get('[data-model-name] input').setValue('synthetic-embed')
    await dialog.get('[data-model-egress-project]').trigger('click')
    await dialog.get('form').trigger('submit')
    await flushPromises()
    const [url, body] = api.putJson.mock.calls[0]
    expect(url).toBe('/api/model-backends/roles/semantic')
    expect(body.connection).toMatchObject({ protocol: 'openai_embeddings', endpoint: OLLAMA, model: 'synthetic-embed', secretRef: null })
    expect(body.settings.egress.approvedProjects).toEqual([{ personalSpaceId: 'space-1', personalProjectId: 'alpha' }])
    expect(wrapper.text()).toContain('已保存 语义搜索 的模型设置。')
  })

  it('tests the connection and shows how many dimensions the model gives', async () => {
    api.postJson.mockResolvedValue({ ok: true, receipt: { status: 'completed', actualModel: 'synthetic-embed' }, dimensions: 768 })
    const wrapper = await mountPage(configured())
    const card = wrapper.get('[data-semantic-search]')
    expect(card.get('[data-model-use-state]').text()).toBe('已接上')
    expect(card.get('[data-model-use-model]').text()).toContain('synthetic-embed')
    expect(card.get('[data-model-role-edit]').text()).toBe('编辑')
    await card.get('[data-model-role-details]').trigger('click')
    const details = wrapper.get('[data-model-use-details]')
    // 语义搜索 lists only what its form edits: no task types, budget or fallback.
    expect(details.findAll('[data-model-fact]').map(fact => fact.attributes('data-model-fact'))).toEqual(['provider', 'model', 'secretRef', 'egress'])
    await details.get('[data-model-check]').trigger('click')
    await flushPromises()
    expect(api.postJson).toHaveBeenCalledWith('/api/model-backends/roles/semantic/check', {})
    expect(details.get('[data-model-check-result]').text()).toBe('连接正常，synthetic-embed 回答了，每段文字 768 维。')
  })
})
