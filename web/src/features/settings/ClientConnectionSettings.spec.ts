import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import ClientConnectionSettings from './ClientConnectionSettings.vue'

const server = { type: 'stdio', command: 'node', args: ['mcp-server.js'] }
const configuration = { standard: { mcpServers: { fuli: server } }, vscode: { servers: { fuli: server } }, server }
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

async function open(wrapper: ReturnType<typeof mount>) {
  const details = wrapper.get('details')
  ;(details.element as HTMLDetailsElement).open = true
  await details.trigger('toggle')
  await flushPromises()
}

it('loads only when opened and copies configuration without modifying a client', async () => {
  const fetch = vi.fn(async (url: string) => Response.json(url.endsWith('/status') ? statusOf() : configuration))
  vi.stubGlobal('fetch', fetch)
  const writeText = vi.fn(async (_text: string) => {})
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  const wrapper = mount(ClientConnectionSettings)
  expect(fetch).not.toHaveBeenCalled()
  await open(wrapper)
  const exports = () => fetch.mock.calls.filter(([url]) => !url.endsWith('/status')).length
  expect(exports()).toBe(1)
  await wrapper.get('[data-copy-connection]').trigger('click')
  expect(JSON.parse(writeText.mock.calls[0]![0] as string)).toEqual(configuration.standard)
  expect(wrapper.text()).toContain('已复制')
  expect(exports()).toBe(1)
  wrapper.unmount()
})

it('retains selectable configuration when clipboard access is unavailable', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.endsWith('/status') ? statusOf() : configuration)))
  vi.stubGlobal('navigator', {})
  const wrapper = mount(ClientConnectionSettings)
  await open(wrapper)
  await wrapper.get('[data-copy-connection]').trigger('click')
  expect(wrapper.text()).toContain('手动复制')
  expect(wrapper.get('textarea').element.value).toContain('mcpServers')
  wrapper.unmount()
})

it('can retry a failed configuration request', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({ error: { message: 'Unavailable' } }, { status: 503 }))
    .mockResolvedValueOnce(Response.json(configuration))
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/status') ? Response.json(statusOf()) : fetch()))
  const wrapper = mount(ClientConnectionSettings)
  await open(wrapper)
  expect(wrapper.find('[data-copy-connection]').exists()).toBe(false)
  await wrapper.get('[data-retry-connection]').trigger('click')
  await flushPromises()
  expect(wrapper.find('[data-copy-connection]').exists()).toBe(true)
  wrapper.unmount()
})

type Client = { id: string, label: string, detected: boolean, status: string, previouslyConnected: boolean,
  since: string | null, changes: { from: string, to: string, detectedAt: string }[], lastKnownStatus?: string | null }
function statusOf(clients: Partial<Client>[] = [], observedAt = '2026-10-13T08:00:00.000Z') {
  return { scope: 'configuration', observedAt, historySaved: true, clients: clients.map((client) => ({ id: 'codex',
    label: 'Codex', detected: true, status: 'connected', previouslyConnected: true, since: observedAt, changes: [], ...client })) }
}
function routed(status: () => Promise<Response> | Response) {
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(url)
    return url.endsWith('/status') ? status() : Response.json(configuration)
  }))
  return calls
}
const statusCalls = (calls: string[]) => calls.filter((url) => url.endsWith('/status')).length

