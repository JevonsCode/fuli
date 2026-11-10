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
  manualOnly?: boolean, manualUrl?: string, restartSessions?: number }
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

it('tells on the client row that open sessions need a restart, and says nothing when none do', async () => {
  routed(() => Response.json(statusOf([{ id: 'codex', restartSessions: 2 }, { id: 'cursor', label: 'Cursor', restartSessions: 0 }])))
  const wrapper = mount(ClientConnectionSettings)
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
  expect(rows[3]!.text()).toContain('只剩技能文件')
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

it('says the client component could not be downloaded when agent-installer is missing, and allows retry', async () => {
  routed(() => Response.json(statusOf([{ id: 'gemini', status: 'not_connected' }])),
    (url) => Response.json(url.endsWith('/connect')
      ? { id: 'gemini', status: 'failed', restartRequired: false, reason: 'client_component_unavailable' } : configuration))
  const wrapper = mount(ClientConnectionSettings)
  await flushPromises()
  await wrapper.get('[data-connect-client="gemini"]').trigger('click')
  await flushPromises()
  expect(wrapper.get('[role="alert"]').text()).toBe('无法下载客户端组件 agent-installer，请检查网络后重试。')
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

it('connects every client FULI can write with 一键接入, one after another, and offers no guide', async () => {
  const posted: string[] = []
  routed(() => Response.json(statusOf([{ id: 'codex', status: 'not_connected' }, { id: 'cursor', label: 'Cursor', status: 'not_connected' },
    { id: 'claude-code', label: 'Claude Code', status: 'connected' }])), (url, init) => {
    if (!url.endsWith('/connect')) return Response.json(configuration)
    posted.push(JSON.parse(String(init?.body)).clientId)
    return Response.json({ status: 'connected' })
  })
  const wrapper = mount(ClientConnectionSettings)
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
  const wrapper = mount(ClientConnectionSettings)
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
  const wrapper = mount(ClientConnectionSettings, { attachTo: document.body })
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
  const wrapper = mount(ClientConnectionSettings)
  await flushPromises()
  expect(wrapper.get('[data-client-status="changed"]').text()).toContain('配置里是 FULI 0.23.0，控制台是 0.25.0。点「更新接入」改成控制台这份。')
  wrapper.unmount()
})

it('restarts a running client only after the person confirms, in the same place as 更新接入', async () => {
  let finish: ((value: Response) => void) | undefined
  const calls = routed(() => Response.json(withInstalls([overwritten({ restart: { running: true } }) as Partial<Client>])),
    (url) => url.endsWith('/restart') ? new Promise<Response>((resolve) => { finish = resolve }) : Response.json(configuration))
  const wrapper = mount(ClientConnectionSettings, { attachTo: document.body })
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
  expect(wrapper.get('[data-restart-result]').text()).toBe('Claude Desktop 没有退出，配置没改。请手动退出后再试。')
  wrapper.unmount()
})
