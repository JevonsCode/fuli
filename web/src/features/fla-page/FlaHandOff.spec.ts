import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import type { ProjectAgentTaskRecord } from '@/types'
import FlaHandOff from './FlaHandOff.vue'
import { closedSessionNotes, sessionRows } from './hand-off'
import { forgetWorkLocations } from './work-locations'

const { getJson, postJson } = vi.hoisted(() => ({ getJson: vi.fn(), postJson: vi.fn() }))
vi.mock('@/api/client', async importOriginal => ({ ...await importOriginal<typeof import('@/api/client')>(), getJson, postJson }))

// Synthetic tasks, names, clients and sessions only.
const task = (taskId: string, status: string, extra: Partial<ProjectAgentTaskRecord> = {}) =>
  ({ taskId, title: `Synthetic ${taskId}`, status, participants: [], ...extra }) as ProjectAgentTaskRecord
const manifestOf = (clients: Array<[string, number]>) => ({ clients: clients.map(([id, links]) => ({ id, sessionLinks: Array(links).fill({}) })) }) as never
const noLaunchers = {} as never
const link = (id: string, template: string, parameter: string) => ({ id, opens: 'App', template,
  parameters: { [parameter]: { format: parameter === 'prompt' ? 'any' : 'uuid' } }, platforms: ['windows', 'macos', 'linux'], notes: 'Synthetic.', source: 'https://example.test/docs' })
const manifest = { format: 'fuli-client-links', formatVersion: 1, manifestVersion: 2, updatedAt: '2026-11-07', clients: [
  { id: 'codex', name: 'Codex', noSessionLink: null, sessionLinks: [link('codex-new', 'codex://new?prompt={prompt}', 'prompt')] },
  { id: 'opencode', name: 'OpenCode', noSessionLink: 'Synthetic: no link.', sessionLinks: [] },
] }
const client = (id: string, label: string, sourceApplication: string, status = 'connected') => ({ id, label, status, sourceApplication })

const mounted: Array<{ unmount: () => void }> = []
const writeText = vi.fn(async (_text: string) => {})
beforeEach(() => {
  setActivePinia(createPinia()); getJson.mockReset(); postJson.mockReset(); writeText.mockReset(); forgetWorkLocations()
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
})
afterEach(() => { mounted.splice(0).forEach(wrapper => wrapper.unmount()); forgetWorkLocations(); document.body.innerHTML = '' })

describe('交给它一件事 · the sessions its open tasks run in', () => {
  it('says why a session cannot be opened: not set up here, a client that opens only itself, or no session recorded', () => {
    const rows = sessionRows([
      task('a', 'running', { sessions: [{ client: 'codex', sessionId: 'session-a' }, { client: 'cursor', sessionId: 'session-b' }] }),
      task('b', 'running', { sessions: [{ client: 'codex', sessionId: 'session-a' }, { client: 'claude_code', sessionId: null }] }),
      task('c', 'completed', { sessions: [{ client: 'kiro', sessionId: 'session-old' }] }),
    ], noLaunchers, manifestOf([['codex', 1], ['cursor', 0], ['claude_code', 1]]))
    expect(rows.map(row => [row.client, row.way])).toEqual([['codex', 'settings'], ['cursor', 'none'], ['claude_code', 'unknown']])
  })

  it('folds the sessions that cannot open into one note per reason, the one 去设置 fixes first', () => {
    const notes = closedSessionNotes([
      { key: 'a', client: 'cursor', name: 'Cursor', way: 'none' },
      { key: 'b', client: 'codex', name: 'Codex', way: 'settings' },
      { key: 'c', client: 'kiro', name: 'Kiro', way: 'none' },
      { key: 'd', client: 'codex', name: 'Codex', way: 'session', href: 'codex://threads/x' },
    ], (clients, why) => `${clients} / ${why}`)
    expect(notes).toEqual([{ why: 'settings', text: 'Codex / settings' }, { why: 'none', text: 'Cursor · Kiro / none' }])
  })
})

