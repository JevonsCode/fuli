import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

import ClientConnectionSettings from './ClientConnectionSettings.vue'
import ClientManualConnection from './ClientManualConnection.vue'
import { provideClientConnectionStatus } from './client-connection-status'

// The clients tab's two cards over the one status they share (ClientsSettingsTab.vue).
const ClientCards = defineComponent({
  setup() {
    provideClientConnectionStatus()
    return () => [h(ClientConnectionSettings), h(ClientManualConnection)]
  },
})

const server = { type: 'stdio', command: 'node', args: ['mcp-server.js'] }
const configuration = { standard: { mcpServers: { fuli: server } }, vscode: { servers: { fuli: server } }, server }
beforeEach(() => { setActivePinia(createPinia()) })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers() })

type Client = { id: string, label: string, detected: boolean, status: string, previouslyConnected: boolean,
  since: string | null, changes: { from: string, to: string, detectedAt: string }[], lastKnownStatus?: string | null,
  manualOnly?: boolean, manualUrl?: string, restartSessions?: number, firstRun?: { id: string, command: string }, inWsl?: boolean, entryFile?: { path: string, problem: string }, components?: Record<string, string> }
type Custom = { id: string, label: string, detected: boolean, status: string, mcpPaths: string[], removable: boolean, components?: Record<string, string> }
function statusOf(clients: Partial<Client>[] = [], observedAt = '2026-10-13T08:00:00.000Z', customClients: Custom[] = []) {
  return { scope: 'configuration', observedAt, historySaved: true, available: true, customClients,
    clients: clients.map((client) => ({ id: 'codex', label: 'Codex', detected: true, status: 'connected',
      previouslyConnected: true, since: observedAt, changes: [], ...client })) }
}
// A status read, with or without ?afterProbe=1.
const isStatus = (url: string) => new URL(url, 'http://console.invalid').pathname.endsWith('/status')
function routed(status: () => Promise<Response> | Response, other: (url: string, options?: RequestInit) => Response | Promise<Response> = () => Response.json(configuration)) {
  const calls: [string, RequestInit | undefined][] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    calls.push([url, options])
    return isStatus(url) ? status() : other(url, options)
  }))
  return calls
}
const statusCalls = (calls: [string, RequestInit | undefined][]) => calls.filter(([url]) => isStatus(url)).length

it('is never folded away: it checks clients and loads the snippet as soon as it shows', async () => {
  const calls = routed(() => Response.json(statusOf([{}])))
  const wrapper = mount(ClientCards)
  expect(wrapper.find('details').exists()).toBe(false)
  await flushPromises()
  expect(statusCalls(calls)).toBe(1)
  expect(calls.filter(([url]) => url.endsWith('/client-connection'))).toHaveLength(1)
  expect(wrapper.find('[data-copy-connection]').exists()).toBe(true)
  expect(wrapper.findAll('h2').map((heading) => heading.text())).toEqual(['客户端接入', '手动接入'])
  wrapper.unmount()
})

it('copies configuration without modifying a client, and keeps it selectable without a clipboard', async () => {
  routed(() => Response.json(statusOf()))
  const writeText = vi.fn(async (_text: string) => {})
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  const wrapper = mount(ClientCards)
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
  const wrapper = mount(ClientCards)
  await flushPromises()
  expect(wrapper.find('[data-copy-connection]').exists()).toBe(false)
  await wrapper.get('[data-retry-connection]').trigger('click')
  await flushPromises()
  expect(wrapper.find('[data-copy-connection]').exists()).toBe(true)
  wrapper.unmount()
})

it('on a runner says its hooks do nothing and which computer runs the older FULI (rec issues 144, 145)', async () => {
  const runner = { version: '0.28.1', hostName: 'Workshop Mac', hostReachable: true, hostVersion: '0.29.0',
    skew: { older: 'runner' as const } }
  routed(() => Response.json({ ...statusOf([{ id: 'cursor', label: 'Cursor', status: 'connected',
    firstRun: { id: 'cursor', command: 'cursor-agent mcp enable fuli' } }]), runner }))
  const wrapper = mount(ClientCards)
  await flushPromises()
  const notice = wrapper.get('[data-runner-clients]').text()
  expect(notice).toContain('Workshop Mac')
  expect(notice).toContain('可能漏')
  expect(notice).toContain('这台是 0.28.1，主机是 0.29.0')
  expect(notice).toContain('这台旧了')
  // The update goes to the person's own AI through the one AI entry (UiAiButton).
  const entry = wrapper.get('[data-runner-update]')
  expect(entry.attributes('data-ai-entry')).toBe('')
  expect(entry.attributes('aria-label')).toBe('让 AI 来做：更新这台电脑的 FULI')
  // Cursor's own first question is said on its tile, in words for the person only.
  const first = wrapper.get('[data-client-first-run="cursor"]').text()
  expect(first).toContain('信任这个文件夹')
  expect(first).not.toContain('--trust')
  wrapper.unmount()
})

