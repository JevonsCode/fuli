import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const config = vi.hoisted(() => ({ space: null as { id: string } | null }))
const getJson = vi.fn()
const postJson = vi.fn()
const putJson = vi.fn()
vi.mock('@/stores/console', async () => {
  const { reactive } = await import('vue')
  const store = reactive({ activePersonalSpace: null as { id: string } | null })
  return { useConsoleStore: () => { store.activePersonalSpace = config.space; return store } }
})
vi.mock('@/api/client', async (importOriginal) => ({ ...await importOriginal<typeof import('@/api/client')>(),
  getJson: (url: string) => getJson(url), postJson: (url: string, body: unknown) => postJson(url, body),
  putJson: (url: string, body: unknown) => putJson(url, body) }))

import { setLocale } from '@/i18n'
import RoundtablesPage from './RoundtablesPage.vue'
import { useRoundtableListCollapse } from './roundtable-list-collapse'
import { agentAvatarUrl } from '@/features/agent-profile/agent-avatar'

const thread = {
  id: 'thread-1', subject: '登录重构评审过了吗？', projectId: 'app', updatedAt: '2026-10-10T08:00:00Z', messageCount: 2,
  participants: [{ agentId: 'lead-1', name: 'Milo Reed', client: 'claude_code' }, { agentId: 'reviewer-1', name: 'Nova Lane', client: 'codex' }],
  waiting: false, last: { from: 'Nova Lane', body: '评审过了' },
}
const detail = { id: 'thread-1', subject: thread.subject, projectId: 'app', createdAt: '2026-10-10T07:59:00Z', messages: [
  { id: 'm-1', kind: 'ask', status: 'answered', body: '登录重构评审过了吗？', inReplyTo: null, via: 'codex:resume', error: null, createdAt: '2026-10-10T07:59:00Z',
    from: { agentId: 'lead-1', name: 'Milo Reed', client: 'claude_code' }, to: { agentId: 'reviewer-1', name: 'Nova Lane', client: 'codex' } },
  { id: 'm-2', kind: 'reply', status: 'sent', body: '评审过了', inReplyTo: 'm-1', via: 'codex:resume', error: null, createdAt: '2026-10-10T08:00:00Z',
    from: { agentId: 'reviewer-1', name: 'Nova Lane', client: 'codex' }, to: { agentId: 'lead-1', name: 'Milo Reed', client: 'claude_code' } },
] }

// jsdom has no matchMedia, so the page lays out wide unless a test narrows it.
function narrowWindow() {
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: query === '(max-width: 767px)', media: query,
    addEventListener: vi.fn(), removeEventListener: vi.fn() })))
}

async function mountAt(path: string) {
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/roundtables/chat/:chatId', component: RoundtablesPage },
    { path: '/roundtables/:threadId?', component: RoundtablesPage },
  ] })
  await router.push(path)
  const wrapper = mount(RoundtablesPage, { global: { plugins: [router] } })
  await flushPromises()
  return wrapper
}

