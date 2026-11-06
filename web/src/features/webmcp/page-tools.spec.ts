import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setLocale } from '@/i18n'
import { modelPageTools } from '@/features/model-settings/model-page-tools'
import { decisionPageTools } from '@/features/review-list/decision-page-tools'
import type { PersonalProject } from '@/types'

import { pageModelContext, type ModelContextTool } from './model-context'
import PersonConfirmSheet from './PersonConfirmSheet.vue'
import { usePersonConfirmation } from './person-confirmation'
import { runPageTool, type PageTool } from './page-tool'
import { registerPageTools } from './usePageTools'

// Synthetic data only: a fake document.modelContext (WebMCP) and a fake
// console behind fetch. No real key, endpoint or project.
const SYNTHETIC_KEY = 'sk-synthetic-PAGE-TOOL-9f3c'
const PROJECTS = [{ project_id: 'project-a', profile: { name: 'Project A' } }] as unknown as PersonalProject[]
const ROLES = {
  state: 'ok', error: null, revision: 'a'.repeat(64), connections: {}, operations: { tonborg: ['knowledge_review'] },
  roles: [{ role: 'tonborg', state: 'not_configured', answeredBy: null }],
}

interface Sent { method: string; url: string; headers: Record<string, string>; body: unknown }
let sent: Sent[] = []
let answer: (request: Sent) => { status: number; body: unknown } = () => ({ status: 200, body: {} })

beforeEach(() => {
  setLocale('zh-CN', { persist: false })
  sent = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const request = { method: init.method ?? 'GET', url, headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined }
    sent.push(request)
    const { status, body } = answer(request)
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }))
})
afterEach(() => vi.unstubAllGlobals())

const delegated = (request: Sent) => request.headers['x-fuli-delegation'] !== undefined
const decoded = (request: Sent) => JSON.parse(decodeURIComponent(request.headers['x-fuli-delegation']))
const tool = (name: string, tools: PageTool[]) => tools.find(candidate => candidate.name === name)!
const models = () => modelPageTools({ spaceId: () => 'space-a', projects: () => PROJECTS, changed: vi.fn() })

function fakeContext() {
  const tools = new Map<string, ModelContextTool>()
  return { tools, registerTool: vi.fn((entry: ModelContextTool, options?: { signal?: AbortSignal }) => {
    tools.set(entry.name, entry)
    options?.signal?.addEventListener('abort', () => tools.delete(entry.name))
  }) }
}

describe('WebMCP model context', () => {
  it('finds document.modelContext first, then the older navigator.modelContext, else none', () => {
    const current = { registerTool: vi.fn() }
    const older = { registerTool: vi.fn() }
    expect(pageModelContext({ document: { modelContext: current }, navigator: { modelContext: older } })).toBe(current)
    expect(pageModelContext({ document: {}, navigator: { modelContext: older } })).toBe(older)
    expect(pageModelContext({ document: {}, navigator: {} })).toBeNull()
  })

  it('registers a page\'s tools with their schema and hints, and an aborted page takes them back', async () => {
    const context = fakeContext()
    const controller = new AbortController()
    expect(registerPageTools(models(), controller.signal, context)).toBe(true)
    await flushPromises()
    const configure = context.tools.get('fuli_configure_model_role')!
    expect(configure.inputSchema).toMatchObject({ type: 'object', properties: { role: { enum: expect.arrayContaining(['tonborg']) }, reason: {} } })
    expect(configure.annotations).toEqual({ consequentialHint: true })
    expect(context.tools.get('fuli_read_model_settings')!.annotations).toEqual({ readOnlyHint: true })
    controller.abort()
    expect(context.tools.size).toBe(0)
    expect(registerPageTools(models(), new AbortController().signal, null)).toBe(false)
  })

  it('calls an older build\'s unregister handle when the page goes', async () => {
    const unregister = vi.fn()
    const controller = new AbortController()
    registerPageTools(models().slice(0, 1), controller.signal, { registerTool: () => ({ unregister }) })
    await flushPromises()
    controller.abort()
    expect(unregister).toHaveBeenCalledTimes(1)
  })
})