it('runs Cursor\'s first-run step for one folder after showing the command, and says how it went', async () => {
  const posted: unknown[] = []
  routed(() => Response.json(statusOf([{ id: 'cursor', label: 'Cursor', status: 'connected',
    firstRun: { id: 'cursor', command: 'cursor-agent mcp enable fuli' } }])), (url, options) => {
    if (url.endsWith('/first-run')) {
      posted.push(JSON.parse(String(options?.body)))
      return Response.json({ id: 'cursor', status: 'no_answer', command: 'cursor-agent mcp enable fuli', folder: '/work/blue-kettle', waitedMs: 20000 })
    }
    return Response.json(configuration)
  })
  const wrapper = mount(ClientCards)
  await flushPromises()
  await wrapper.get('[data-first-run-start]').trigger('click')
  await wrapper.get('[data-first-run-folder]').setValue('/work/blue-kettle')
  // What will run, and where, before it runs.
  expect(wrapper.get('[data-first-run-command]').text()).toBe('将在 /work/blue-kettle 里运行：cursor-agent mcp enable fuli')
  await wrapper.get('form').trigger('submit')
  await flushPromises()
  expect(posted).toEqual([{ clientId: 'cursor', folder: '/work/blue-kettle' }])
  expect(wrapper.get('[data-first-run-outcome="no_answer"]').text()).toContain('20 秒内没有回应')
  wrapper.unmount()
})

it('shows a client still being looked for as 检测中, not as missing, and reads again as soon as the search ends', async () => {
  const replies = [
    { ...statusOf([{ id: 'codex', status: 'connected' }, { id: 'cursor', label: 'Cursor', status: 'probing', detected: false }]), probing: true },
    statusOf([{ id: 'codex', status: 'connected' }, { id: 'cursor', label: 'Cursor', status: 'not_connected' }], '2026-10-13T08:00:01.000Z'),
  ]
  const calls = routed(() => Response.json(replies.shift()))
  const wrapper = mount(ClientCards)
  for (let round = 0; round < 4; round++) await flushPromises()
  const statusUrls = calls.map(([url]) => url).filter((url) => url.includes('/status'))
  // The second read waits on the server for the search, rather than for the next 15-second round.
  expect(statusUrls).toEqual(['/api/system/client-connection/status', '/api/system/client-connection/status?afterProbe=1'])
  expect(wrapper.get('[data-client-status="not_connected"]').text()).toContain('Cursor')
  wrapper.unmount()
})

it('a client being looked for is not counted as not installed', async () => {
  let release: (() => void) | undefined
  routed(() => new Promise<Response>((resolve) => {
    release = () => resolve(Response.json({ ...statusOf([{ id: 'codex', status: 'connected' },
      { id: 'cursor', label: 'Cursor', status: 'probing', detected: false }]), probing: true }))
  }))
  const wrapper = mount(ClientCards)
  release!()
  await flushPromises()
  expect(wrapper.get('[data-client-status="probing"]').text()).toContain('检测中')
  expect(wrapper.get('[data-connection-summary]').text()).toBe('已接入 1/2 个客户端')
  wrapper.unmount()
})

it('says which configuration file has a problem instead of offering an update that would fail again, and shows it', async () => {
  const posted: string[] = []
  routed(() => Response.json(statusOf([{ id: 'opencode', label: 'OpenCode', status: 'unknown', lastKnownStatus: null,
    entryFile: { path: '~/.config/opencode/opencode.json', problem: 'Invalid JSON.' } }])), (url) => {
    posted.push(url)
    return url.endsWith('/reveal') ? Response.json({ id: 'opencode', revealed: true }) : Response.json(configuration)
  })
  const wrapper = mount(ClientCards)
  await flushPromises()
  const tile = wrapper.get('[data-client-status="unknown"]')
  expect(tile.text()).toContain('~/.config/opencode/opencode.json 有问题')
  expect(tile.text()).toContain('Invalid JSON.')
  expect(tile.find('[data-connect-client]').exists()).toBe(false)
  await wrapper.get('[data-reveal-client-file="opencode"]').trigger('click')
  await flushPromises()
  expect(posted.filter((url) => url.endsWith('/reveal'))).toHaveLength(1)
  wrapper.unmount()
})

