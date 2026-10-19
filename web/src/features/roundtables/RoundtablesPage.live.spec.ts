import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Live updates, overlapping reads and records on the conversations page.
const config = vi.hoisted(() => ({ gap: 0 }))
const getJson = vi.fn()
const scrolledToEnd = vi.fn()
vi.mock('@/stores/console', () => ({ useConsoleStore: () => ({ activePersonalSpace: { id: 'space' } }) }))
vi.mock('@/api/client', async (importOriginal) => ({ ...await importOriginal<typeof import('@/api/client')>(), getJson: (url: string) => getJson(url) }))
vi.mock('./roundtable-scroll', async (importOriginal) => ({
  ...await importOriginal<typeof import('./roundtable-scroll')>(),
  gapToEnd: () => config.gap,
  scrollToEnd: () => scrolledToEnd(),
}))

import { ApiError } from '@/api/client'
import { setLocale } from '@/i18n'
import RoundtablesPage from './RoundtablesPage.vue'

const members = [{ address: 'local:lead', agentId: 'lead', name: 'Lead', joinedSeq: 0 }]
const room = { chatId: 'room', kind: 'group', title: 'Room', members, transport: 'local', createdAt: '2026-10-10T09:00:00Z', updatedAt: '2026-10-10T09:05:00Z' }
const message = (seq: number) => ({ messageId: `m-${seq}`, seq, from: 'local:lead', body: `CHAT-${seq}`, createdAt: room.updatedAt })
const page = (seqs: number[], extra: Record<string, unknown> = {}) =>
  ({ ...room, hasMore: false, nextAfter: seqs.at(-1) ?? 0, messages: seqs.map(message), ...extra })
const sources: EventTarget[] = []
class Source extends EventTarget { constructor() { super(); sources.push(this) } close() {} }
const send = (type: string, data = '{}') => sources[0]!.dispatchEvent(new MessageEvent(type, { data }))
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (cause: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

async function mountAt(path: string) {
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/roundtables/chat/:chatId', component: RoundtablesPage },
    { path: '/roundtables/:threadId?', component: RoundtablesPage },
  ] })
  await router.push(path)
  const wrapper = mount(RoundtablesPage, { global: { plugins: [router] }, attachTo: document.body })
  await flushPromises()
  return { wrapper, router }
}
const shown = (wrapper: Awaited<ReturnType<typeof mountAt>>['wrapper']) =>
  wrapper.findAll('[data-roundtable-chat-message]').map(item => item.text().match(/CHAT-\d+/)?.[0])

