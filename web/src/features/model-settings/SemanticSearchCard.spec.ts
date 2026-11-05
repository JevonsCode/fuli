import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ getJson: vi.fn(), putJson: vi.fn(), postJson: vi.fn() }))
vi.mock('@/api/client', async importOriginal => ({
  ...await importOriginal<typeof import('@/api/client')>(), getJson: api.getJson, putJson: api.putJson, postJson: api.postJson,
}))

import { messages } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import { optionSelectStubs } from '@/test-support/OptionSelectStub'
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
  it('fill the address, leave the model as typed, and a local Ollama needs no key', () => {
    const draft = { ...roleDraft(payload(), 'semantic'), model: 'synthetic-embed', secretRef: 'qwen-key' }
    expect(draft.protocol).toBe('openai_embeddings')
    expect(draft.fallbackToSession).toBe(false)
    const qwen = withSemanticPreset(draft, 'qwen')
    expect([qwen.endpoint, qwen.model, qwen.secretRef]).toEqual([QWEN, 'synthetic-embed', 'qwen-key'])
    const ollama = withSemanticPreset(qwen, 'ollama')
    expect([ollama.endpoint, ollama.model, ollama.secretRef]).toEqual([OLLAMA, 'synthetic-embed', ''])
    expect(withSemanticPreset(ollama, 'custom').endpoint).toBe('')
    const own = { ...draft, endpoint: 'https://embed.example.test/v1' }
    expect(withSemanticPreset(own, 'custom')).toBe(own)
  })

  it('read back from the saved address', () => {
    expect(semanticPreset(`${OLLAMA}/`)).toBe('ollama')
    expect(semanticPreset(QWEN)).toBe('qwen')
    expect(semanticPreset('https://embed.example.test/v1')).toBe('custom')
    expect(semanticPreset('')).toBe('custom')
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
      for (const text of [copy.title, copy.summary, copy.preset, copy.enabledOffHint, copy.enabledOnHint, copy.passed, ...Object.values(copy.presets)]) {
        expect(text.length).toBeLessThanOrEqual(100)
        expect(text).not.toMatch(/embed|向量|嵌入/i)
      }
    }
  })
})

describe('SemanticSearchCard on the model page', () => {
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
  })

  const mountPage = async (roles: ModelRolesPayload) => {
    api.getJson.mockImplementation(async (url: string) => (url.startsWith('/api/model-backends/usage') ? { groups: [] }
      : url.startsWith('/api/model-backends/suggestions') || url.startsWith('/api/judgment/suggestions') ? { suggestions: [] }
        : url.startsWith('/api/model-backends/history') ? { entries: [] }
          : url.startsWith('/api/model-backends/keys') ? { saved: [] }
            : url.startsWith('/api/dreaming') ? { readiness: 'needs_model', runs: [] } : roles))
    const wrapper = mount(ModelSettingsPage, { attachTo: document.body, global: { stubs: { RouterLink: true, ...optionSelectStubs } } })
    await flushPromises()
    return wrapper
  }

  it('is its own card, not an Agent row, with one headline and its summary', async () => {
    const wrapper = await mountPage(payload())
    expect(wrapper.find('[data-model-role="semantic"]').exists()).toBe(false)
    const card = wrapper.get('[data-semantic-search]')
    expect(card.findAll('h2').map(heading => heading.text())).toEqual(['语义搜索'])
    expect(card.text()).toContain('让 FULI 按意思找知识。不配也能用，只是只按字面找。')
    expect(card.get('[data-semantic-state]').text()).toBe('未配置')
    expect(card.find('[data-model-check]').exists()).toBe(false)
  })

  it('opens the shared dialog with the presets, the address, the model, the key and the projects, and saves the role', async () => {
    api.putJson.mockResolvedValue(configured())
    const wrapper = await mountPage(payload())
    await wrapper.get('[data-semantic-edit]').trigger('click')
    const dialog = wrapper.get('[data-model-role-dialog]')
    expect(dialog.find('[data-model-advanced]').exists()).toBe(false)
    expect(dialog.find('#model-role-protocol').exists()).toBe(false)
    await dialog.get('#model-role-enabled').trigger('click')
    const presets = dialog.get('[data-semantic-presets]')
    expect(presets.findAll('button').map(button => button.text())).toEqual(['本机 Ollama', '千问', '自定义'])
    await presets.get('[data-value="qwen"]').trigger('click')
    expect((dialog.get('[data-model-endpoint]').element as HTMLInputElement).value).toBe(QWEN)
    expect(dialog.find('[data-model-secret-ref]').exists()).toBe(true)
    await presets.get('[data-value="ollama"]').trigger('click')
    expect((dialog.get('[data-model-endpoint]').element as HTMLInputElement).value).toBe(OLLAMA)
    expect(dialog.find('[data-model-secret-ref]').exists()).toBe(false)
    await dialog.get('[data-model-name]').setValue('synthetic-embed')
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
    expect(card.get('[data-semantic-state]').text()).toBe('已启用')
    expect(card.get('[data-semantic-connection]').text()).toContain('synthetic-embed')
    await card.get('[data-model-check]').trigger('click')
    await flushPromises()
    expect(api.postJson).toHaveBeenCalledWith('/api/model-backends/roles/semantic/check', {})
    expect(card.get('[data-model-check-result]').text()).toBe('连接正常，synthetic-embed 回答了，每段文字 768 维。')
  })
})