it('shows a client installed only inside WSL with why FULI cannot connect it, and does not count it as missing', async () => {
  routed(() => Response.json(statusOf([
    { id: 'codex', status: 'connected' },
    { id: 'opencode', label: 'OpenCode', status: 'not_detected', detected: false, inWsl: true },
    { id: 'kiro', label: 'Kiro', status: 'not_detected', detected: false },
  ])))
  const wrapper = mount(ClientCards)
  await flushPromises()
  const tile = wrapper.get('[data-client-status="not_detected"]')
  expect(tile.text()).toContain('在 WSL 里')
  expect(tile.text()).toContain('这台 Windows 上的 FULI 接不到它')
  expect(tile.find('[data-connect-client]').exists()).toBe(false)
  expect(wrapper.get('[data-connection-summary]').text()).toBe('已接入 1/2 个客户端，另有 1 个这台电脑上没装')
  wrapper.unmount()
})

it('says nothing about a runner on the host, and nothing about versions when they match', async () => {
  routed(() => Response.json({ ...statusOf([{}]),
    runner: { version: '0.29.0', hostName: 'Workshop Mac', hostReachable: false, hostVersion: '0.29.0' } }))
  const wrapper = mount(ClientCards)
  await flushPromises()
  expect(wrapper.get('[data-runner-clients]').text()).not.toContain('版本')
  expect(wrapper.find('[data-runner-update]').exists()).toBe(false)
  expect(wrapper.find('[data-client-first-run="codex"]').exists()).toBe(false)
  wrapper.unmount()
})

it('tells on the client row that open sessions need a restart, and says nothing when none do', async () => {
  routed(() => Response.json(statusOf([{ id: 'codex', restartSessions: 2 }, { id: 'cursor', label: 'Cursor', restartSessions: 0 }])))
  const wrapper = mount(ClientCards)
  await flushPromises()
  const rows = wrapper.findAll('[data-client-restart]')
  expect(rows).toHaveLength(1)
  expect(rows[0].text()).toContain('2 个打开的会话要重启')
  wrapper.unmount()
})

it('sums the detected and hand-described clients FULI is in, and keeps the summary line reserved', async () => {
  routed(() => Response.json(statusOf([
    { id: 'codex', status: 'connected' },
    { id: 'cursor', label: 'Cursor', status: 'not_connected' },
    { id: 'kiro', label: 'Kiro', status: 'not_detected', detected: false },
  ], undefined, [{ id: 'acme-agent', label: 'Acme Agent', detected: true, status: 'connected', mcpPaths: ['~/.acme/mcp.json'], removable: true }])))
  const wrapper = mount(ClientCards)
  expect(wrapper.find('[data-connection-summary]').exists()).toBe(true)
  await flushPromises()
  // A client FULI knows of but did not find here is counted apart, never silently dropped (rec issues 90, 145).
  expect(wrapper.get('[data-connection-summary]').text()).toBe('已接入 2/3 个客户端，另有 1 个这台电脑上没装')
  expect(wrapper.findAll('[data-client-status]').map((row) => row.attributes('data-client-status'))).toEqual(['connected', 'not_connected', 'connected'])
  expect(wrapper.get('[data-custom-client="acme-agent"]').text()).toContain('配置文件：~/.acme/mcp.json')
  // The add tile closes the grid, after every client.
  expect(wrapper.get('.client-grid').element.lastElementChild?.querySelector('[data-add-custom-client]')).not.toBeNull()
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
  const wrapper = mount(ClientCards)
  await flushPromises()
  const rows = wrapper.findAll('[data-client-status]')
  expect(rows.map((row) => row.attributes('data-client-status'))).toEqual(['connected', 'removed', 'unknown', 'skills_left'])
  expect(rows[0]!.text()).toContain('已接入')
  expect(rows[1]!.text()).toContain('不会自动重新安装')
  expect(rows[2]!.text()).toContain('无法读取')
  expect(rows[3]!.text()).toContain('只剩技能文件')
  expect(wrapper.text()).toContain('不代表客户端正在运行')
  expect(wrapper.text()).not.toMatch(/在线|运行中/)
  wrapper.unmount()
})

it('says when agent-installer could not detect anything instead of listing no clients, and checks again from the notice', async () => {
  const calls = routed(() => Response.json({ ...statusOf(), available: false }))
  const wrapper = mount(ClientCards)
  await flushPromises()
  expect(wrapper.find('[data-detection-unavailable]').exists()).toBe(true)
  const before = statusCalls(calls)
  await wrapper.get('[data-detection-unavailable] [data-check-again]').trigger('click')
  await flushPromises()
  expect(statusCalls(calls)).toBe(before + 1)
  expect(wrapper.find('[data-client-status]').exists()).toBe(false)
  expect(wrapper.get('[data-connection-summary]').text()).toBe('')
  expect(wrapper.find('[data-add-custom-client]').exists()).toBe(false)
  wrapper.unmount()
})