describe('console page tools', () => {
  it('connects a role through the delegation gate, as run_delegated_action would, without asking the person', async () => {
    answer = request => request.method === 'GET' ? { status: 200, body: ROLES } : { status: 200, body: { ...ROLES, history: 'recorded',
      roles: [{ role: 'tonborg', state: 'enabled', answeredBy: 'model_api', connection: { id: 'work', model: 'model-x', protocol: 'openai_chat', endpointHost: 'llm.example.test', secretRef: 'work-key' } }] } }
    const result = JSON.parse(await runPageTool(tool('fuli_configure_model_role', models()), {
      role: 'tonborg', connectionId: 'work', protocol: 'openai_chat', endpoint: 'https://llm.example.test/v1', model: 'model-x',
      secretRef: 'work-key', enabled: true, approveProjects: ['project-a'], reason: 'The person asked for a spare model',
    }, new AbortController().signal))
    const put = sent.find(request => request.method === 'PUT')!
    expect(put.url).toBe('/api/model-backends/roles/tonborg')
    expect(decoded(put)).toEqual({ actor: { client: 'webmcp' }, reason: 'The person asked for a spare model', bodyFields: ['revision', 'connectionId', 'connection', 'settings'] })
    expect(put.body).toMatchObject({ revision: 'a'.repeat(64), connectionId: 'work',
      connection: { endpoint: 'https://llm.example.test/v1', model: 'model-x', secretRef: 'work-key' },
      settings: { enabled: true, allowedOperations: ['knowledge_review'], egress: { approvedProjects: [{ personalSpaceId: 'space-a', personalProjectId: 'project-a' }] } } })
    expect(result).toMatchObject({ role: 'tonborg', state: 'enabled', model: 'model-x', history: 'recorded' })
    expect(usePersonConfirmation().current.value).toBeNull()
  })

  it('a key waits for the person\'s click, which shows only its last characters, then goes as their own request', async () => {
    answer = request => delegated(request) ? { status: 403, body: { code: 'local_user_only', error: 'synthetic refusal' } }
      : { status: 200, body: { reference: 'work-key', saved: true } }
    const wrapper = mount(PersonConfirmSheet, { attachTo: document.body })
    const running = runPageTool(tool('fuli_save_model_key', models()), { secretRef: 'work-key', key: SYNTHETIC_KEY }, new AbortController().signal)
    await flushPromises()
    const asked = usePersonConfirmation().current.value!
    expect(asked.title).toBe('在这台电脑上保存模型密钥「work-key」')
    expect(asked.lines).toEqual(['密钥结尾：…9f3c'])
    expect(document.body.innerHTML).not.toContain(SYNTHETIC_KEY)
    await wrapper.get('[data-person-confirm-allow]').trigger('click')
    const result = await running
    expect(sent.map(request => [request.method, request.url, delegated(request)])).toEqual([
      ['PUT', '/api/model-backends/keys/work-key', true], ['PUT', '/api/model-backends/keys/work-key', false]])
    expect(result).not.toContain(SYNTHETIC_KEY)
    expect(JSON.parse(result)).toEqual({ secretRef: 'work-key', saved: true })
    wrapper.unmount()
  })

  it('nothing changes when the person says no, an aborted call counts as no, and Agent access off refuses outright', async () => {
    answer = () => ({ status: 403, body: { code: 'local_user_only' } })
    const listing = runPageTool(tool('fuli_list_endpoint_models', models()), { protocol: 'openai_chat', endpoint: 'https://llm.example.test/v1', secretRef: 'work-key' }, new AbortController().signal)
    await flushPromises()
    expect(usePersonConfirmation().current.value!.title).toBe('把已存的密钥发给 llm.example.test，列出它的模型')
    usePersonConfirmation().answer(usePersonConfirmation().current.value!.id, false)
    await expect(listing).rejects.toMatchObject({ code: 'person_declined' })
    expect(sent).toHaveLength(1)

    const controller = new AbortController()
    const aborted = runPageTool(tool('fuli_test_model_role', models()), { role: 'tonborg' }, controller.signal)
    await flushPromises()
    controller.abort()
    await expect(aborted).rejects.toMatchObject({ code: 'person_declined' })
    expect(usePersonConfirmation().current.value).toBeNull()

    answer = () => ({ status: 403, body: { code: 'agent_access_disabled', error: 'Agent access is off' } })
    await expect(runPageTool(tool('fuli_test_model_role', models()), { role: 'tonborg' }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'agent_access_disabled' })
    expect(usePersonConfirmation().current.value).toBeNull()
  })

  it('refuses input outside the tool\'s schema before any request', async () => {
    await expect(runPageTool(tool('fuli_configure_model_role', models()), { role: 'nobody' }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'invalid_input' })
    await expect(runPageTool(tool('fuli_save_model_key', models()), { secretRef: '../x', key: SYNTHETIC_KEY }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'invalid_input' })
    expect(sent).toEqual([])
  })

  it('待决策: one click of the person allows the whole batch, then each line is decided by the page itself', async () => {
    const line = (key: string, text: string) => ({ key, text, item: { id: key }, projectId: null, proposer: 'Astro', reason: null, review: null })
    const act = vi.fn(async (_line: { key: string }, _action: string) => true)
    const list = { loaded: true, refresh: vi.fn(), act,
      list: { questions: [], pending: [line('entity:a', '用 pnpm'), line('entity:b', '周五发布')], confirmed: [] } }
    const tools = decisionPageTools(list as never)
    const running = runPageTool(tool('fuli_decide', tools), { decisions: [{ key: 'entity:a', action: 'confirm' }, { key: 'entity:b', action: 'drop' }] }, new AbortController().signal)
    await flushPromises()
    const asked = usePersonConfirmation().current.value!
    expect(asked.title).toBe('按 AI 的建议处理 2 件待决策')
    expect(act).not.toHaveBeenCalled()
    usePersonConfirmation().answer(asked.id, true)
    expect(JSON.parse(await running)).toEqual({ done: ['entity:a', 'entity:b'], notDone: [] })
    expect(act.mock.calls.map(([decided, action]) => [decided.key, action])).toEqual([['entity:a', 'confirm'], ['entity:b', 'drop']])
    await expect(runPageTool(tool('fuli_decide', tools), { decisions: [{ key: 'entity:z', action: 'confirm' }] }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'invalid_input' })
  })
})