describe('交给它一件事 · the menu', () => {
  async function open(clients: ReturnType<typeof client>[], props: Partial<InstanceType<typeof FlaHandOff>['$props']> = {}) {
    getJson.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/project-agent-work-locations?')) return { rows: [], segments: 0, conversations_read: 0, complete: true, continuation: null }
      if (url === '/api/client-links') return { manifest, source: 'bundled', remoteUrl: 'https://example.test', autoUpdate: false, lastCheckedAt: null, history: [] }
      if (url === '/api/system/client-connection/status') return { available: true, clients, customClients: [] }
      throw new Error(`Unexpected request: ${url}`)
    })
    postJson.mockImplementation(async (url: string) => {
      if (url === '/api/session-launch/new-session/ways') return { launcher: 'synthetic', ways: { 'claude-code': { prompt: 'send' } } }
      if (url === '/api/session-launch/new-session') return { status: 'launch_requested' }
      throw new Error(`Unexpected request: ${url}`)
    })
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }] })
    await router.push('/agents/space-a/fla-1')
    const wrapper = mount(FlaHandOff, { attachTo: document.body, global: { plugins: [router] }, props: {
      spaceId: 'space-a', agentId: 'fla-1', name: 'Lumen', partner: null, kind: 'fla',
      tasks: [task('t-open', 'running')], projectName: (id: string) => id, ...props } })
    mounted.push(wrapper)
    await flushPromises()
    expect(postJson).not.toHaveBeenCalled()
    wrapper.get<HTMLButtonElement>('[data-hand-off]').element.focus()
    await wrapper.get('[data-hand-off]').trigger('keydown', { key: 'Enter' })
    await flushPromises()
    return wrapper
  }
  const panel = () => document.querySelector('[data-hand-off-panel]') as HTMLElement

  it('opens a new conversation in each client that can, with the opening message in it and nothing to type', async () => {
    await open([client('codex', 'Codex', 'codex'), client('claude-code', 'Claude Code', 'claude_code'), client('opencode', 'OpenCode', 'opencode')])
    const codex = panel().querySelector<HTMLAnchorElement>('[data-hand-off-client="codex"]')!
    expect(codex.textContent).toContain('在 Codex 里新开')
    // The protocol stays in what is sent; the row itself says it in words.
    expect(decodeURIComponent(codex.href)).toContain('#FLA Lumen 在这里继续')
    expect(panel().textContent).not.toContain('#FLA')
    expect(panel().querySelector('[data-hand-off-client="claude-code"]')!.textContent).toContain('新窗口')
    // A client with no way to open one is not a row of its own.
    expect(panel().querySelector('[data-hand-off-client="opencode"]')).toBeNull()
    expect(panel().querySelector('[data-hand-off-fallback]')).toBeNull()
    expect(panel().querySelector('input, textarea')).toBeNull()
    expect(panel().querySelector('[data-hand-off-task]')).toBeNull()
  })

  it('opens the terminal way with the opening message when its row is chosen', async () => {
    await open([client('claude-code', 'Claude Code', 'claude_code')])
    panel().querySelector<HTMLElement>('[data-hand-off-client="claude-code"]')!.click()
    await flushPromises()
    expect(postJson).toHaveBeenCalledWith('/api/session-launch/new-session', { client: 'claude-code', prompt: '#FLA Lumen 在这里继续' }, expect.anything())
  })

  it('falls back to copying the opening message only when no client can open it, saying why and where to set it up', async () => {
    await open([client('opencode', 'OpenCode', 'opencode')])
    const fallback = panel().querySelector<HTMLElement>('[data-hand-off-fallback]')!
    expect(fallback.textContent).toContain('复制开场话')
    expect(fallback.textContent).toContain('还没有能带着开场话直接新开对话的客户端')
    expect(panel().querySelector('[data-hand-off-clients]')!.getAttribute('href')).toBe('/settings?tab=clients')
    fallback.click()
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith('#FLA Lumen 在这里继续')
  })

  it('lists sessions that open one row each and the rest in one note, with 去设置 when that fixes it', async () => {
    await open([], { tasks: [task('t-open', 'running', { sessions: [{ client: 'codex', sessionId: 'session-a' }, { client: 'claude_code', sessionId: null }] })] })
    expect(panel().querySelector('[data-hand-off-note="unknown"]')!.textContent).toContain('没记下是哪一次会话')
    expect(panel().querySelectorAll('[data-hand-off-session]')).toHaveLength(0)
  })

  it('reaches every row with the arrow keys, and Escape closes it back on the button', async () => {
    const wrapper = await open([client('codex', 'Codex', 'codex')])
    const items = [...panel().querySelectorAll<HTMLElement>('[role="menuitem"]')]
    expect(items.length).toBeGreaterThan(1)
    for (const item of items) expect(item.hasAttribute('data-disabled')).toBe(false)
    items[0]!.focus()
    items[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    await flushPromises()
    expect(document.activeElement).toBe(items[1])
    items[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(panel()).toBeNull()
    expect(document.activeElement).toBe(wrapper.get('[data-hand-off]').element)
  })

  it('is not offered when there is nothing to hand over', async () => {
    getJson.mockResolvedValue({ rows: [], segments: 0, conversations_read: 0, complete: true, continuation: null })
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }] })
    const wrapper = mount(FlaHandOff, { global: { plugins: [router] }, props: {
      spaceId: 'space-a', agentId: 'fla-1', name: 'Lumen', partner: null, kind: null, tasks: [], projectName: (id: string) => id } })
    mounted.push(wrapper)
    await flushPromises()
    expect(wrapper.find('[data-hand-off]').exists()).toBe(false)
  })
})