it('shows each client’s configuration status in plain words without claiming it is running', async () => {
  routed(() => Response.json(statusOf([
    { id: 'codex', label: 'Codex', status: 'connected' },
    { id: 'claude-code', label: 'Claude Code', status: 'removed', changes: [
      { from: 'connected', to: 'removed', detectedAt: '2026-10-13T07:58:00.000Z' }] },
    { id: 'cursor', label: 'Cursor', status: 'unknown', lastKnownStatus: 'connected' },
    { id: 'claude-desktop', label: 'Claude Desktop', status: 'skills_left', previouslyConnected: false },
  ])))
  const wrapper = mount(ClientConnectionSettings)
  await open(wrapper)
  const rows = wrapper.findAll('[data-client-status]')
  expect(rows.map((row) => row.attributes('data-client-status'))).toEqual(['connected', 'removed', 'unknown', 'skills_left'])
  expect(rows[0]!.text()).toContain('已接入')
  expect(rows[1]!.text()).toContain('已移除')
  expect(rows[1]!.text()).toContain('不会自动重新安装')
  expect(rows[2]!.text()).toContain('无法读取')
  expect(rows[3]!.text()).toContain('残留')
  // Config presence never claims a live client or reachable session.
  expect(wrapper.text()).toContain('不代表客户端正在运行')
  expect(wrapper.text()).not.toMatch(/在线|运行中/)
  wrapper.unmount()
})

it('rechecks only while the card is open and the page is visible, without overlapping requests', async () => {
  vi.useFakeTimers()
  let visibility: DocumentVisibilityState = 'visible'
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
  let release: (() => void) | undefined
  const calls = routed(() => new Promise<Response>((resolve) => { release = () => resolve(Response.json(statusOf([{}]))) }))
  const wrapper = mount(ClientConnectionSettings)
  await open(wrapper)
  expect(statusCalls(calls)).toBe(1)
  // A slow request is never doubled by the timer or a manual refresh.
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
  // Returning to the page rechecks at once.
  visibility = 'visible'
  document.dispatchEvent(new Event('visibilitychange'))
  await flushPromises()
  expect(statusCalls(calls)).toBe(3)
  release!()
  await flushPromises()
  const details = wrapper.get('details')
  ;(details.element as HTMLDetailsElement).open = false
  await details.trigger('toggle')
  await vi.advanceTimersByTimeAsync(60_000)
  expect(statusCalls(calls)).toBe(3)
  wrapper.unmount()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(statusCalls(calls)).toBe(3)
  vi.useRealTimers()
})

it('ignores an older observation that arrives after a newer one and keeps the list on failure', async () => {
  const replies = [Response.json(statusOf([{ status: 'connected' }], '2026-10-13T08:01:00.000Z')),
    Response.json({ error: { message: 'Unavailable' } }, { status: 503 }),
    Response.json(statusOf([{ status: 'removed' }], '2026-10-13T08:00:00.000Z'))]
  routed(() => replies.shift()!)
  const wrapper = mount(ClientConnectionSettings)
  await open(wrapper)
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
  await open(wrapper)
  const refresh = wrapper.get('[data-refresh-clients]')
  expect(refresh.attributes('aria-label')).toBe('重新检查')
  expect(refresh.attributes('title')).toBe('重新检查')
  expect(refresh.text()).toBe('')
  expect(refresh.find('svg[aria-hidden="true"]').exists()).toBe(true)
  wrapper.unmount()
})

it('drops a response requested before the card closed and rechecks once it reopens', async () => {
  vi.useFakeTimers()
  const pending: ((response: Response) => void)[] = []
  const calls = routed(() => new Promise<Response>((resolve) => { pending.push(resolve) }))
  const wrapper = mount(ClientConnectionSettings)
  await open(wrapper)
  const details = wrapper.get('details')
  ;(details.element as HTMLDetailsElement).open = false
  await details.trigger('toggle')
  // Reopened while the old request is still pending: no second request overlaps it.
  await open(wrapper)
  expect(statusCalls(calls)).toBe(1)
  pending.shift()!(Response.json(statusOf([{ status: 'removed' }], '2026-10-13T08:05:00.000Z')))
  await flushPromises()
  expect(wrapper.find('[data-client-status]').exists()).toBe(false)
  expect(statusCalls(calls)).toBe(2)
  pending.shift()!(Response.json(statusOf([{ status: 'connected' }], '2026-10-13T08:00:00.000Z')))
  await flushPromises()
  expect(wrapper.get('[data-client-status]').attributes('data-client-status')).toBe('connected')
  wrapper.unmount()
  vi.useRealTimers()
})