it('says another FULI is downloading agent-installer and reads again soon until the clients show', async () => {
  vi.useFakeTimers()
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => 'visible')
  let downloading = true
  const calls = routed(() => Response.json(downloading ? { ...statusOf(), available: false, componentDownloading: true }
    : statusOf([{ id: 'gemini', status: 'not_connected' }])))
  const wrapper = mount(ClientCards)
  await flushPromises()
  expect(wrapper.get('[data-component-downloading]').text()).toContain('另一个 FULI 正在下载客户端组件 agent-installer')
  expect(wrapper.find('[data-detection-unavailable]').exists()).toBe(false)
  downloading = false
  await vi.advanceTimersByTimeAsync(3_000)
  await flushPromises()
  expect(statusCalls(calls)).toBe(2)
  expect(wrapper.find('[data-component-downloading]').exists()).toBe(false)
  expect(wrapper.find('[data-client-status]').exists()).toBe(true)
  wrapper.unmount()
})

it('rechecks while the page is visible, without overlapping requests, and stops after unmount', async () => {
  vi.useFakeTimers()
  let visibility: DocumentVisibilityState = 'visible'
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
  let release: (() => void) | undefined
  const calls = routed(() => new Promise<Response>((resolve) => { release = () => resolve(Response.json(statusOf([{}]))) }))
  const wrapper = mount(ClientCards)
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
  const wrapper = mount(ClientCards)
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
  const wrapper = mount(ClientCards)
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
  const wrapper = mount(ClientCards)
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
  const wrapper = mount(ClientCards)
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
  const wrapper = mount(ClientCards)
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
  const wrapper = mount(ClientCards)
  await flushPromises()
  await wrapper.get('[data-connect-client="gemini"]').trigger('click')
  await flushPromises()
  expect(wrapper.text()).toContain('接入未完成')
  expect(wrapper.text()).not.toContain('需要重启客户端')
  expect(wrapper.get('[data-connect-client="gemini"]').attributes('disabled')).toBeUndefined()
  wrapper.unmount()
})

it('says another FULI is downloading agent-installer when a connection waits on it', async () => {
  routed(() => Response.json(statusOf([{ id: 'gemini', status: 'not_connected' }])),
    (url) => Response.json(url.endsWith('/connect')
      ? { id: 'gemini', status: 'failed', restartRequired: false, reason: 'client_component_downloading' } : configuration))
  const wrapper = mount(ClientCards)
  await flushPromises()
  await wrapper.get('[data-connect-client="gemini"]').trigger('click')
  await flushPromises()
  expect(wrapper.get('[role="alert"]').text()).toBe('另一个 FULI 正在下载客户端组件 agent-installer，下载完成后再试。')
  wrapper.unmount()
})

it('says the client component could not be downloaded when agent-installer is missing, and allows retry', async () => {
  routed(() => Response.json(statusOf([{ id: 'gemini', status: 'not_connected' }])),
    (url) => Response.json(url.endsWith('/connect')
      ? { id: 'gemini', status: 'failed', restartRequired: false, reason: 'client_component_unavailable' } : configuration))
  const wrapper = mount(ClientCards)
  await flushPromises()
  await wrapper.get('[data-connect-client="gemini"]').trigger('click')
  await flushPromises()
  expect(wrapper.get('[role="alert"]').text()).toBe('无法下载客户端组件 agent-installer，请检查网络后重试。')
  expect(wrapper.get('[data-connect-client="gemini"]').attributes('disabled')).toBeUndefined()
  wrapper.unmount()
})

