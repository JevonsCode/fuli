import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setLocale } from '@/i18n'
import { modelPageTools } from '@/features/model-settings/model-page-tools'
import { decisionPageTools } from '@/features/review-list/decision-page-tools'

import { pageModelContext, type ModelContextTool } from './model-context'
import { runPageTool, type PageTool } from './page-tool'
import { registerPageTools } from './usePageTools'

// Synthetic data only: a fake document.modelContext (WebMCP) and a fake
// console behind fetch. No real key, endpoint or project.
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
const models = () => modelPageTools({ changed: vi.fn() })

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
    // Text other Agents wrote reaches the browser AI marked untrusted.
    registerPageTools(decisionPageTools({} as never), controller.signal, context)
    await flushPromises()
    expect(context.tools.get('fuli_list_decisions')!.annotations).toEqual({ readOnlyHint: true, untrustedContentHint: true })
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
      secretRef: 'work-key', enabled: true, reason: 'The person asked for a spare model',
    }, new AbortController().signal))
    const put = sent.find(request => request.method === 'PUT')!
    expect(put.url).toBe('/api/model-backends/roles/tonborg')
    expect(decoded(put)).toEqual({ actor: { client: 'webmcp' }, reason: 'The person asked for a spare model', bodyFields: ['revision', 'connectionId', 'connection', 'settings'] })
    expect(put.body).toMatchObject({ revision: 'a'.repeat(64), connectionId: 'work',
      connection: { endpoint: 'https://llm.example.test/v1', model: 'model-x', secretRef: 'work-key' },
      settings: { enabled: true, allowedOperations: ['knowledge_review'], egress: { approvedProjects: [], allowUnassigned: false } } })
    expect(result).toMatchObject({ role: 'tonborg', state: 'enabled', model: 'model-x', history: 'recorded' })
  })

  it('a change the gate says is the person\'s is refused with its reason, and nothing is sent again (dot review of fuli PR 784)', async () => {
    for (const code of ['local_user_only', 'agent_tool_route', 'person_words_required', 'delegation_category_off']) {
      sent = []
      answer = () => ({ status: 403, body: { code, error: 'synthetic refusal' } })
      await expect(runPageTool(tool('fuli_test_model_role', models()), { role: 'tonborg' }, new AbortController().signal))
        .rejects.toMatchObject({ code, message: expect.stringContaining('这一步只能由本人在页面上操作') })
      expect(sent.map(request => [request.method, delegated(request)])).toEqual([['POST', true]])
    }
    answer = () => ({ status: 403, body: { code: 'agent_access_disabled', error: 'Agent access is off' } })
    await expect(runPageTool(tool('fuli_test_model_role', models()), { role: 'tonborg' }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'agent_access_disabled' })
  })

  it('no page tool takes a key, lists an endpoint with a saved key, or records the person\'s decision', () => {
    const tools = [...models(), ...decisionPageTools({} as never)]
    expect(tools.map(entry => entry.name)).toEqual(['fuli_read_model_settings', 'fuli_configure_model_role', 'fuli_test_model_role', 'fuli_list_decisions'])
    const changes = tools.flatMap(entry => entry.routes.filter(route => !route.startsWith('GET ')))
    expect(changes).toEqual(['PUT /api/model-backends/roles/:role', 'POST /api/model-backends/roles/:role/check'])
  })

  it('refuses input outside the tool\'s schema before any request', async () => {
    await expect(runPageTool(tool('fuli_configure_model_role', models()), { role: 'nobody' }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'invalid_input' })
    await expect(runPageTool(tool('fuli_configure_model_role', models()), { role: 'tonborg', secretRef: '../x' }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'invalid_input' })
    // Which projects may send content to a model is the person's (or run_delegated_action's), never a page tool's.
    for (const egress of [{ approveProjects: ['project-a'] }, { allowUnassigned: true }]) {
      await expect(runPageTool(tool('fuli_configure_model_role', models()), { role: 'tonborg', ...egress }, new AbortController().signal))
        .rejects.toMatchObject({ code: 'invalid_input' })
    }
    expect(sent).toEqual([])
  })

  it('待决策 is read only: the agent gets the lines to suggest from', async () => {
    const line = (key: string, text: string) => ({ key, text, item: { id: key }, projectId: null, proposer: 'Astro', reason: null, review: null })
    const list = { loaded: true, refresh: vi.fn(), list: { questions: [], pending: [line('entity:a', '用 pnpm')], confirmed: [] } }
    const result = JSON.parse(await runPageTool(tool('fuli_list_decisions', decisionPageTools(list as never)), {}, new AbortController().signal))
    expect(result.pending).toEqual([{ key: 'entity:a', text: '用 pnpm', projectId: null, proposer: 'Astro', question: null, guess: null }])
    expect(sent).toEqual([])
  })
})
