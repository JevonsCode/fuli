import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
import { useConsoleStore } from '@/stores/console'
import { useAgentAttention } from '@/features/project-agents/attention-store'
import { ApiError } from '@/api/client'
import InboxPage from './InboxPage.vue'

const { getJson, postJson } = vi.hoisted(() => ({ getJson: vi.fn(), postJson: vi.fn() }))
vi.mock('@/api/client', async importOriginal => ({ ...await importOriginal<typeof import('@/api/client')>(), getJson, postJson, putJson: vi.fn(), patchJson: vi.fn() }))

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
    // The shell's top-bar refresh reads the queue again; the page has no second one.
    expect(wrapper.get('.attention-toolbar').findAll('button').map(button => button.text())).not.toContain('刷新')
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

  describe('a linked request beyond the first page', () => {
    let exact: (requestId: string) => unknown
    beforeEach(() => {
      // 101 open requests; the list API honours limit and offset like the real one.
      open = Array.from({ length: 101 }, (_, index) => request(`request-${index + 1}`))
      exact = requestId => {
        const found = open.find(item => item.requestId === requestId)
        if (!found) throw new ApiError('attention request not found', 404)
        return found
      }
      getJson.mockImplementation(async (url: string) => {
        const query = new URL(url, 'http://fixture').searchParams
        if (url.startsWith('/api/project-agents?')) return [{ agentId: 'agent-a', profile: { name: 'Synthetic Agent', displayName: 'Milo' } }]
        if (url.startsWith('/api/agent-attention/request?')) return exact(query.get('requestId')!)
        if (url.startsWith('/api/agent-attention?')) {
          const offset = Number(query.get('offset') ?? 0)
          return { items: open.slice(offset, offset + Number(query.get('limit'))), total: open.length, counts: { 'agent-a': open.length } }
        }
        throw new Error(`Unexpected request: ${url}`)
      })
    })
    const exactReads = () => getJson.mock.calls.map(([url]) => String(url)).filter(url => url.startsWith('/api/agent-attention/request?'))
    const peekText = () => document.querySelector('[role=dialog]')?.textContent ?? ''

    it('opens the real request with its reply form, read by identity in the active space', async () => {
      const { wrapper } = await setup('/inbox?request=request-101')
      expect(wrapper.findAll('.attention-request')).toHaveLength(100)
      expect(dialogTitle()).toBe('Synthetic request-101')
      expect(peekText()).toContain('Answer the synthetic question.')
      expect(textarea()).not.toBeNull()
      expect(exactReads()).toEqual(['/api/agent-attention/request?personalSpaceId=space-a&requestId=request-101'])

      await type('Synthetic reply beyond the page')
      document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await flushPromises()
      expect(postJson).toHaveBeenCalledWith('/api/agent-attention/respond', expect.objectContaining({ personalSpaceId: 'space-a', requestId: 'request-101', expectedRevision: 1 }))
    })

    it('opens a linked request while the queue is still pending, then lets the queue take over without a second read', async () => {
      // The queue (summary and full list) stays pending until released; the exact read answers at once.
      const pending: Array<() => void> = []
      const answer = getJson.getMockImplementation()!
      getJson.mockImplementation((url: string) => url.startsWith('/api/agent-attention?')
        ? new Promise(resolve => { pending.push(() => resolve(answer(url))) })
        : answer(url))
      const { wrapper } = await setup('/inbox?request=request-100')
      expect(wrapper.findAll('.attention-request')).toHaveLength(0)
      expect(dialogTitle()).toBe('Synthetic request-100')
      expect(textarea()).not.toBeNull()
      expect(exactReads()).toHaveLength(1)

      await type('Synthetic draft while the queue loads')
      while (pending.length) { pending.shift()!(); await flushPromises() }
      expect(wrapper.findAll('.attention-request')).toHaveLength(100)
      expect(dialogTitle()).toBe('Synthetic request-100')
      expect(textarea().value).toBe('Synthetic draft while the queue loads')
      expect(exactReads()).toHaveLength(1)
    })

    it('opens a request beyond the first page while the queue never answers', async () => {
      const answer = getJson.getMockImplementation()!
      getJson.mockImplementation((url: string) => url.startsWith('/api/agent-attention?') ? new Promise(() => {}) : answer(url))
      await setup('/inbox?request=request-101')
      expect(dialogTitle()).toBe('Synthetic request-101')
      expect(peekText()).toContain('Answer the synthetic question.')
      expect(textarea()).not.toBeNull()
    })

    it('reads nothing more when a request is opened from its card', async () => {
      const { wrapper } = await setup('/inbox')
      await wrapper.findAll('.attention-request-title')[99]!.trigger('click'); await flushPromises()
      expect(dialogTitle()).toBe('Synthetic request-100')
      expect(exactReads()).toEqual([])
    })

    it('says a handled request needs no reply, and offers no form', async () => {
      exact = requestId => ({ ...request(requestId), status: 'resolved', revision: 2 })
      await setup('/inbox?request=request-handled')
      expect(dialogTitle()).toBe('Synthetic request-handled')
      expect(peekText()).toContain('这个请求已经处理，不需要再回复。')
      expect(document.querySelector('textarea')).toBeNull()
    })

    it('says a request that does not exist is not found', async () => {
      await setup('/inbox?request=request-unknown')
      expect(peekText()).toContain('当前空间里找不到这个请求')
      expect(peekText()).not.toContain('读取失败')
      expect(document.querySelector('textarea')).toBeNull()
    })

    it('tells a failed read apart from a missing request, and retries it', async () => {
      let fail = true
      exact = requestId => { if (fail) throw new ApiError('Synthetic outage', 503); return request(requestId) }
      await setup('/inbox?request=request-later')
      expect(peekText()).toContain('这条请求读取失败，请重试。')
      expect(peekText()).not.toContain('找不到')
      fail = false
      const retry = [...document.querySelectorAll<HTMLButtonElement>('[role=dialog] button')].find(button => button.textContent?.trim() === '重试')!
      retry.click(); await flushPromises()
      expect(dialogTitle()).toBe('Synthetic request-later')
      expect(textarea()).not.toBeNull()
    })

    it('treats a request from another space as not found', async () => {
      exact = requestId => ({ ...request(requestId), personalSpaceId: 'space-b' })
      await setup('/inbox?request=request-foreign')
      expect(peekText()).toContain('当前空间里找不到这个请求')
      expect(document.querySelector('textarea')).toBeNull()
    })
  })
})
