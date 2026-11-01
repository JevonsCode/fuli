import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { useConsoleStore } from '@/stores/console'
import ClientConnectionSettings from './ClientConnectionSettings.vue'

const server = { type: 'stdio', command: 'node', args: ['mcp-server.js'] }
const configuration = { standard: { mcpServers: { fuli: server } }, vscode: { servers: { fuli: server } }, server }
beforeEach(() => { setActivePinia(createPinia()) })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers() })

type Client = { id: string, label: string, detected: boolean, status: string, previouslyConnected: boolean,
  since: string | null, changes: { from: string, to: string, detectedAt: string }[], lastKnownStatus?: string | null,
  manualOnly?: boolean, manualUrl?: string }
type Custom = { id: string, label: string, detected: boolean, status: string, mcpPaths: string[], removable: boolean }
function statusOf(clients: Partial<Client>[] = [], observedAt = '2026-10-13T08:00:00.000Z', customClients: Custom[] = []) {
  return { scope: 'configuration', observedAt, historySaved: true, available: true, customClients,
    clients: clients.map((client) => ({ id: 'codex', label: 'Codex', detected: true, status: 'connected',
      previouslyConnected: true, since: observedAt, changes: [], ...client })) }
}
function routed(status: () => Promise<Response> | Response, other: (url: string, options?: RequestInit) => Response | Promise<Response> = () => Response.json(configuration)) {
  const calls: [string, RequestInit | undefined][] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    calls.push([url, options])
    return url.endsWith('/status') ? status() : other(url, options)
  }))
  return calls
}
const statusCalls = (calls: [string, RequestInit | undefined][]) => calls.filter(([url]) => url.endsWith('/status')).length

it('is never folded away: it checks clients and loads the snippet as soon as it shows', async () => {
  const calls = routed(() => Response.json(statusOf([{}])))
  const wrapper = mount(ClientConnectionSettings)
  expect(wrapper.find('details').exists()).toBe(false)
  await flushPromises()
  expect(statusCalls(calls)).toBe(1)
  expect(calls.filter(([url]) => url.endsWith('/client-connection'))).toHaveLength(1)
  expect(wrapper.find('[data-copy-connection]').exists()).toBe(true)
  expect(wrapper.findAll('h2').map((heading) => heading.text())).toEqual(['客户端接入'])
  wrapper.unmount()
})

it('copies configuration without modifying a client, and keeps it selectable without a clipboard', async () => {
  routed(() => Response.json(statusOf()))
  const writeText = vi.fn(async (_text: string) => {})
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  const wrapper = mount(ClientConnectionSettings)
  await flushPromises()
  await wrapper.get('[data-copy-connection]').trigger('click')
  expect(JSON.parse(writeText.mock.calls[0]![0] as string)).toEqual(configuration.standard)
  expect(wrapper.text()).toContain('已复制')
  vi.stubGlobal('navigator', {})
  await wrapper.get('[data-copy-connection]').trigger('click')
  expect(wrapper.text()).toContain('手动复制')
  expect(wrapper.get('textarea').element.value).toContain('mcpServers')
  wrapper.unmount()
})

it('can retry a failed configuration request', async () => {
  const replies = [Response.json({ error: { message: 'Unavailable' } }, { status: 503 }), Response.json(configuration)]
  routed(() => Response.json(statusOf()), () => replies.shift()!)
  const wrapper = mount(ClientConnectionSettings)
  await flushPromises()
  expect(wrapper.find('[data-copy-connection]').exists()).toBe(false)
  await wrapper.get('[data-retry-connection]').trigger('click')
  await flushPromises()
  expect(wrapper.find('[data-copy-connection]').exists()).toBe(true)
  wrapper.unmount()
})

