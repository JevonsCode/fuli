import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { useConsoleStore } from '@/stores/console'
import FlaBlockedTasks from './FlaBlockedTasks.vue'

// Synthetic tasks only.
const blocked = (taskId: string, title: string, reason: string) => ({
  taskId, title, status: 'blocked', personalSpaceId: 'space-a', personalProjectId: 'project-a',
  ownerAgentId: 'lead-1', participants: [], createdAt: '2026-11-10T08:00:00.000Z', updatedAt: '2026-11-12T08:00:00.000Z',
  blocker: { reason, since: '2026-11-12T08:00:00.000Z', agentId: 'lead-1', application: 'codex', sessionId: null, sessionUrl: null, observed: false },
})

type Call = { url: string; method: string; body: unknown }
function serve(list: unknown[]) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null })
    const body = method === 'GET' ? list : { ...(list[0] as object), status: 'running', blocker: null }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }))
  return calls
}

const router = () => createRouter({ history: createMemoryHistory(), routes: [{ path: '/:any(.*)*', component: { template: '<div />' } }] })
function render() {
  return mount(FlaBlockedTasks, {
    props: { spaceId: 'space-a', agentId: 'lead-1', agentName: 'Lumen', projectName: (id: string) => `Project ${id}` },
    global: { plugins: [router()] }, attachTo: document.body,
  })
}

beforeEach(() => setActivePinia(createPinia()))
afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = '' })

describe('an FLA page\'s blocked tasks', () => {
  it('shows nothing when no task is blocked', async () => {
    const calls = serve([])
    const wrapper = render()
    await flushPromises()
    expect(calls[0]!.url).toBe('/api/project-agent-tasks?personalSpaceId=space-a&agentId=lead-1&status=blocked&limit=50')
    expect(wrapper.find('[data-widget="fla-blocked"]').exists()).toBe(false)
    expect(wrapper.text()).toBe('')
  })

  it('lists one row per blocked task with its reason and the clear action on the right', async () => {
    serve([blocked('task-a', 'Migrate staging', 'Need the staging region.'), blocked('task-b', 'Rotate keys', 'Waiting for the vault owner.'),
      { ...blocked('task-c', 'Someone else', 'x'), ownerAgentId: 'other-agent' }])
    const wrapper = render()
    await flushPromises()
    const rows = wrapper.findAll('[data-blocked-task]')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.get('[data-blocked-reason]').text()).toBe('Need the staging region.')
    expect(rows[0]!.text()).toContain('Project project-a')
    // The action is the row's last cell, so it stays in one place on the right.
    expect(rows[0]!.element.lastElementChild?.hasAttribute('data-blocker-clear')).toBe(true)
    expect(rows[0]!.get('a').attributes('href')).toBe('/agents/space-a/lead-1?task=task-a')
  })

  it('clears through the task list\'s route and names the task with a link in the toast', async () => {
    const calls = serve([blocked('task-a', 'Migrate staging', 'Need the staging region.')])
    const wrapper = render()
    await flushPromises()
    await wrapper.get('[data-blocker-clear-open]').trigger('click')
    await flushPromises()
    ;(document.querySelector('[data-blocker-clear-confirm]') as HTMLButtonElement).click()
    await flushPromises()
    const post = calls.find(call => call.method === 'POST')!
    expect(post.url).toBe('/api/project-agent-tasks/task-a/blocker/clear')
    expect(post.body).toEqual({ personalSpaceId: 'space-a', personalProjectId: 'project-a', note: null })
    expect(wrapper.find('[data-widget="fla-blocked"]').exists()).toBe(false)
    expect(useConsoleStore().feedback).toEqual({ message: '已解除「Migrate staging」的阻塞', tone: 'success',
      link: { to: '/agents/space-a/lead-1?task=task-a' } })
  })
})