it('a response that arrives while hidden or after unmount never updates the view', async () => {
  vi.useFakeTimers()
  let visibility: DocumentVisibilityState = 'visible'
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
  const pending: ((response: Response) => void)[] = []
  const calls = routed(() => new Promise<Response>((resolve) => { pending.push(resolve) }))
  const wrapper = mount(ClientConnectionSettings)
  await open(wrapper)
  visibility = 'hidden'
  document.dispatchEvent(new Event('visibilitychange'))
  pending.shift()!(Response.json(statusOf([{ status: 'removed' }])))
  await flushPromises()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(wrapper.find('[data-client-status]').exists()).toBe(false)
  expect(statusCalls(calls)).toBe(1)
  // Focus while visible again refreshes at once.
  visibility = 'visible'
  window.dispatchEvent(new Event('focus'))
  await flushPromises()
  expect(statusCalls(calls)).toBe(2)
  wrapper.unmount()
  pending.shift()!(Response.json(statusOf([{ status: 'connected' }])))
  await flushPromises()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(statusCalls(calls)).toBe(2)
  vi.useRealTimers()
})

it('connects only the selected detected client and shows restart feedback', async () => {
  let finish: ((value: Response) => void) | undefined
  const fetch = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith('/connect')) return new Promise<Response>((resolve) => { finish = resolve })
    return Response.json(url.endsWith('/status') ? statusOf([{ id: 'gemini', label: 'Gemini CLI', status: 'not_connected' }]) : configuration)
  })
  vi.stubGlobal('fetch', fetch)
  const wrapper = mount(ClientConnectionSettings)
  await open(wrapper)
  await wrapper.get('[data-connect-client="gemini"]').trigger('click')
  expect(wrapper.get('[data-connect-client="gemini"]').attributes('disabled')).toBeDefined()
  expect(wrapper.text()).toContain('正在接入 Gemini CLI')
  const call = fetch.mock.calls.find(([url]) => url.endsWith('/connect'))!
  expect(call[1]?.method).toBe('POST')
  expect(JSON.parse(call[1]?.body as string)).toEqual({ clientId: 'gemini' })
  finish!(Response.json({ id: 'gemini', status: 'connected', restartRequired: true }))
  await flushPromises()
  expect(wrapper.text()).toContain('需要重启客户端')
  wrapper.unmount()
})

it('does not offer writes for undetected, unreadable or manual-only configurations', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.endsWith('/status') ? {
    ...statusOf([{ id: 'codex', status: 'unknown' }, { id: 'cursor', status: 'removed', detected: false }]),
    clients: [...statusOf([{ id: 'codex', status: 'unknown' }, { id: 'cursor', status: 'removed', detected: false }]).clients,
      { ...statusOf([{ id: 'opencode', label: 'OpenCode', status: 'not_connected' }]).clients[0], manualOnly: true,
        manualUrl: 'https://opencode.ai/docs/config/' }],
  } : configuration)))
  const wrapper = mount(ClientConnectionSettings)
  await open(wrapper)
  expect(wrapper.find('[data-connect-client]').exists()).toBe(false)
  expect(wrapper.text()).toContain('手动接入')
  wrapper.unmount()
})

it('reports partial installs without claiming success and allows retry', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.endsWith('/connect')
    ? { id: 'gemini', status: 'partial', restartRequired: false }
    : url.endsWith('/status') ? statusOf([{ id: 'gemini', status: 'not_connected' }]) : configuration)))
  const wrapper = mount(ClientConnectionSettings)
  await open(wrapper)
  await wrapper.get('[data-connect-client="gemini"]').trigger('click')
  await flushPromises()
  expect(wrapper.text()).toContain('接入未完成')
  expect(wrapper.text()).not.toContain('需要重启客户端')
  expect(wrapper.get('[data-connect-client="gemini"]').attributes('disabled')).toBeUndefined()
  wrapper.unmount()
})