describe('RoundtablesPage live updates', () => {
  beforeEach(() => {
    setLocale('zh-CN', { persist: false }); getJson.mockReset(); scrolledToEnd.mockReset()
    sources.length = 0; config.gap = 0; vi.stubGlobal('EventSource', Source)
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('reads a room in order, so a reconnect after a change never takes back messages already shown', async () => {
    const urls: string[] = []
    const change = deferred<unknown>()
    getJson.mockImplementation(async (url: string) => {
      urls.push(url)
      if (url === '/api/roundtable/threads') return { threads: [] }
      if (url.startsWith('/api/roundtable/chats?')) return { chats: [room], hasMore: false }
      if (url.includes('after=0')) return page([1])
      if (url.includes('after=1')) return change.promise
      return page([2], { nextAfter: 3 })
    })
    const { wrapper } = await mountAt('/roundtables/chat/room')
    send('chat', '{"chatId":"room","seq":3}')
    send('chat-ready')
    await flushPromises()
    change.resolve(page([2, 3]))
    await flushPromises()
    expect(shown(wrapper)).toEqual(['CHAT-1', 'CHAT-2', 'CHAT-3'])
    expect(urls.filter(url => url.startsWith('/api/roundtable/chats/room')).map(url => url.match(/after=\d+/)?.[0]))
      .toEqual(['after=0', 'after=1', 'after=3'])
    wrapper.unmount()
  })

  it('keeps the disconnect notice and says the reload failed until a read succeeds', async () => {
    let down = false
    getJson.mockImplementation(async (url: string) => {
      if (url === '/api/roundtable/threads') return { threads: [] }
      if (down) throw new ApiError('unavailable', 503)
      if (url.startsWith('/api/roundtable/chats?')) return { chats: [room], hasMore: false }
      return page([1, 2, 3, 4])
    })
    const { wrapper } = await mountAt('/roundtables/chat/room')
    send('chat-unavailable')
    await flushPromises()
    down = true
    await wrapper.get('[data-roundtable-live] button').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-roundtable-live]').text()).toContain('重新读取失败')
    expect(wrapper.find('[data-roundtable-chats-stale]').exists()).toBe(true)
    expect(shown(wrapper)).toHaveLength(4)
    down = false
    await wrapper.get('[data-roundtable-live] button').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-roundtable-live]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('coalesces change signals into one more list read instead of parallel reads', async () => {
    let lists = 0
    const first = deferred<unknown>()
    getJson.mockImplementation(async (url: string) => {
      if (url === '/api/roundtable/threads') return { threads: [] }
      if (url.startsWith('/api/roundtable/chats?')) return ++lists === 1 ? first.promise : { chats: [room], hasMore: false }
      return page([1])
    })
    const { wrapper } = await mountAt('/roundtables')
    send('chat', '{"chatId":"room","seq":2}')
    send('chat', '{"chatId":"room","seq":3}')
    send('chat-ready')
    await flushPromises()
    expect(lists).toBe(1)
    first.resolve({ chats: [room], hasMore: false })
    await flushPromises()
    expect(lists).toBe(2)
    wrapper.unmount()
  })

  it('frees the later-messages button when the person opens another room mid-read', async () => {
    getJson.mockImplementation(async (url: string) => {
      if (url === '/api/roundtable/threads') return { threads: [] }
      if (url.startsWith('/api/roundtable/chats?')) return { chats: [room, { ...room, chatId: 'other' }], hasMore: false }
      if (url.includes('after=1')) return new Promise(() => {})
      return { ...page([1], { hasMore: true }), chatId: url.includes('/other') ? 'other' : 'room' }
    })
    const { wrapper, router } = await mountAt('/roundtables/chat/room')
    await wrapper.get('[data-roundtable-later]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-roundtable-later]').attributes('aria-busy')).toBe('true')
    await router.push('/roundtables/chat/other')
    await flushPromises()
    expect(wrapper.get('[data-roundtable-later]').attributes('aria-busy')).toBeUndefined()
    expect(wrapper.get('[data-roundtable-later]').attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })

  it('shows every top-level field the API returned in the record, including zero and unknown fields', async () => {
    getJson.mockImplementation(async (url: string) => {
      if (url === '/api/roundtable/threads') return { threads: [] }
      if (url.startsWith('/api/roundtable/chats?')) return { chats: [room], hasMore: false }
      return page([1], { owner: 'SYNTHETIC-OWNER', revision: 0, rawField: 'RAW-ROOM-FIELD' })
    })
    const { wrapper } = await mountAt('/roundtables/chat/room')
    const record = wrapper.get('[data-roundtable-record] pre').text()
    expect(record).toContain('SYNTHETIC-OWNER')
    expect(record).toContain('"revision": 0')
    expect(record).toContain('RAW-ROOM-FIELD')
    expect(record).not.toContain('CHAT-1')
    wrapper.unmount()
  })

  it('follows new messages when the reader is at the end', async () => {
    let tail = false
    getJson.mockImplementation(async (url: string) => {
      if (url === '/api/roundtable/threads') return { threads: [] }
      if (url.startsWith('/api/roundtable/chats?')) return { chats: [room], hasMore: false }
      return tail ? page([4]) : page([1, 2, 3])
    })
    const { wrapper } = await mountAt('/roundtables/chat/room')
    tail = true
    send('chat', '{"chatId":"room","seq":4}')
    await flushPromises()
    expect(shown(wrapper)).toHaveLength(4)
    expect(scrolledToEnd).toHaveBeenCalledOnce()
    expect(wrapper.find('[data-roundtable-jump]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('offers a jump to the first new message when the reader is elsewhere', async () => {
    let tail = false
    getJson.mockImplementation(async (url: string) => {
      if (url === '/api/roundtable/threads') return { threads: [] }
      if (url.startsWith('/api/roundtable/chats?')) return { chats: [room], hasMore: false }
      return tail ? page([4]) : page([1, 2, 3])
    })
    const { wrapper } = await mountAt('/roundtables/chat/room')
    config.gap = 500
    tail = true
    send('chat', '{"chatId":"room","seq":4}')
    await flushPromises()
    expect(scrolledToEnd).not.toHaveBeenCalled()
    expect(wrapper.get('[data-roundtable-jump]').text()).toContain('有 1 条新消息')
    await wrapper.get('[data-roundtable-jump]').trigger('click')
    expect(document.activeElement?.getAttribute('data-message-id')).toBe('m-4')
    expect(wrapper.find('[data-roundtable-jump]').exists()).toBe(false)
    wrapper.unmount()
  })
})