it('adds a client from the grid\'s last tile, connects it like the others, and removes one FULI added', async () => {
  let custom: Custom[] = []
  const replies: Record<string, () => Response> = {}
  const calls = routed(() => Response.json(statusOf([{}], new Date().toISOString(), custom)), (url, options) => {
    if (url.endsWith('/custom-clients') && options?.method === 'POST') return replies.add!()
    if (url.includes('/custom-clients/') && options?.method === 'DELETE') { custom = []; return Response.json({ id: 'acme-agent' }) }
    if (url.endsWith('/connect')) {
      custom = custom.map((client) => ({ ...client, detected: true, status: 'connected' }))
      return Response.json({ id: 'acme-agent', status: 'connected', restartRequired: true })
    }
    return Response.json(configuration)
  })
  const wrapper = mount(ClientCards, { attachTo: document.body })
  await flushPromises()
  await wrapper.get('[data-add-custom-client]').trigger('click')
  const field = (selector: string) => document.querySelector<HTMLInputElement>(selector)!
  const fill = async (selector: string, value: string) => {
    field(selector).value = value
    field(selector).dispatchEvent(new Event('input'))
    await flushPromises()
  }
  const submit = async () => {
    document.querySelector('[data-custom-client-form]')!.dispatchEvent(new Event('submit', { cancelable: true }))
    await flushPromises()
  }
  // The dialog opens on the prompt to send to that client, filled with this console; the form waits behind a link.
  const writeText = vi.fn(async (_text: string) => {})
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  const prompt = document.querySelector('[data-add-client-prompt] pre')!.textContent!
  expect(prompt).toContain(`${window.location.origin}/settings?tab=clients&addClient=`)
  expect(prompt.split('\n')[0]).not.toMatch(/[<>]/)
  expect(document.querySelector('[data-custom-client-form]')).toBeNull()
  ;(document.querySelector('[data-copy-add-client-prompt]') as HTMLElement).click()
  await flushPromises()
  expect(writeText).toHaveBeenCalledWith(prompt)
  ;(document.querySelector('[data-add-client-by-hand]') as HTMLElement).click()
  await flushPromises()
  await fill('#custom-client-name', 'Acme Agent')
  await fill('#custom-client-file', '~/公司/mcp.json')
  replies.add = () => Response.json({ error: { code: 'invalid_input', message: 'the path is not plain' } }, { status: 400 })
  await submit()
  const refused = document.querySelector('[data-custom-client-dialog]')!.textContent!
  expect(refused).toContain('没有添加：配置文件要在你的用户目录里')
  expect(refused, 'the answer\'s JSON is not shown to a person').not.toContain('invalid_input')
  replies.add = () => new Response('upstream stopped', { status: 502 })
  await submit()
  expect(document.querySelector('[data-custom-client-dialog]')!.textContent, 'another failure keeps its own reason').not.toContain('配置文件要在')
  await fill('#custom-client-file', '~/.acme/mcp.json')
  replies.add = () => {
    custom = [{ id: 'acme-agent', label: 'Acme Agent', detected: false, status: 'not_detected', mcpPaths: ['~/.acme/mcp.json'], removable: true }]
    return Response.json({ id: 'acme-agent' })
  }
  await submit()
  const posts = calls.filter(([url, options]) => url.endsWith('/custom-clients') && options?.method === 'POST')
  expect(JSON.parse(posts.at(-1)![1]!.body as string)).toEqual({ name: 'Acme Agent', mcpFile: '~/.acme/mcp.json', format: 'mcp-servers-json' })
  expect(document.querySelector('[data-custom-client-dialog]')).toBeNull()
  const tile = () => wrapper.get('[data-custom-client="acme-agent"]')
  expect(tile().text()).toContain('配置文件：~/.acme/mcp.json')
  // 添加并接入: FULI writes its entry right after adding it, so the tile reads connected with no second click.
  expect(JSON.parse(calls.find(([url]) => url.endsWith('/connect'))![1]!.body as string)).toEqual({ clientId: 'acme-agent' })
  expect(wrapper.get('[data-connection-summary]').text()).toBe('已接入 2/2 个客户端')
  expect(wrapper.find('[data-connect-client="acme-agent"]').exists()).toBe(false)
  await wrapper.get('[data-remove-custom-client="acme-agent"]').trigger('click')
  await flushPromises()
  expect(calls.some(([url, options]) => url.endsWith('/custom-clients/acme-agent') && options?.method === 'DELETE')).toBe(true)
  expect(wrapper.find('[data-custom-client]').exists()).toBe(false)
  wrapper.unmount()
})

it('connects every client FULI can write with 一键接入, one after another, and offers no guide', async () => {
  const posted: string[] = []
  routed(() => Response.json(statusOf([{ id: 'codex', status: 'not_connected' }, { id: 'cursor', label: 'Cursor', status: 'not_connected' },
    { id: 'claude-code', label: 'Claude Code', status: 'connected' }])), (url, init) => {
    if (!url.endsWith('/connect')) return Response.json(configuration)
    posted.push(JSON.parse(String(init?.body)).clientId)
    return Response.json({ status: 'connected' })
  })
  const wrapper = mount(ClientCards)
  await flushPromises()
  expect(wrapper.find('[data-open-first-run-guide]').exists()).toBe(false)
  const all = wrapper.get('[data-connect-all]')
  expect(all.text()).toBe('一键接入')
  await all.trigger('click')
  await flushPromises()
  expect(posted).toEqual(['codex', 'cursor'])
  wrapper.unmount()
})

