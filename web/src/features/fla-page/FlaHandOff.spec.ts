import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import type { ProjectAgentTaskRecord } from '@/types'
import FlaHandOff from './FlaHandOff.vue'
import { openWork, sessionRows } from './hand-off'
import { forgetWorkLocations } from './work-locations'

const { getJson } = vi.hoisted(() => ({ getJson: vi.fn() }))
vi.mock('@/api/client', async importOriginal => ({ ...await importOriginal<typeof import('@/api/client')>(), getJson }))

// Synthetic tasks, names and sessions only.
const task = (taskId: string, status: string, extra: Partial<ProjectAgentTaskRecord> = {}) =>
  ({ taskId, title: `Synthetic ${taskId}`, status, participants: [], ...extra }) as ProjectAgentTaskRecord
const manifest = (clients: Array<[string, number]>) => ({ clients: clients.map(([id, links]) => ({ id, sessionLinks: Array(links).fill({}) })) }) as never
const noLaunchers = {} as never

const mounted: Array<{ unmount: () => void }> = []
beforeEach(() => { setActivePinia(createPinia()); getJson.mockReset(); forgetWorkLocations() })
afterEach(() => { mounted.splice(0).forEach(wrapper => wrapper.unmount()); forgetWorkLocations(); document.body.innerHTML = '' })

describe('交给它一件事 · what the panel lists', () => {
  it('lists only unfinished tasks to continue, newest change first', () => {
    const work = openWork([task('done', 'completed'), task('a', 'queued', { updatedAt: '2026-11-01T00:00:00Z' }),
      task('b', 'awaiting_review', { updatedAt: '2026-11-03T00:00:00Z' })])
    expect(work.map(item => item.taskId)).toEqual(['b', 'a'])
  })

  it('says why a session cannot be opened: not set up here, a client that opens only itself, or no session recorded', () => {
    const rows = sessionRows([
      task('a', 'running', { sessions: [{ client: 'codex', sessionId: 'session-a' }, { client: 'cursor', sessionId: 'session-b' }] }),
      task('b', 'running', { sessions: [{ client: 'codex', sessionId: 'session-a' }, { client: 'claude_code', sessionId: null }] }),
      task('c', 'completed', { sessions: [{ client: 'kiro', sessionId: 'session-old' }] }),
    ], noLaunchers, manifest([['codex', 1], ['cursor', 0], ['claude_code', 1]]))
    expect(rows.map(row => [row.client, row.way])).toEqual([['codex', 'settings'], ['cursor', 'none'], ['claude_code', 'unknown']])
  })
})

describe('交给它一件事 · the panel', () => {
  async function open(props: Partial<InstanceType<typeof FlaHandOff>['$props']> = {}) {
    getJson.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/project-agent-work-locations?')) return { rows: [], segments: 0, conversations_read: 0, complete: true,
        continuation: { conversation_id: 'c1', personal_project_id: 'p-1', title: 'Synthetic export', prompt: '#FLA Lumen 继续。', opens: 'new_session', leaves_original: true } }
      throw new Error(`Unexpected request: ${url}`)
    })
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }] })
    await router.push('/agents/space-a/fla-1')
    const wrapper = mount(FlaHandOff, { attachTo: document.body, global: { plugins: [router] }, props: {
      spaceId: 'space-a', agentId: 'fla-1', name: 'Lumen', partner: null, kind: 'fla',
      tasks: [task('t-open', 'running')], projectName: (id: string) => (id === 'p-1' ? 'Synthetic project' : id), ...props } })
    mounted.push(wrapper)
    await flushPromises()
    await wrapper.get('[data-hand-off]').trigger('keydown', { key: 'Enter' })
    await flushPromises()
    return wrapper
  }

  it('shows each phrase in full, the work to carry elsewhere and the open task, with nothing to type', async () => {
    await open()
    const panel = document.querySelector('[data-hand-off-panel]')!
    expect(panel.querySelector('[data-hand-off-phrase="continue"]')!.textContent).toContain('#FLA Lumen')
    expect(panel.querySelector('[data-hand-off-carry]')!.textContent).toContain('Synthetic export')
    expect(panel.querySelector('[data-hand-off-task="t-open"]')!.getAttribute('href')).toBe('/agents/space-a/fla-1?task=t-open')
    expect(panel.querySelector('input, textarea')).toBeNull()
  })

  it('copies a phrase with one click', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await open()
    ;(document.querySelector('[data-hand-off-phrase="continue"]') as HTMLElement).click()
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith(expect.stringMatching(/^#FLA Lumen /))
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