describe('RoundtablesPage', () => {
  beforeEach(() => {
    setLocale('zh-CN', { persist: false }); getJson.mockReset(); postJson.mockReset(); putJson.mockReset()
    const { collapsed } = useRoundtableListCollapse()
    collapsed.value = false
    localStorage.clear()
  })

  it('gives each participant one stable identity colour across the participant chips and timeline', async () => {
    getJson.mockImplementation(async (url: string) => url === '/api/roundtable/threads' ? { threads: [thread] } : detail)
    const wrapper = await mountAt('/roundtables/thread-1')
    const faces = wrapper.findAll('[data-roundtable-seat]').map((seat) => seat.attributes('style'))
    const avatars = wrapper.findAll('.roundtable-avatar').map((avatar) => avatar.attributes('style'))
    expect(faces[0]).toMatch(/--agent-identity: var\(--identity-[0-7]\)/)
    expect(avatars).toEqual(faces)
    expect(wrapper.findAll('.roundtable-avatar img').map(image => image.attributes('src'))).toEqual(
      ['lead-1', 'reviewer-1'].map(agentAvatarUrl),
    )
    expect(wrapper.findAll('.roundtable-seat-face img').map(image => image.attributes('src'))).toEqual(
      ['lead-1', 'reviewer-1'].map(agentAvatarUrl),
    )
    wrapper.unmount()
  })

  it('shows who talked to whom, through which client, and what was said', async () => {
    getJson.mockImplementation(async (url: string) => url === '/api/roundtable/threads' ? { threads: [thread] } : detail)
    const wrapper = await mountAt('/roundtables')
    expect(wrapper.get('[data-testid="roundtable-thread"]').text()).toContain('Milo Reed · Nova Lane')
    expect(wrapper.get('[data-roundtable-none]').text()).toBe('选择一段对话')
    await wrapper.vm.$router.push('/roundtables/thread-1')
    await flushPromises()
    // A wide window keeps the list beside the open conversation, the open row marked; no back step.
    expect(wrapper.get('[data-testid="roundtable-thread"] a').attributes('aria-current')).toBe('page')
    expect(wrapper.find('[data-roundtable-back]').exists()).toBe(false)
    expect(wrapper.find('[data-roundtable-none]').exists()).toBe(false)
    const timeline = wrapper.get('[data-testid="roundtable-timeline"]')
    expect(timeline.text()).toContain('Claude Code')
    expect(timeline.text()).toContain('Nova Lane 已回复')
    expect(timeline.text()).toContain('评审过了')
    expect(timeline.text()).toContain('唤醒原会话回答')
    wrapper.unmount()
  })

  it('shows one-way requests in the chat and says who and why it waits', async () => {
    const waiting = { ...thread, waiting: true, waitingFor: ['Cora Fenn'] }
    const pendingDetail = { ...detail, messages: [
      ...detail.messages,
      { id: 'm-3', kind: 'ask', status: 'queued', body: '能看一下部署吗？', inReplyTo: null, via: null, error: 'no_client', createdAt: '2026-10-10T08:05:00Z',
        from: { agentId: 'lead-1', name: 'Milo Reed', client: 'claude_code' }, to: { agentId: 'ops-1', name: 'Cora Fenn', client: null } },
      { id: 'm-4', kind: 'ask', status: 'failed', body: '远端可以接吗？', inReplyTo: null, via: 'peer', error: 'peer_send_failed', createdAt: '2026-10-10T08:06:00Z',
        from: { agentId: 'lead-1', name: 'Milo Reed', client: 'claude_code' }, to: { agentId: 'peer:remote', name: 'Remote Lead', client: null } },
    ] }
    getJson.mockImplementation(async (url: string) => url === '/api/roundtable/threads' ? { threads: [waiting] } : pendingDetail)
    const wrapper = await mountAt('/roundtables')
    expect(wrapper.get('[data-roundtable-waiting]').text()).toBe('等待 Cora Fenn')
    await wrapper.vm.$router.push('/roundtables/thread-1')
    await flushPromises()
    // One chat: every message in order, each with where it stands for its recipient.
    const bubbles = wrapper.findAll('[data-roundtable-bubble]')
    expect(bubbles.map(bubble => bubble.text())).toEqual([
      expect.stringContaining('登录重构评审过了吗？'), expect.stringContaining('评审过了'),
      expect.stringContaining('能看一下部署吗？'), expect.stringContaining('远端可以接吗？'),
    ])
    expect(bubbles[2]!.text()).toContain('没能立即叫醒 Cora Fenn：对方没有这台电脑上能叫醒的客户端')
    expect(bubbles[3]!.text()).toContain('没有送到 Remote Lead：发送到对方设备失败')
    expect(wrapper.find('[data-roundtable-record]').exists()).toBe(false)
    const seats = wrapper.findAll('[data-roundtable-seat]')
    expect(seats.map(seat => seat.text())).toEqual([
      expect.stringContaining('Milo Reed'), expect.stringContaining('Nova Lane'),
      expect.stringContaining('Cora Fenn'), expect.stringContaining('Remote Lead'),
    ])
    expect(seats[2]!.text()).toContain('待回应')
    expect(seats[3]!.text()).not.toContain('待回应')
    wrapper.unmount()
  })

  it('lists Agent chat rooms beside asks and shows a room with its members and messages', async () => {
    const members = [
      { address: 'local:lead-1', agentId: 'lead-1', name: 'Milo Reed', joinedSeq: 0 },
      { address: 'local:ops-1', agentId: 'ops-1', name: 'Cora Fenn', joinedSeq: 0 },
    ]
    const room = { chatId: 'room-1', kind: 'group', title: null, members, transport: 'local', createdAt: '2026-10-10T09:00:00Z', updatedAt: '2026-10-10T09:05:00Z' }
    getJson.mockImplementation(async (url: string) => {
      if (url === '/api/roundtable/threads') return { threads: [thread] }
      if (url.startsWith('/api/roundtable/chats?')) return { chats: [room], hasMore: false }
      if (url.startsWith('/api/roundtable/chats/room-1')) return { ...room, hasMore: false, nextAfter: 2, messages: [
        { messageId: 'c-1', seq: 1, from: 'local:lead-1', body: '部署窗口定在今晚', createdAt: '2026-10-10T09:01:00Z' },
        { messageId: 'c-2', seq: 2, from: 'local:ops-1', body: '收到，我来值守', createdAt: '2026-10-10T09:02:00Z' },
      ] }
      return detail
    })
    const wrapper = await mountAt('/roundtables')
    const rooms = wrapper.findAll('[data-testid="roundtable-chat-room"]')
    expect(rooms).toHaveLength(1)
    expect(rooms[0]!.text()).toContain('群聊 · 2')
    expect(rooms[0]!.text()).toContain('Milo Reed · Cora Fenn')
    expect(wrapper.findAll('[data-testid="roundtable-thread"]')).toHaveLength(1)
    await wrapper.vm.$router.push('/roundtables/chat/room-1')
    await flushPromises()
    const open = wrapper.get('[data-testid="roundtable-chat"]')
    expect(open.findAll('[data-roundtable-chat-message]').map(item => item.text())).toEqual([
      expect.stringContaining('部署窗口定在今晚'), expect.stringContaining('收到，我来值守'),
    ])
    expect(open.findAll('[data-roundtable-seat]').map(seat => seat.text())).toEqual([
      expect.stringContaining('Milo Reed'), expect.stringContaining('Cora Fenn'),
    ])
    wrapper.unmount()
  })

  it('still shows asks when the server has no chat rooms', async () => {
    getJson.mockImplementation(async (url: string) => {
      if (url === '/api/roundtable/threads') return { threads: [thread] }
      if (url.startsWith('/api/roundtable/chats?')) throw new Error('404')
      return detail
    })
    const wrapper = await mountAt('/roundtables')
    expect(wrapper.findAll('[data-testid="roundtable-thread"]')).toHaveLength(1)
    expect(wrapper.find('[data-testid="roundtable-chat-room"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('shows how Agents start talking when there are no conversations, and offers no new conversation', async () => {
    getJson.mockImplementation(async (url: string) => url.startsWith('/api/roundtable/chats?') ? { chats: [], hasMore: false } : { threads: [] })
    const wrapper = await mountAt('/roundtables')
    expect(wrapper.get('[data-roundtable-empty]').text()).toBe('还没有对话')
    expect(wrapper.findAll('[data-roundtable-prompts]')).toHaveLength(1)
    expect(wrapper.get('[data-roundtable-prompts]').text()).toBe('Agent 怎么开始对话')
    expect(wrapper.text()).not.toContain('新对话')
    wrapper.unmount()
  })

  it('groups instant conversations and chat rooms apart from the message board', async () => {
    const members = [{ address: 'local:lead-1', agentId: 'lead-1', name: 'Milo Reed', joinedSeq: 0 }]
    const room = { chatId: 'room-1', kind: 'direct', title: 'Room', members, transport: 'local', createdAt: '2026-10-10T09:00:00Z', updatedAt: '2026-10-10T09:05:00Z' }
    getJson.mockImplementation(async (url: string) => url.startsWith('/api/roundtable/chats?') ? { chats: [room], hasMore: false }
      : { threads: [{ ...thread, id: 'board-1', subject: '留言', mode: 'board' }, { ...thread, id: 'instant-1', subject: '即时', mode: 'instant' }, { ...thread, id: 'agents-1', subject: 'Agent 之间', mode: null }] })
    const wrapper = await mountAt('/roundtables')
    const group = (delivery: string) => wrapper.get(`[data-roundtable-group="${delivery}"]`)
    expect(wrapper.findAll('[data-roundtable-group]').map(item => item.attributes('data-roundtable-group'))).toEqual(['instant', 'board'])
    expect(group('instant').get('h2').text()).toContain('即时对话')
    expect(group('instant').findAll('[data-roundtable-key]').map(row => row.attributes('data-roundtable-key'))).toEqual(['thread:instant-1', 'thread:agents-1', 'chat:room-1'])
    expect(group('board').get('h2').text()).toContain('留言板')
    expect(group('board').findAll('a').map(row => row.attributes('data-delivery'))).toEqual(['board'])
    wrapper.unmount()
  })

  it('folds the list to portraits named by their conversation, and remembers it', async () => {
    getJson.mockImplementation(async (url: string) => url.startsWith('/api/roundtable/chats?') ? { chats: [], hasMore: false } : { threads: [thread] })
    const wrapper = await mountAt('/roundtables')
    const fold = wrapper.get('[data-roundtable-fold]')
    expect(fold.attributes('aria-expanded')).toBe('true')
    await fold.trigger('click')
    const row = wrapper.get('[data-testid="roundtable-thread"] a')
    expect(row.classes()).toContain('is-collapsed')
    expect(row.attributes('aria-label')).toBe(thread.subject)
    expect(row.attributes('title')).toBe(thread.subject)
    expect(row.text()).toBe('')
    expect(wrapper.get('[data-roundtable-fold]').attributes('aria-expanded')).toBe('false')
    expect(localStorage.getItem('fuli.roundtable.listCollapsed')).toBe('1')
    await wrapper.get('[data-roundtable-fold]').trigger('click')
    expect(wrapper.get('[data-testid="roundtable-thread"]').text()).toContain(thread.subject)
    expect(localStorage.getItem('fuli.roundtable.listCollapsed')).toBeNull()
    wrapper.unmount()
  })

  it('shows list then conversation as two steps on a narrow window', async () => {
    narrowWindow()
    try {
      getJson.mockImplementation(async (url: string) => url === '/api/roundtable/threads' ? { threads: [thread] }
        : url.startsWith('/api/roundtable/chats?') ? { chats: [], hasMore: false } : detail)
      const wrapper = await mountAt('/roundtables')
      expect(wrapper.get('[data-roundtable-list]').attributes('style') ?? '').not.toContain('display: none')
      expect(wrapper.find('[data-roundtable-fold]').exists()).toBe(false)
      expect(wrapper.find('[data-roundtable-none]').exists()).toBe(false)
      await wrapper.vm.$router.push('/roundtables/thread-1')
      await flushPromises()
      expect(wrapper.get('[data-roundtable-list]').attributes('style')).toContain('display: none')
      expect(wrapper.get('[data-roundtable-back]').attributes('href')).toBe('/roundtables')
      wrapper.unmount()
    } finally { vi.unstubAllGlobals() }
  })
})


it('keeps a newer SSE chat refresh after an older initial response completes', async () => {
  const sources: EventTarget[] = []
  class Source extends EventTarget { constructor() { super(); sources.push(this) } close() {} }
  vi.stubGlobal('EventSource', Source)
  config.space = { id: 'space' }
  let resolveInitial!: (value: unknown) => void
  const initial = new Promise(resolve => { resolveInitial = resolve })
  let lists = 0, reads = 0
  const members = [{ address: 'local:lead', agentId: 'lead', name: 'Lead', joinedSeq: 0 }]
  const room = { chatId: 'room', kind: 'group', title: 'Room', members, transport: 'local', createdAt: '2026-10-10T09:00:00Z', updatedAt: '2026-10-10T09:05:00Z' }
  getJson.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/roundtable/chats?')) return ++lists === 1 ? initial : { chats: [room] }
    if (url.startsWith('/api/roundtable/chats/room')) return { ...room, hasMore: false, nextAfter: ++reads,
      messages: [{ messageId: `m-${reads}`, seq: reads, from: 'local:lead', body: reads === 1 ? 'first message' : 'latest message', createdAt: room.updatedAt }] }
    return { threads: [] }
  })
  const wrapper = await mountAt('/roundtables/chat/room')
  try {
    sources[0]!.dispatchEvent(new MessageEvent('chat', { data: '{"chatId":"room","seq":2}' }))
    await flushPromises()
    resolveInitial({ chats: [room] })
    await flushPromises()
    expect(wrapper.findAll('[data-roundtable-chat-message]').map(item => item.text())).toEqual([
      expect.stringContaining('first message'), expect.stringContaining('latest message'),
    ])
  } finally { wrapper.unmount(); config.space = null; vi.unstubAllGlobals() }
})