it('reads every status again as each client of 一键接入 is written and when it ends, naming the client being written', async () => {
  // Jevons 0.25.0: after 一键接入 the tiles kept 「需要更新」 until one client's own 更新 was clicked.
  const server: Record<string, string> = { codex: 'changed', cursor: 'changed' }
  const pending: (() => void)[] = []
  const calls = routed(() => Response.json(statusOf([{ id: 'codex', status: server.codex },
    { id: 'cursor', label: 'Cursor', status: server.cursor }])), (url, init) => {
    if (url.endsWith('/doctor')) return Response.json({ checkedAt: '', version: '', overall: 'ok', items: [], unchecked: [] })
    if (!url.endsWith('/connect')) return Response.json(configuration)
    const id = JSON.parse(String(init?.body)).clientId as string
    return new Promise<Response>((resolve) => pending.push(() => {
      server[id] = 'connected'
      resolve(Response.json({ id, status: 'connected', restartRequired: true }))
    }))
  })
  const wrapper = mount(ClientCards)
  await flushPromises()
  const rows = () => wrapper.findAll('[data-client-status]').map(row => row.attributes('data-client-status'))
  expect(rows()).toEqual(['changed', 'changed'])
  const before = statusCalls(calls)

  await wrapper.get('[data-connect-all]').trigger('click')
  await flushPromises()
  // One indicator, in the summary line, naming the real request; the button keeps its words and place.
  expect(wrapper.get('[data-connecting-all]').attributes('aria-label')).toBe('正在接入 2 个客户端：Codex（1/2）')
  expect(wrapper.findAll('[role="status"][aria-busy], .button-loading')).toHaveLength(0)
  expect(wrapper.get('[data-connect-all]').text()).toBe('一键接入')

  pending.shift()!()
  await flushPromises()
  expect(rows()).toEqual(['connected', 'changed'])
  expect(wrapper.get('[data-connecting-all]').attributes('aria-label')).toBe('正在接入 2 个客户端：Cursor（2/2）')

  pending.shift()!()
  await flushPromises()
  expect(rows()).toEqual(['connected', 'connected'])
  expect(wrapper.find('[data-connecting-all]').exists()).toBe(false)
  expect(wrapper.get('[data-connection-summary]').text()).toBe('已接入 2/2 个客户端')
  expect(statusCalls(calls) - before).toBe(2)
  // The 设置 dot's source is read again too.
  expect(calls.some(([url]) => url.endsWith('/api/system/doctor'))).toBe(true)
  wrapper.unmount()
})

// rec#106: Claude Desktop writes its cached entry back; the tile says so, shows the difference and the full history.
const installs = { console: { path: '~/fuli-prerelease/FULI.app', version: '0.25.0' },
  others: [{ path: '/Applications/FULI.app', version: '0.23.0', clients: ['Claude Desktop'] }] }
const overwritten = (extra: Record<string, unknown> = {}) => ({ id: 'claude-desktop', label: 'Claude Desktop', status: 'changed', overwritten: true,
  configuredInstall: { path: '/Applications/FULI.app', version: '0.23.0', exists: true, sameAsConsole: false },
  changes: [{ from: 'connected', to: 'changed', detectedAt: '2026-11-10T10:56:04.000Z' },
    { from: 'changed', to: 'connected', detectedAt: '2026-11-10T13:15:42.000Z' },
    { from: 'connected', to: 'changed', detectedAt: '2026-11-10T13:18:31.000Z', overwritten: true }], ...extra })
const withInstalls = (clients: Partial<Client>[]) => ({ ...statusOf(clients), installs })

it('says the client wrote its old entry back, which FULI each side runs, and two installations', async () => {
  routed(() => Response.json(withInstalls([overwritten() as Partial<Client>])))
  const wrapper = mount(ClientCards, { attachTo: document.body })
  await flushPromises()
  const tile = wrapper.get('[data-client-status="changed"]')
  expect(tile.text()).toContain('Claude Desktop 把旧配置写回了。先完全退出它，再点「更新接入」，然后重新打开。')
  expect(tile.get('[data-connect-client="claude-desktop"]').text()).toBe('更新接入')
  expect(wrapper.get('[data-two-installs]').text()).toContain('本机有 2 份 FULI。控制台用 0.25.0，Claude Desktop 还指向另一份。')

  // The one-line history opens 查看详情 with every change, full times and both installations.
  await tile.get('[data-client-details="claude-desktop"]').trigger('click')
  await flushPromises()
  const dialog = document.querySelector('[data-client-details-dialog]')!
  expect(dialog.textContent).toContain('/Applications/FULI.app')
  expect(dialog.querySelector('[data-detail-configured]')!.textContent).toContain('0.23.0')
  expect(dialog.querySelector('[data-detail-console]')!.textContent).toContain('0.25.0')
  const changes = [...dialog.querySelectorAll('[data-detail-change]')].map(item => item.textContent ?? '')
  expect(changes).toHaveLength(3)
  expect(changes[0]).toContain('被客户端写回')
  expect(changes[0]).toMatch(/2026/)
  expect(document.body.textContent).toContain('保存设置或退出时写回文件')
  wrapper.unmount()
})

it('names the version difference of an outdated entry instead of a generic sentence', async () => {
  routed(() => Response.json(withInstalls([{ ...overwritten({ overwritten: false, changes: [] }) } as Partial<Client>])))
  const wrapper = mount(ClientCards)
  await flushPromises()
  expect(wrapper.get('[data-client-status="changed"]').text()).toContain('配置里是 FULI 0.23.0，控制台是 0.25.0。点「更新接入」改成控制台这份。')
  wrapper.unmount()
})

