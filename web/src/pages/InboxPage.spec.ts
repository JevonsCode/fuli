import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
import { useConsoleStore } from '@/stores/console'
import { useAgentAttention } from '@/features/project-agents/attention-store'
import InboxPage from './InboxPage.vue'

const { getJson, postJson } = vi.hoisted(() => ({ getJson: vi.fn(), postJson: vi.fn() }))
vi.mock('@/api/client', () => ({ getJson, postJson, putJson: vi.fn(), patchJson: vi.fn() }))

const request = (id: string, agentId = 'agent-a') => ({
  requestId: id, personalSpaceId: 'space-a', personalProjectId: 'project-a', agentId, taskId: null,
  title: `Synthetic ${id}`, detail: 'Synthetic context.', requestedAction: 'Answer the synthetic question.',
  kind: 'question', status: 'open' as const, revision: 1, createdAt: '2026-10-17T00:00:00Z',
})
let open = [request('request-a'), request('request-b')]
const mounted: Array<{ unmount: () => void }> = []

beforeEach(() => {
  setActivePinia(createPinia())
  const store = useConsoleStore()
  store.state = { mode: 'connected', activePersonalSpaceId: 'space-a', personalSpaces: [{ id: 'space-a', name: 'Synthetic space' }],
    personalProjects: [{ project_id: 'project-a', personal_space_id: 'space-a', profile: { name: 'Synthetic project' } }], projects: [], subscriptions: [] }
  store.runtimeStatus = 'ready'
  open = [request('request-a'), request('request-b')]
  getJson.mockReset(); postJson.mockReset()
  getJson.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/project-agents?')) return [{ agentId: 'agent-a', profile: { name: 'Synthetic Agent', displayName: 'Milo' } }]
    if (url.startsWith('/api/agent-attention?')) return { items: open, total: open.length, counts: { 'agent-a': open.length } }
    throw new Error(`Unexpected request: ${url}`)
  })
  postJson.mockImplementation(async (_url: string, payload: { requestId: string }) => {
    open = open.filter(item => item.requestId !== payload.requestId)
    return { status: 'resolved', delivery: { status: 'inbox', agentId: 'agent-a' } }
  })
})
afterEach(() => mounted.splice(0).forEach(wrapper => wrapper.unmount()))

async function setup(path: string) {
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/inbox', component: InboxPage },
    { path: '/elsewhere', component: { template: '<p>Elsewhere</p>' } },
  ] })
  await router.push(path)
  const wrapper = mount(RouterView, { attachTo: document.body, global: { plugins: [router] } })
  mounted.push(wrapper)
  await flushPromises()
  return { router, wrapper }
}

const textarea = () => document.querySelector('textarea') as HTMLTextAreaElement
const dialogTitle = () => document.querySelector('[role=dialog] [data-slot=dialog-title]')?.textContent ?? ''
async function type(value: string) {
  textarea().value = value
  textarea().dispatchEvent(new Event('input', { bubbles: true })); await flushPromises()
}

describe('Inbox page', () => {
  it('opens a linked request as a quick look and keeps an unsent reply across navigation', async () => {
    const { router, wrapper } = await setup('/inbox?agent=agent-a&request=request-b')
    // The link becomes the request's quick look in place: ?item=<space>/<request>.
    expect(router.currentRoute.value.query).toEqual({ agent: 'agent-a', item: 'space-a/request-b' })
    expect(dialogTitle()).toBe('Synthetic request-b')
    expect(wrapper.get('.attention-request.is-selected').text()).toContain('Synthetic request-b')
    expect(getJson.mock.calls.some(([url]) => String(url).includes('agentId=agent-a'))).toBe(true)

    await type('Synthetic unsent reply')
    await router.push('/elsewhere'); await flushPromises()
    expect(useAgentAttention().open).toBe(false)
    await router.push('/inbox?agent=agent-a&request=request-b'); await flushPromises()
    expect(textarea().value).toBe('Synthetic unsent reply')
    expect(postJson).not.toHaveBeenCalled()
  })

  it('follows a new linked request while another one is still open', async () => {
    const { router, wrapper } = await setup('/inbox?request=request-a')
    expect(wrapper.get('.attention-request.is-selected').text()).toContain('Synthetic request-a')
    await router.push('/inbox?request=request-b'); await flushPromises()
    expect(wrapper.get('.attention-request.is-selected').text()).toContain('Synthetic request-b')
    await router.back(); await flushPromises()
    expect(wrapper.get('.attention-request.is-selected').text()).toContain('Synthetic request-a')
  })

  it('opens a request from its card and closes back to the queue', async () => {
    const { router, wrapper } = await setup('/inbox')
    expect(document.querySelector('[role=dialog]')).toBeNull()
    await wrapper.findAll('.attention-request-title')[1]!.trigger('click'); await flushPromises()
    expect(router.currentRoute.value.query).toEqual({ item: 'space-a/request-b' })
    expect(dialogTitle()).toBe('Synthetic request-b')
    document.querySelector<HTMLElement>('[role=dialog]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises(); await new Promise(resolve => setTimeout(resolve, 0)); await flushPromises()
    expect(router.currentRoute.value.query).toEqual({})
    expect(document.querySelector('[role=dialog]')).toBeNull()
  })

  it('removes a confirmed reply, closes its quick look and updates the pending count', async () => {
    const { router, wrapper } = await setup('/inbox')
    expect(wrapper.get('.attention-page-count').text()).toContain('2')
    await wrapper.get('.attention-request-title').trigger('click'); await flushPromises()
    await type('Synthetic decision')
    document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await flushPromises()
    await new Promise(resolve => setTimeout(resolve, 0)); await flushPromises()
    expect(postJson).toHaveBeenCalledWith('/api/agent-attention/respond', expect.objectContaining({ requestId: 'request-a', choice: null, note: 'Synthetic decision' }))
    expect(wrapper.findAll('.attention-request').map(item => item.text())).toEqual([expect.stringContaining('Synthetic request-b')])
    expect(wrapper.get('.attention-page-count').text()).toContain('1')
    expect(router.currentRoute.value.query).toEqual({})
  })
})
