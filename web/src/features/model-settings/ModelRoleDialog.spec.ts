import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ getJson: vi.fn(), putJson: vi.fn(), postJson: vi.fn() }))
vi.mock('@/api/client', async importOriginal => ({
  ...await importOriginal<typeof import('@/api/client')>(), getJson: api.getJson, putJson: api.putJson, postJson: api.postJson,
}))

import { ApiError } from '@/api/client'
import { optionSelectStubs } from '@/test-support/OptionSelectStub'
import { openCombobox, optionLabels, toggleOption } from '@/test-support/option-pickers'
import ModelRoleDialog from './ModelRoleDialog.vue'
import type { ModelRoleId, ModelRolesPayload } from './model'

// The 模型 field lists what the typed address offers and still takes any
// name. Synthetic settings and model names only; no request leaves the test.
const REVISION = 'c'.repeat(64)
const OLLAMA = 'http://127.0.0.1:11434/v1'
const LISTED = ['synthetic-chat:4b', 'synthetic-embed:0.6b', 'synthetic-coder:7b', 'synthetic-embedding-v4']
const BUDGET = { maxInputTokens: null, maxOutputTokens: null, timeoutMs: null, windowHours: null, maxTokensPerWindow: null, maxCostPerWindow: null }

function payload(role: ModelRoleId, protocol: string, model: string): ModelRolesPayload {
  return {
    state: 'ok', error: null, revision: REVISION,
    connections: { [role]: { protocol, endpoint: OLLAMA, model, secretRef: null, reasoningEffort: null, pricing: null } },
    roles: [{ role, state: 'enabled', answeredBy: 'model_api',
      connection: { id: role, protocol, endpointHost: '127.0.0.1:11434', model, secretRef: null },
      allowedOperations: [], egress: { approvedProjects: [], allowUnassigned: false }, budget: BUDGET, fallbackToSession: false }],
    operations: {},
  } as ModelRolesPayload
}

const mounted: Array<{ unmount: () => void }> = []
afterEach(() => { for (const wrapper of mounted.splice(0)) wrapper.unmount() })

function mountDialog(role: ModelRoleId, protocol = role === 'semantic' ? 'openai_embeddings' : 'openai_chat', model = 'synthetic-old') {
  const wrapper = mount(ModelRoleDialog, { attachTo: document.body, props: { role, payload: payload(role, protocol, model), projects: [] },
    global: { stubs: { OptionSelect: optionSelectStubs.OptionSelect } } })
  mounted.push(wrapper)
  return wrapper
}
const modelField = (wrapper: ReturnType<typeof mountDialog>) => wrapper.get('[data-model-name]')
const listCalls = () => api.postJson.mock.calls.filter(([url]) => url === '/api/model-backends/models')

describe('the model picker in the role dialog', () => {
  beforeEach(() => {
    api.getJson.mockReset().mockResolvedValue({ saved: [] })
    api.putJson.mockReset()
    api.postJson.mockReset().mockResolvedValue({ models: LISTED.map(id => ({ id })), source: 'models' })
  })

  it('asks the saved address when it opens and puts embedding models first for 语义搜索', async () => {
    const wrapper = mountDialog('semantic')
    await flushPromises()
    expect(listCalls()).toEqual([['/api/model-backends/models', { protocol: 'openai_embeddings', endpoint: OLLAMA }, expect.anything(), expect.anything()]])
    expect(wrapper.get('[data-model-list-state]').text()).toBe('4 个模型可选，也可直接填')
    await openCombobox(modelField(wrapper))
    expect(optionLabels(modelField(wrapper))).toEqual(['synthetic-embed:0.6b', 'synthetic-embedding-v4', 'synthetic-chat:4b', 'synthetic-coder:7b'])
  })

  it('puts the chat models first for a built-in Agent, and a pick fills the field', async () => {
    api.putJson.mockResolvedValue(payload('jefa', 'openai_chat', 'synthetic-coder:7b'))
    const wrapper = mountDialog('jefa')
    await flushPromises()
    await openCombobox(modelField(wrapper))
    expect(optionLabels(modelField(wrapper))).toEqual(['synthetic-chat:4b', 'synthetic-coder:7b', 'synthetic-embed:0.6b', 'synthetic-embedding-v4'])
    await toggleOption(modelField(wrapper), 'synthetic-coder:7b')
    expect((modelField(wrapper).get('input').element as HTMLInputElement).value).toBe('synthetic-coder:7b')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(api.putJson.mock.calls[0][1].connection.model).toBe('synthetic-coder:7b')
  })

  it('keeps a name the list does not have, as typed', async () => {
    api.putJson.mockResolvedValue(payload('jefa', 'openai_chat', 'my-own-model'))
    const wrapper = mountDialog('jefa')
    await flushPromises()
    expect((modelField(wrapper).get('input').element as HTMLInputElement).value).toBe('synthetic-old')
    await modelField(wrapper).get('input').setValue('my-own-model')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(api.putJson.mock.calls[0][1].connection.model).toBe('my-own-model')
  })

  it('shows one loading line naming the address, then one short line when the list fails, and 刷新 asks again', async () => {
    let answer: (value: unknown) => void = () => {}
    api.postJson.mockReturnValueOnce(new Promise(resolve => { answer = resolve }))
    const wrapper = mountDialog('jefa')
    await flushPromises()
    const line = wrapper.get('[data-model-list-line]')
    expect(line.findAll('[role="status"]').map(status => status.attributes('aria-label'))).toEqual(['正在列出 127.0.0.1:11434 的模型'])
    expect(line.get('[data-model-list-refresh]').attributes('disabled')).toBeDefined()
    answer({ models: [], source: 'models' })
    await flushPromises()
    expect(line.get('[data-model-list-state]').text()).toBe('没列出模型，请直接填写')

    api.postJson.mockRejectedValueOnce(new ApiError('bad gateway', 502, JSON.stringify({ error: 'x', code: 'timeout' })))
    await line.get('[data-model-list-refresh]').trigger('click')
    await flushPromises()
    expect(listCalls()).toHaveLength(2)
    expect(line.get('[data-model-list-state]').text()).toBe('没列出模型：超时')
    expect(modelField(wrapper).get('input').attributes('disabled')).toBeUndefined()
  })

  it('asks nothing without an address and suggests addresses for the protocol', async () => {
    const wrapper = mountDialog('jefa')
    await flushPromises()
    await wrapper.get('[data-model-endpoint] input').setValue('')
    await wrapper.get('[data-model-list-refresh]').trigger('click')
    await flushPromises()
    expect(listCalls()).toHaveLength(1)
    expect(wrapper.get('[data-model-list-state]').text()).toBe('填好地址后可选模型')
    await openCombobox(wrapper.get('[data-model-endpoint]'))
    expect(optionLabels(wrapper.get('[data-model-endpoint]'))).toEqual([`${OLLAMA}本机 Ollama`,
      'https://dashscope.aliyuncs.com/compatible-mode/v1千问（阿里云百炼）', 'https://api.deepseek.com/v1DeepSeek', 'https://api.openai.com/v1OpenAI'])
  })
})