it('restarts a running client only after the person confirms, in the same place as 更新接入', async () => {
  let finish: ((value: Response) => void) | undefined
  const calls = routed(() => Response.json(withInstalls([overwritten({ restart: { running: true } }) as Partial<Client>])),
    (url) => url.endsWith('/restart') ? new Promise<Response>((resolve) => { finish = resolve }) : Response.json(configuration))
  const wrapper = mount(ClientCards, { attachTo: document.body })
  await flushPromises()
  expect(wrapper.find('[data-connect-client="claude-desktop"]').exists()).toBe(false)
  const button = wrapper.get('[data-restart-client="claude-desktop"]')
  expect(button.text()).toBe('重启并更新')
  expect(button.classes()).toContain('client-row__action')
  // 一键接入 would only be written back while it runs.
  expect(wrapper.get('[data-connect-all]').attributes('disabled')).toBeDefined()
  expect(wrapper.text()).toContain('Claude Desktop 把旧配置写回了。点「重启并更新」：退出、更新、再打开。')
  await button.trigger('click')
  await flushPromises()
  expect(calls.some(([url]) => url.endsWith('/restart'))).toBe(false)
  expect(document.querySelector('[data-restart-confirm]')!.textContent).toContain('正在进行的任务和会话会中断')
  ;(document.querySelector('[data-restart-confirmed]') as HTMLButtonElement).click()
  await flushPromises()
  const call = calls.find(([url]) => url.endsWith('/restart'))!
  expect(call[1]?.method).toBe('POST')
  expect(JSON.parse(call[1]?.body as string)).toEqual({ clientId: 'claude-desktop' })
  expect(wrapper.text()).toContain('正在重启 Claude Desktop 并更新接入')
  finish!(Response.json({ id: 'claude-desktop', status: 'quit_failed' }))
  await flushPromises()
  expect(wrapper.get('[data-restart-result]').text()).toBe('没能确认 Claude Desktop 已退出，配置没改。请手动退出后再试。')
  wrapper.unmount()
})

it('shows every capability on each tile: installed, needing an update, or not supported with what that costs', async () => {
  routed(() => Response.json(statusOf([
    { id: 'claude-code', label: 'Claude Code', status: 'connected', components: { mcp: 'current', hooks: 'current', skills: 'outdated', permissions: 'current' } },
    { id: 'kiro', label: 'Kiro', status: 'connected', components: { mcp: 'current' } },
  ], undefined, [{ id: 'acme-agent', label: 'Acme Agent', detected: true, status: 'connected', mcpPaths: ['~/.acme/mcp.json'], removable: true,
    components: { mcp: 'current' } }])))
  const wrapper = mount(ClientCards)
  await flushPromises()
  const parts = (id: string) => wrapper.get(`[data-client-parts="${id}"]`).findAll('[data-part]').map((part) => part.text())
  const ALL = ['MCP', '自动进入与收尾', 'Skills', '全局说明', '权限白名单', '/fla 菜单']
  expect(parts('claude-code')).toEqual(['MCP', '自动进入与收尾', 'Skills · 需更新', '全局说明', '权限白名单', '/fla 菜单'])
  expect(parts('kiro')).toEqual(ALL)
  expect(parts('acme-agent')).toEqual(ALL)
  const state = (id: string, part: string) => wrapper.get(`[data-client-parts="${id}"] [data-part="${part}"]`).attributes('data-part-state')
  expect([state('claude-code', 'hooks'), state('claude-code', 'skills'), state('claude-code', 'prompts')]).toEqual(['current', 'outdated', 'unsupported'])
  expect(state('kiro', 'skills')).toBe('unsupported')
  // A capability the client does not take says what is missing without it.
  expect(wrapper.get('[data-client-parts="kiro"] [data-part="hooks"]').attributes('title'))
    .toBe('这个客户端不支持：不会自动开任务和收尾，要靠 Agent 按 FULI 的说明调用，也不会自动记录对话。')
  const tile = (id: string) => wrapper.get(`[data-client-parts="${id}"]`).element.closest('li.client-row')!
  expect(tile('claude-code').querySelector('[data-client-no-lifecycle]')).toBeNull()
  expect(tile('kiro').querySelector('[data-client-no-lifecycle]')!.textContent).toContain('靠模型自己进入任务')
  // Each part is explained by the glossary's 「?」 and by its hover title.
  expect(wrapper.get('[data-client-parts="claude-code"] [data-part="skills"]').attributes('data-term')).toBe('setting.clientPart.skills')
  expect(wrapper.get('[data-client-parts="claude-code"] [data-part="skills"]').attributes('title')).toBe('需更新：教客户端里的 Agent 怎么用 FULI。')
  wrapper.unmount()
})