it('sums the detected and hand-described clients FULI is in, and keeps the summary line reserved', async () => {
  routed(() => Response.json(statusOf([
    { id: 'codex', status: 'connected' },
    { id: 'cursor', label: 'Cursor', status: 'not_connected' },
    { id: 'kiro', label: 'Kiro', status: 'not_detected', detected: false },
  ], undefined, [{ id: 'acme-agent', label: 'Acme Agent', detected: true, status: 'connected', mcpPaths: ['~/.acme/mcp.json'], removable: true }])))
  const wrapper = mount(ClientConnectionSettings)
  expect(wrapper.find('[data-connection-summary]').exists()).toBe(true)
  await flushPromises()
  expect(wrapper.get('[data-connection-summary]').text()).toBe('已接入 2/3 个客户端')
  expect(wrapper.findAll('[data-client-status]').map((row) => row.attributes('data-client-status'))).toEqual(['connected', 'not_connected', 'connected'])
  expect(wrapper.get('[data-custom-client="acme-agent"]').text()).toContain('在 ~/.acme/mcp.json 加入下方配置')
  wrapper.unmount()
})

it('shows each client’s configuration status in plain words without claiming it is running', async () => {
  routed(() => Response.json(statusOf([
    { id: 'codex', label: 'Codex', status: 'connected' },
    { id: 'claude-code', label: 'Claude Code', status: 'removed', changes: [
      { from: 'connected', to: 'removed', detectedAt: '2026-10-13T07:58:00.000Z' }] },
    { id: 'cursor', label: 'Cursor', status: 'unknown', lastKnownStatus: 'connected' },
    { id: 'claude-desktop', label: 'Claude Desktop', status: 'skills_left', previouslyConnected: false },
  ])))
  const wrapper = mount(ClientConnectionSettings)
  await flushPromises()
  const rows = wrapper.findAll('[data-client-status]')
  expect(rows.map((row) => row.attributes('data-client-status'))).toEqual(['connected', 'removed', 'unknown', 'skills_left'])
  expect(rows[0]!.text()).toContain('已接入')
  expect(rows[1]!.text()).toContain('不会自动重新安装')
  expect(rows[2]!.text()).toContain('无法读取')
  expect(rows[3]!.text()).toContain('残留')
  expect(wrapper.text()).toContain('不代表客户端正在运行')
  expect(wrapper.text()).not.toMatch(/在线|运行中/)
  wrapper.unmount()
})

it('says when agent-installer could not detect anything instead of listing no clients', async () => {
  routed(() => Response.json({ ...statusOf(), available: false }))
  const wrapper = mount(ClientConnectionSettings)
  await flushPromises()
  expect(wrapper.find('[data-detection-unavailable]').exists()).toBe(true)
  expect(wrapper.find('[data-client-status]').exists()).toBe(false)
  expect(wrapper.get('[data-connection-summary]').text()).toBe('')
  expect(wrapper.get('[data-add-custom-client]').attributes('disabled')).toBeDefined()
  wrapper.unmount()
})

it('rechecks while the page is visible, without overlapping requests, and stops after unmount', async () => {
  vi.useFakeTimers()
  let visibility: DocumentVisibilityState = 'visible'
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
  let release: (() => void) | undefined
  const calls = routed(() => new Promise<Response>((resolve) => { release = () => resolve(Response.json(statusOf([{}]))) }))
  const wrapper = mount(ClientConnectionSettings)
  await flushPromises()
  expect(statusCalls(calls)).toBe(1)
  await vi.advanceTimersByTimeAsync(30_000)
  await wrapper.get('[data-refresh-clients]').trigger('click')
  expect(statusCalls(calls)).toBe(1)
  release!()
  await flushPromises()
  await vi.advanceTimersByTimeAsync(15_000)
  expect(statusCalls(calls)).toBe(2)
  release!()
  await flushPromises()
  visibility = 'hidden'
  document.dispatchEvent(new Event('visibilitychange'))
  await vi.advanceTimersByTimeAsync(60_000)
  expect(statusCalls(calls)).toBe(2)
  visibility = 'visible'
  window.dispatchEvent(new Event('focus'))
  await flushPromises()
  expect(statusCalls(calls)).toBe(3)
  release!()
  await flushPromises()
  wrapper.unmount()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(statusCalls(calls)).toBe(3)
})