describe('RoundtablesPage on a phone and with paging', () => {
  beforeEach(() => { setLocale('zh-CN', { persist: false }); getJson.mockReset() })

  it('keeps asks visible when chat rooms fail, and says the list is the latest 50 only once it is full', async () => {
    let threads = [thread]
    getJson.mockImplementation(async (url: string) => {
      if (url === '/api/roundtable/threads') return { threads }
      throw new Error('chats down')
    })
    const wrapper = await mountAt('/roundtables')
    expect(wrapper.findAll('[data-testid="roundtable-thread"]')).toHaveLength(1)
    expect(wrapper.text()).not.toContain('最近 50 条')
    threads = Array.from({ length: 50 }, (_, index) => ({ ...thread, id: `thread-${index}` }))
    const full = await mountAt('/roundtables')
    expect(full.text()).toContain('最近 50 条')
    full.unmount()
    expect(wrapper.text()).toContain('群聊暂不可用')
    expect(wrapper.text()).not.toContain('还没有 Agent 之间的对话')
    wrapper.unmount()
  })

  it('says once that both lists failed, with one retry that reads both again', async () => {
    let down = true
    getJson.mockImplementation(async (url: string) => {
      if (down) throw new Error('offline')
      return url === '/api/roundtable/threads' ? { threads: [thread] } : { chats: [], hasMore: false }
    })
    const wrapper = await mountAt('/roundtables')
    const failed = wrapper.get('[data-roundtable-lists-failed]')
    expect(failed.attributes('role')).toBe('alert')
    expect(failed.findAll('button')).toHaveLength(1)
    expect(wrapper.find('[data-roundtable-group]').exists()).toBe(false)
    down = false
    await failed.get('button').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-roundtable-lists-failed]').exists()).toBe(false)
    expect(wrapper.findAll('[data-testid="roundtable-thread"]')).toHaveLength(1)
    wrapper.unmount()
  })

  it('pages local chat rooms with their own cursor and appends later messages in order', async () => {
    const members = [{ address: 'local:lead', agentId: 'lead', name: 'Lead', joinedSeq: 0 }]
    const roomA = { chatId: 'a', kind: 'group', title: 'A', members, transport: 'local', createdAt: '2026-10-10T09:00:00Z', updatedAt: '2026-10-10T09:05:00Z' }
    const roomB = { ...roomA, chatId: 'b', title: 'B' }
    const message = (seq: number) => ({ messageId: `m-${seq}`, seq, from: 'local:lead', body: `message ${seq}`, createdAt: roomA.updatedAt })
    const urls: string[] = []
    getJson.mockImplementation(async (url: string) => {
      urls.push(url)
      if (url === '/api/roundtable/threads') return { threads: [] }
      if (url === '/api/roundtable/chats?limit=50') return { chats: [roomA], hasMore: true, nextChat: 'a' }
      if (url.startsWith('/api/roundtable/chats?')) return { chats: [roomB], hasMore: false, nextChat: null }
      if (url.includes('after=0')) return { ...roomA, hasMore: true, nextAfter: 1, messages: [message(1)] }
      return { ...roomA, hasMore: false, nextAfter: 2, messages: [message(1), message(2)] }
    })
    const wrapper = await mountAt('/roundtables')
    await wrapper.get('[data-roundtable-more-chats]').trigger('click')
    await flushPromises()
    expect(urls).toContain('/api/roundtable/chats?limit=50&transport=local&afterChat=a')
    expect(wrapper.findAll('[data-testid="roundtable-chat-room"]').map(item => item.text())).toEqual([expect.stringContaining('A'), expect.stringContaining('B')])
    expect(wrapper.find('[data-roundtable-more-chats]').exists()).toBe(false)
    await wrapper.vm.$router.push('/roundtables/chat/a')
    await flushPromises()
    await wrapper.get('[data-roundtable-later]').trigger('click')
    await flushPromises()
    expect(urls.at(-1)).toContain('after=1')
    expect(wrapper.findAll('[data-roundtable-chat-message]').map(item => item.text())).toEqual([
      expect.stringContaining('message 1'), expect.stringContaining('message 2'),
    ])
    expect(wrapper.find('[data-roundtable-later]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('goes back to the list from a deep link without leaving the page, and says when a detail is missing', async () => {
    const { ApiError } = await import('@/api/client')
    getJson.mockImplementation(async (url: string) => {
      if (url === '/api/roundtable/threads') return { threads: [thread] }
      if (url.startsWith('/api/roundtable/chats?')) return { chats: [], hasMore: false }
      throw new ApiError('missing', 404)
    })
    const router = createRouter({ history: createMemoryHistory(), routes: [
      { path: '/roundtables/chat/:chatId', component: RoundtablesPage },
      { path: '/roundtables/:threadId?', component: RoundtablesPage },
    ] })
    narrowWindow()
    await router.push('/roundtables/gone')
    const wrapper = mount(RoundtablesPage, { global: { plugins: [router] }, attachTo: document.body })
    await flushPromises()
    expect(wrapper.text()).toContain('对话不存在或当前不可访问')
    await wrapper.get('[data-roundtable-back]').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/roundtables')
    wrapper.unmount()
    vi.unstubAllGlobals()
  })

  it('shows an unconfirmed cleanup after a wake instead of assuming it was clean', async () => {
    const withCleanup = { ...detail, messages: [{ ...detail.messages[0]!, status: 'unknown', cleanup: { status: 'unconfirmed', code: 'wake_cleanup_incomplete' } }] }
    getJson.mockImplementation(async (url: string) => url === '/api/roundtable/threads' ? { threads: [thread] }
      : url.startsWith('/api/roundtable/chats?') ? { chats: [], hasMore: false } : withCleanup)
    const wrapper = await mountAt('/roundtables/thread-1')
    expect(wrapper.get('[data-roundtable-cleanup]').text()).toContain('wake_cleanup_incomplete')
    wrapper.unmount()
  })
})

describe('RoundtablesPage when access, space or cursors change', () => {
  const members = [{ address: 'local:lead', agentId: 'lead', name: 'Lead', joinedSeq: 0 }]
  const room = { chatId: 'room', kind: 'group', title: 'Room', members, transport: 'local', createdAt: '2026-10-10T09:00:00Z', updatedAt: '2026-10-10T09:05:00Z' }
  const message = (seq: number) => ({ messageId: `m-${seq}`, seq, from: 'local:lead', body: `message ${seq}`, createdAt: room.updatedAt })
  const sources: EventTarget[] = []
  class Source extends EventTarget { constructor() { super(); sources.push(this) } close() {} }
  beforeEach(() => { setLocale('zh-CN', { persist: false }); getJson.mockReset(); sources.length = 0 })

  it('clears everything shown and drops late answers when the space changes', async () => {
    vi.stubGlobal('EventSource', Source)
    config.space = { id: 'one' }
    let releaseOld!: (value: unknown) => void
    const oldDetail = new Promise(resolve => { releaseOld = resolve })
    let space = 'one'
    getJson.mockImplementation(async (url: string) => {
      if (url === '/api/roundtable/threads') return { threads: space === 'one' ? [thread] : [{ ...thread, id: 'thread-2', subject: '另一个空间' }] }
      if (url.startsWith('/api/roundtable/chats?')) return { chats: [], hasMore: false }
      return space === 'one' ? oldDetail : { ...detail, subject: '新空间里的同名对话' }
    })
    const wrapper = await mountAt('/roundtables/thread-1')
    try {
      const { useConsoleStore } = await import('@/stores/console')
      space = 'two'
      ;(useConsoleStore() as unknown as { activePersonalSpace: { id: string } }).activePersonalSpace = { id: 'two' }
      await flushPromises()
      releaseOld(detail)
      await flushPromises()
      expect(wrapper.get('[data-roundtable-detail-title]').text()).toBe('新空间里的同名对话')
      await wrapper.vm.$router.push('/roundtables')
      await flushPromises()
      expect(wrapper.findAll('[data-testid="roundtable-thread"]').map(item => item.text())).toEqual([expect.stringContaining('另一个空间')])
    } finally { wrapper.unmount(); config.space = null; vi.unstubAllGlobals() }
  })

  it('clears lists and detail when access is lost and says so', async () => {
    const { ApiError } = await import('@/api/client')
    getJson.mockImplementation(async (url: string) => {
      if (url === '/api/roundtable/threads') return { threads: [thread] }
      if (url.startsWith('/api/roundtable/chats?')) return { chats: [room], hasMore: false }
      throw new ApiError('forbidden', 403)
    })
    const wrapper = await mountAt('/roundtables/thread-1')
    expect(wrapper.text()).toContain('无法再访问这些对话')
    expect(wrapper.find('[data-testid="roundtable-thread"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="roundtable-chat-room"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('shows a deep-linked conversation even when both lists are empty', async () => {
    getJson.mockImplementation(async (url: string) => url === '/api/roundtable/threads' ? { threads: [] }
      : url.startsWith('/api/roundtable/chats?') ? { chats: [], hasMore: false } : detail)
    const wrapper = await mountAt('/roundtables/thread-1')
    expect(wrapper.find('[data-testid="roundtable-timeline"]').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('Agent 在任意已接入的客户端里调用')
    wrapper.unmount()
  })

  it('names an unknown status as unknown and keeps the recorded value', async () => {
    const odd = { ...detail, messages: [{ ...detail.messages[0]!, status: 'mystery', via: null }] }
    getJson.mockImplementation(async (url: string) => url === '/api/roundtable/threads' ? { threads: [thread] }
      : url.startsWith('/api/roundtable/chats?') ? { chats: [], hasMore: false } : odd)
    const wrapper = await mountAt('/roundtables/thread-1')
    expect(wrapper.text()).toContain('状态未知（记录为 mystery）')
    wrapper.unmount()
  })

  it('keeps the local cursor after a failed page and says the page failed', async () => {
    const urls: string[] = []
    getJson.mockImplementation(async (url: string) => {
      urls.push(url)
      if (url === '/api/roundtable/threads') return { threads: [] }
      if (url === '/api/roundtable/chats?limit=50') return { chats: [room], hasMore: true, nextChat: 'room' }
      throw new Error('offline')
    })
    const wrapper = await mountAt('/roundtables')
    await wrapper.get('[data-roundtable-more-chats]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('更多本机会话读取失败')
    await wrapper.get('[data-roundtable-more-chats]').trigger('click')
    await flushPromises()
    expect(urls.filter(url => url.includes('afterChat=room'))).toHaveLength(2)
    wrapper.unmount()
  })

  it('stops offering later messages when the cursor does not move', async () => {
    getJson.mockImplementation(async (url: string) => {
      if (url === '/api/roundtable/threads') return { threads: [] }
      if (url.startsWith('/api/roundtable/chats?')) return { chats: [room], hasMore: false }
      return { ...room, hasMore: true, nextAfter: 1, messages: url.includes('after=0') ? [message(1)] : [] }
    })
    const wrapper = await mountAt('/roundtables/chat/room')
    await wrapper.get('[data-roundtable-later]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-roundtable-later-stuck]').exists()).toBe(true)
    expect(wrapper.find('[data-roundtable-later]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('announces new messages in a room with unread pages instead of reloading it', async () => {
    vi.stubGlobal('EventSource', Source)
    config.space = { id: 'space' }
    const urls: string[] = []
    getJson.mockImplementation(async (url: string) => {
      urls.push(url)
      if (url === '/api/roundtable/threads') return { threads: [] }
      if (url.startsWith('/api/roundtable/chats?')) return { chats: [room], hasMore: false }
      return { ...room, hasMore: true, nextAfter: 1, messages: [message(1)] }
    })
    const wrapper = await mountAt('/roundtables/chat/room')
    try {
      const reads = urls.filter(url => url.startsWith('/api/roundtable/chats/room')).length
      sources[0]!.dispatchEvent(new MessageEvent('chat', { data: '{"chatId":"room","seq":5}' }))
      await flushPromises()
      expect(wrapper.find('[data-roundtable-new-messages]').exists()).toBe(true)
      expect(urls.filter(url => url.startsWith('/api/roundtable/chats/room'))).toHaveLength(reads)
      expect(wrapper.findAll('[data-roundtable-chat-message]')).toHaveLength(1)
    } finally { wrapper.unmount(); config.space = null; vi.unstubAllGlobals() }
  })
})