it('a client\'s add link opens the dialog filled in; adding stays the person\'s click, which connects it too', async () => {
  let custom: Custom[] = []
  const calls = routed(() => Response.json(statusOf([{}], new Date().toISOString(), custom)), (url, options) => {
    if (url.endsWith('/custom-clients') && options?.method === 'POST') {
      custom = [{ id: 'acme-agent', label: 'Acme Agent', detected: false, status: 'not_detected', mcpPaths: ['~/.acme/mcp.json'], removable: true }]
      return Response.json({ id: 'acme-agent' })
    }
    if (url.endsWith('/connect')) return Response.json({ id: 'acme-agent', status: 'connected', restartRequired: true })
    return Response.json(configuration)
  })
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:any(.*)*', component: { template: '<div />' } }] })
  await router.push('/settings?tab=clients&addClient=Acme%20Agent&mcpFile=~%2F.acme%2Fmcp.json&format=codex-toml')
  const wrapper = mount(ClientCards, { attachTo: document.body, global: { plugins: [router] } })
  await flushPromises()
  // Nothing is written by opening the link.
  expect(calls.some(([url, options]) => url.endsWith('/custom-clients') && options?.method === 'POST')).toBe(false)
  // Any page may open the link, so the dialog says the link filled it, not which client.
  expect(document.querySelector('[data-custom-client-dialog]')!.textContent).toContain('添加链接填好了这三项，核对文件路径后再点「添加并接入」。')
  expect(document.querySelector('[data-add-client-prompt]')).toBeNull()
  expect(document.querySelector<HTMLInputElement>('#custom-client-name')!.value).toBe('Acme Agent')
  expect(document.querySelector<HTMLInputElement>('#custom-client-file')!.value).toBe('~/.acme/mcp.json')
  expect(router.currentRoute.value.query).toEqual({ tab: 'clients' })
  document.querySelector('[data-custom-client-form]')!.dispatchEvent(new Event('submit', { cancelable: true }))
  await flushPromises()
  const post = calls.find(([url, options]) => url.endsWith('/custom-clients') && options?.method === 'POST')!
  expect(JSON.parse(post[1]!.body as string)).toEqual({ name: 'Acme Agent', mcpFile: '~/.acme/mcp.json', format: 'codex-toml' })
  expect(JSON.parse(calls.find(([url]) => url.endsWith('/connect'))![1]!.body as string)).toEqual({ clientId: 'acme-agent' })
  expect(document.querySelector('[data-custom-client-dialog]')).toBeNull()
  wrapper.unmount()
})

it('a client just added that cannot be connected says why on its tile, and the dialog opens fresh again', async () => {
  let custom: Custom[] = []
  routed(() => Response.json(statusOf([{}], new Date().toISOString(), custom)), (url, options) => {
    if (url.endsWith('/custom-clients') && options?.method === 'POST') {
      custom = [{ id: 'acme-agent', label: 'Acme Agent', detected: true, status: 'not_connected', mcpPaths: ['~/.acme/mcp.json'], removable: true }]
      return Response.json({ id: 'acme-agent' })
    }
    if (url.endsWith('/connect')) return Response.json({ id: 'acme-agent', status: 'failed', restartRequired: false, reason: 'client_running' })
    return Response.json(configuration)
  })
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async (_text: string) => {}) } })
  const wrapper = mount(ClientCards, { attachTo: document.body })
  await flushPromises()
  await wrapper.get('[data-add-custom-client]').trigger('click')
  ;(document.querySelector('[data-copy-add-client-prompt]') as HTMLElement).click()
  await flushPromises()
  ;(document.querySelector('[data-add-client-by-hand]') as HTMLElement).click()
  await flushPromises()
  for (const [selector, value] of [['#custom-client-name', 'Acme Agent'], ['#custom-client-file', '~/.acme/mcp.json']]) {
    document.querySelector<HTMLInputElement>(selector!)!.value = value!
    document.querySelector<HTMLInputElement>(selector!)!.dispatchEvent(new Event('input'))
  }
  await flushPromises()
  document.querySelector('[data-custom-client-form]')!.dispatchEvent(new Event('submit', { cancelable: true }))
  await flushPromises()
  // The same answer a click on its tile's 接入 gives.
  expect(wrapper.get('[data-custom-client="acme-agent"] [role="alert"]').text()).toBe('它正在运行，会把旧配置写回，所以没写。先完全退出它，或点「重启并更新」。')
  expect(wrapper.get('[data-connect-client="acme-agent"]').attributes('disabled')).toBeUndefined()
  // Opened again, it starts on the prompt, not copied, with the form behind its link.
  await wrapper.get('[data-add-custom-client]').trigger('click')
  await flushPromises()
  expect(document.querySelector('[data-add-client-prompt]')).not.toBeNull()
  expect(document.querySelector('[data-copy-add-client-prompt]')!.textContent).toBe('复制')
  expect(document.querySelector('[data-custom-client-form]')).toBeNull()
  wrapper.unmount()
})