it('ignores an older observation that arrives after a newer one and keeps the list on failure', async () => {
  const replies = [Response.json(statusOf([{ status: 'connected' }], '2026-10-13T08:01:00.000Z')),
    Response.json({ error: { message: 'Unavailable' } }, { status: 503 }),
    Response.json(statusOf([{ status: 'removed' }], '2026-10-13T08:00:00.000Z'))]
  routed(() => replies.shift()!)
  const wrapper = mount(ClientConnectionSettings)
  await flushPromises()
  await wrapper.get('[data-refresh-clients]').trigger('click')
  await flushPromises()
  expect(wrapper.get('[data-client-status]').attributes('data-client-status')).toBe('connected')
  expect(wrapper.text()).toContain('暂时无法检查')
  await wrapper.get('[data-refresh-clients]').trigger('click')
  await flushPromises()
  expect(wrapper.get('[data-client-status]').attributes('data-client-status')).toBe('connected')
  wrapper.unmount()
})

it('uses a labelled refresh icon instead of visible button text', async () => {
  routed(() => Response.json(statusOf([{}])))
  const wrapper = mount(ClientConnectionSettings)
  await flushPromises()
  const refresh = wrapper.get('[data-refresh-clients]')
  expect(refresh.attributes('aria-label')).toBe('重新检查')
  expect(refresh.text()).toBe('')
  expect(refresh.find('svg[aria-hidden="true"]').exists()).toBe(true)
  wrapper.unmount()
})

it('connects only the selected detected client and shows restart feedback', async () => {
  let finish: ((value: Response) => void) | undefined
  const calls = routed(() => Response.json(statusOf([{ id: 'gemini', label: 'Gemini CLI', status: 'not_connected' }])),
    (url) => url.endsWith('/connect') ? new Promise<Response>((resolve) => { finish = resolve }) : Response.json(configuration))
  const wrapper = mount(ClientConnectionSettings)
  await flushPromises()
  await wrapper.get('[data-connect-client="gemini"]').trigger('click')
  expect(wrapper.get('[data-connect-client="gemini"]').attributes('disabled')).toBeDefined()
  expect(wrapper.text()).toContain('正在接入 Gemini CLI')
  const call = calls.find(([url]) => url.endsWith('/connect'))!
  expect(call[1]?.method).toBe('POST')
  expect(JSON.parse(call[1]?.body as string)).toEqual({ clientId: 'gemini' })
  finish!(Response.json({ id: 'gemini', status: 'connected', restartRequired: true }))
  await flushPromises()
  expect(wrapper.text()).toContain('需要重启客户端')
  wrapper.unmount()
})

it('does not offer writes for undetected, unreadable or manual-only configurations', async () => {
  routed(() => Response.json(statusOf([{ id: 'codex', status: 'unknown' }, { id: 'cursor', status: 'removed', detected: false },
    { id: 'opencode', label: 'OpenCode', status: 'not_connected', manualOnly: true, manualUrl: 'https://opencode.ai/docs/config/' },
    { id: 'kiro', label: 'Kiro', status: 'not_connected', manualOnly: true }])))
  const wrapper = mount(ClientConnectionSettings)
  await flushPromises()
  expect(wrapper.find('[data-connect-client]').exists()).toBe(false)
  expect(wrapper.text()).toContain('手动接入')
  expect(wrapper.text()).toContain('用通用 MCP 配置')
  wrapper.unmount()
})

it('offers 更新接入 and 重新接入 in place of a terminal command, running the same install', async () => {
  const calls = routed(() => Response.json(statusOf([
    { id: 'codex', label: 'Codex', status: 'changed' },
    { id: 'claude-code', label: 'Claude Code', status: 'removed' },
    { id: 'gemini', label: 'Gemini CLI', status: 'not_connected' },
  ])), (url) => Response.json(url.endsWith('/connect') ? { id: 'claude-code', status: 'connected', restartRequired: true } : configuration))
  const wrapper = mount(ClientConnectionSettings)
  await flushPromises()
  expect(wrapper.text()).not.toMatch(/fuli setup|终端/)
  expect(wrapper.get('[data-connect-client="codex"]').text()).toBe('更新接入')
  expect(wrapper.get('[data-connect-client="claude-code"]').text()).toBe('重新接入')
  expect(wrapper.get('[data-connect-client="gemini"]').text()).toBe('接入')
  await wrapper.get('[data-connect-client="claude-code"]').trigger('click')
  await flushPromises()
  const call = calls.find(([url]) => url.endsWith('/connect'))!
  expect(JSON.parse(call[1]?.body as string)).toEqual({ clientId: 'claude-code' })
  expect(wrapper.text()).toContain('需要重启客户端')
  wrapper.unmount()
})

