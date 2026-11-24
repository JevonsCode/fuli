import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { getJson } = vi.hoisted(() => ({ getJson: vi.fn() }))
vi.mock('@/api/client', async (original) => ({ ...(await original<typeof import('@/api/client')>()), getJson }))

import { setLocale } from '@/i18n'
import type { ProjectAgentTaskSession } from '@/types'
import TodayWorking from './TodayWorking.vue'
import type { WorkingRow } from './today-model'

// Synthetic sessions only. Codex opens a session by the person's default
// launcher; Claude Code's launcher is off, though the client has links of its
// own; Kiro has no link at all.
const CODEX_SESSION = '00000000-0000-4000-8000-000000000001'
const clientLinks = {
  manifest: {
    format: 'fuli-client-links', formatVersion: 1, manifestVersion: 1, updatedAt: '2026-11-01T00:00:00Z',
    clients: [
      { id: 'codex', name: 'Codex', sessionLinks: [{ opens: 'Codex', template: 'codex://threads/{sessionId}', parameters: { sessionId: { format: 'uuid' } } }], noSessionLink: null },
      { id: 'claude_code', name: 'Claude Code', sessionLinks: [{ opens: 'VS Code', template: 'vscode://anthropic.claude-code/open?session={sessionId}', parameters: { sessionId: { format: 'any' } } }], noSessionLink: null },
      { id: 'kiro', name: 'Kiro', sessionLinks: [], noSessionLink: 'No documented link.' },
    ],
  },
  source: 'bundled', autoUpdate: true, lastCheckedAt: null, history: [],
}

beforeEach(() => {
  setLocale('zh-CN', { persist: false })
  getJson.mockReset()
  getJson.mockImplementation(async (url: string) => {
    if (url === '/api/client-links') return clientLinks
    if (url === '/api/system/settings') return { configured: {} }
    throw new Error(`Unexpected request: ${url}`)
  })
})
const mounted: Array<{ unmount: () => void }> = []
afterEach(() => mounted.splice(0).forEach(wrapper => wrapper.unmount()))

async function setup(sessions: ProjectAgentTaskSession[]) {
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/', component: { template: '<div />' } },
    { path: '/agents/:spaceId/:agentId', component: { template: '<div />' } },
    { path: '/project-agents', component: { template: '<div />' } },
  ] })
  await router.push('/')
  const row: WorkingRow = { key: 'task-a', agentId: 'agent-a', projectId: 'project-a', title: 'Synthetic work', team: false, sessions }
  const wrapper = mount(TodayWorking, { attachTo: document.body, global: { plugins: [router] },
    props: { rows: [row], spaceId: 'space-a', name: () => 'Aster', project: () => 'Synthetic project' } })
  mounted.push(wrapper)
  await flushPromises()
  return { wrapper, router }
}
const marks = (wrapper: Awaited<ReturnType<typeof setup>>['wrapper']) =>
  wrapper.findAll('[data-working-client]').map(mark => [mark.attributes('data-working-client'), mark.attributes('data-way'), mark.element.tagName])

describe('the clients a piece of work runs in', () => {
  it('reads the client links when a row gets its sessions after it is shown', async () => {
    const { wrapper } = await setup([])
    expect(getJson.mock.calls.some(([url]) => String(url) === '/api/client-links')).toBe(false)
    await wrapper.setProps({ rows: [{ key: 'task-a', agentId: 'agent-a', projectId: 'project-a', title: 'Synthetic work',
      team: false, sessions: [{ client: 'claude_code', sessionId: 'session-b' }] }] })
    await flushPromises()
    expect(getJson.mock.calls.filter(([url]) => String(url) === '/api/client-links')).toHaveLength(1)
    // Claude Code's launcher is off, but its own links can still open the session: 'app', not 'none'.
    expect(marks(wrapper)).toEqual([['claude_code', 'app', 'SPAN']])
  })

  it('opens a session where the person turned its launcher on, and the row link stays put', async () => {
    const { wrapper, router } = await setup([{ client: 'codex', sessionId: CODEX_SESSION }])
    const mark = wrapper.get('[data-working-client="codex"]')
    expect(mark.element.tagName).toBe('A')
    expect(mark.attributes('href')).toBe(`codex://threads/${CODEX_SESSION}`)
    expect(mark.attributes('aria-label')).toBe('在 Codex 里打开这次会话')
    // The mark sits beside the row's link, never inside it.
    expect(wrapper.get('[data-today-working-row]').find('[data-working-client]').exists()).toBe(false)
    mark.element.addEventListener('click', event => event.preventDefault())
    await mark.trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/')
  })

  it('says a client opens only itself when it has links but not to this session from here', async () => {
    const { wrapper } = await setup([{ client: 'claude_code', sessionId: 'session-b' }])
    expect(marks(wrapper)).toEqual([['claude_code', 'app', 'SPAN']])
    expect(wrapper.get('[data-working-client="claude_code"]').attributes('title')).toBe('这里打不开 Claude Code 的这次会话，请到 Claude Code 里找它')
    expect(wrapper.find('[data-working-clients] a').exists()).toBe(false)
  })

  it('mutes a client nothing opens, and it is not a control', async () => {
    const { wrapper } = await setup([{ client: 'kiro', sessionId: 'session-k' }])
    const mark = wrapper.get('[data-working-client="kiro"]')
    expect([mark.element.tagName, mark.classes()]).toEqual(['SPAN', expect.arrayContaining(['is-muted'])])
    expect(mark.attributes('tabindex')).toBeUndefined()
    expect(mark.attributes('aria-label')).toBe('在 Kiro 里，这里打不开它')
  })

  it('shows nothing for an unknown client or no session', async () => {
    const unknown = await setup([{ client: 'other', sessionId: 'session-o' }, { client: 'mystery' as never, sessionId: 'session-m' }])
    expect(unknown.wrapper.find('[data-working-clients]').exists()).toBe(false)
    const none = await setup([])
    expect(none.wrapper.find('[data-working-clients]').exists()).toBe(false)
  })

  it('shows three marks at most, then how many more', async () => {
    const { wrapper } = await setup([
      { client: 'codex', sessionId: CODEX_SESSION }, { client: 'claude_code', sessionId: 'session-b' },
      { client: 'kiro', sessionId: 'session-k' }, { client: 'cursor', sessionId: 'session-c' },
    ])
    expect(marks(wrapper).map(([client]) => client)).toEqual(['codex', 'claude_code', 'kiro'])
    expect(wrapper.get('[data-working-clients-more]').text()).toBe('+1')
    expect(wrapper.get('[data-working-clients-more]').attributes('title')).toBe('还有 1 个客户端')
  })
})
