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

const textarea = (wrapper: ReturnType<typeof mount>) => wrapper.get('textarea').element as HTMLTextAreaElement

describe('Inbox page', () => {
  it('opens the linked request as a page and keeps an unsent reply across navigation', async () => {
    const { router, wrapper } = await setup('/inbox?agent=agent-a&request=request-b')
    expect(wrapper.find('dialog').exists()).toBe(false)
    expect(wrapper.get('.attention-request.is-selected').text()).toContain('Synthetic request-b')
    expect(getJson.mock.calls.some(([url]) => String(url).includes('agentId=agent-a'))).toBe(true)

    await wrapper.get('textarea').setValue('Synthetic unsent reply')
    await router.push('/elsewhere'); await flushPromises()
    expect(useAgentAttention().open).toBe(false)
    await router.push('/inbox?agent=agent-a&request=request-b'); await flushPromises()
    expect(textarea(wrapper).value).toBe('Synthetic unsent reply')
    expect(postJson).not.toHaveBeenCalled()
  })

  it('follows a new linked request while another one is still selected', async () => {
    const { router, wrapper } = await setup('/inbox?request=request-a')
    expect(wrapper.get('.attention-request.is-selected').text()).toContain('Synthetic request-a')
    await router.push('/inbox?request=request-b'); await flushPromises()
    expect(wrapper.get('.attention-request.is-selected').text()).toContain('Synthetic request-b')
    await router.back(); await flushPromises()
    expect(wrapper.get('.attention-request.is-selected').text()).toContain('Synthetic request-a')
  })

  it('removes a confirmed reply and updates the pending count', async () => {
    const { wrapper } = await setup('/inbox')
    expect(wrapper.get('.attention-page-count').text()).toContain('2')
    await wrapper.get('textarea').setValue('Synthetic decision')
    await wrapper.get('form').trigger('submit'); await flushPromises()
    expect(postJson).toHaveBeenCalledWith('/api/agent-attention/respond', expect.objectContaining({ requestId: 'request-a', choice: null, note: 'Synthetic decision' }))
    expect(wrapper.findAll('.attention-request').map(item => item.text())).toEqual([expect.stringContaining('Synthetic request-b')])
    expect(wrapper.get('.attention-page-count').text()).toContain('1')
  })
})