it('reports partial installs without claiming success and allows retry', async () => {
  routed(() => Response.json(statusOf([{ id: 'gemini', status: 'not_connected' }])),
    (url) => Response.json(url.endsWith('/connect') ? { id: 'gemini', status: 'partial', restartRequired: false } : configuration))
  const wrapper = mount(ClientConnectionSettings)
  await flushPromises()
  await wrapper.get('[data-connect-client="gemini"]').trigger('click')
  await flushPromises()
  expect(wrapper.text()).toContain('接入未完成')
  expect(wrapper.text()).not.toContain('需要重启客户端')
  expect(wrapper.get('[data-connect-client="gemini"]').attributes('disabled')).toBeUndefined()
  wrapper.unmount()
})

it('adds a client by hand, shows why one was refused, and removes one FULI added', async () => {
  let custom: Custom[] = []
  const replies: Record<string, () => Response> = {}
  const calls = routed(() => Response.json(statusOf([{}], new Date().toISOString(), custom)), (url, options) => {
    if (url.endsWith('/custom-clients') && options?.method === 'POST') return replies.add!()
    if (url.includes('/custom-clients/') && options?.method === 'DELETE') { custom = []; return Response.json({ id: 'acme-agent' }) }
    return Response.json(configuration)
  })
  const wrapper = mount(ClientConnectionSettings)
  await flushPromises()
  const add = wrapper.get('[data-add-custom-client]')
  await add.trigger('click')
  expect(wrapper.find('[data-add-custom-client]').exists()).toBe(false)
  await wrapper.get('#custom-client-name').setValue('Acme Agent')
  await wrapper.get('#custom-client-file').setValue('~/公司/mcp.json')
  replies.add = () => Response.json({ error: { code: 'invalid_input', message: 'the path is not plain' } }, { status: 400 })
  await wrapper.get('[data-custom-client-form]').trigger('submit')
  await flushPromises()
  expect(wrapper.text()).toContain('没有添加')
  await wrapper.get('#custom-client-file').setValue('~/.acme/mcp.json')
  replies.add = () => {
    custom = [{ id: 'acme-agent', label: 'Acme Agent', detected: false, status: 'not_detected', mcpPaths: ['~/.acme/mcp.json'], removable: true }]
    return Response.json({ id: 'acme-agent' })
  }
  await wrapper.get('[data-custom-client-form]').trigger('submit')
  await flushPromises()
  const posts = calls.filter(([url, options]) => url.endsWith('/custom-clients') && options?.method === 'POST')
  expect(JSON.parse(posts.at(-1)![1]!.body as string)).toEqual({ name: 'Acme Agent', mcpFile: '~/.acme/mcp.json', format: 'mcp-servers-json' })
  expect(wrapper.find('[data-custom-client-form]').exists()).toBe(false)
  expect(wrapper.get('[data-custom-client="acme-agent"]').text()).toContain('~/.acme/mcp.json')
  expect(wrapper.get('[data-connection-summary]').text()).toBe('已接入 1/2 个客户端')
  await wrapper.get('[data-remove-custom-client="acme-agent"]').trigger('click')
  await flushPromises()
  expect(calls.some(([url, options]) => url.endsWith('/custom-clients/acme-agent') && options?.method === 'DELETE')).toBe(true)
  expect(wrapper.find('[data-custom-client]').exists()).toBe(false)
  wrapper.unmount()
})

it('opens the first-run guide again from 设置 › 客户端', async () => {
  routed(() => Response.json(statusOf([{}])))
  const wrapper = mount(ClientConnectionSettings)
  await flushPromises()
  const store = useConsoleStore()
  expect(store.firstRunGuideShown).toBe(false)
  await wrapper.get('[data-open-first-run-guide]').trigger('click')
  expect(wrapper.get('[data-open-first-run-guide]').text()).toBe('打开入门引导')
  expect(store.firstRunGuideShown).toBe(true)
  wrapper.unmount()
})
