import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getJson = vi.fn()
vi.mock('@/api/client', () => ({ getJson: (url: string) => getJson(url) }))

import { setLocale } from '@/i18n'
import RoundtablesPage from './RoundtablesPage.vue'

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
  beforeEach(() => { setLocale('zh-CN', { persist: false }); getJson.mockReset() })

  it('gives each participant one stable identity colour across the participant chips and timeline', async () => {
    getJson.mockImplementation(async (url: string) => url === '/api/roundtable/threads' ? { threads: [thread] } : detail)
    const wrapper = await mountAt('/roundtables/thread-1')
    const faces = wrapper.findAll('[data-roundtable-seat]').map((seat) => seat.attributes('style'))
    const avatars = wrapper.findAll('.roundtable-avatar').map((avatar) => avatar.attributes('style'))
    expect(faces[0]).toMatch(/--agent-identity: var\(--identity-[0-7]\)/)
    expect(avatars).toEqual(faces)
    expect(wrapper.findAll('.roundtable-avatar').map((avatar) => avatar.text())).toEqual(['M', 'N'])
    wrapper.unmount()
  })

  it('shows who talked to whom, through which client, and what was said', async () => {
    getJson.mockImplementation(async (url: string) => url === '/api/roundtable/threads' ? { threads: [thread] } : detail)
    const wrapper = await mountAt('/roundtables/thread-1')
    expect(wrapper.get('[data-testid="roundtable-thread"]').text()).toContain('Milo Reed · Nova Lane')
    const timeline = wrapper.get('[data-testid="roundtable-timeline"]')
    expect(timeline.text()).toContain('Claude Code')
    expect(timeline.text()).toContain('发给 Nova Lane')
    expect(timeline.text()).toContain('评审过了')
    expect(timeline.text()).toContain('唤醒原会话回答')
    wrapper.unmount()
  })

  it('keeps one-way requests apart from the conversation and says who and why it waits', async () => {
    const waiting = { ...thread, waiting: true, waitingFor: ['Cora Fenn'] }
    const pendingDetail = { ...detail, messages: [
      ...detail.messages,
      { id: 'm-3', kind: 'ask', status: 'queued', body: '能看一下部署吗？', inReplyTo: null, via: null, error: 'no_client', createdAt: '2026-10-10T08:05:00Z',
        from: { agentId: 'lead-1', name: 'Milo Reed', client: 'claude_code' }, to: { agentId: 'ops-1', name: 'Cora Fenn', client: null } },
      { id: 'm-4', kind: 'ask', status: 'failed', body: '远端可以接吗？', inReplyTo: null, via: 'peer', error: 'peer_send_failed', createdAt: '2026-10-10T08:06:00Z',
        from: { agentId: 'lead-1', name: 'Milo Reed', client: 'claude_code' }, to: { agentId: 'peer:remote', name: 'Remote Lead', client: null } },
    ] }
    getJson.mockImplementation(async (url: string) => url === '/api/roundtable/threads' ? { threads: [waiting] } : pendingDetail)
    const wrapper = await mountAt('/roundtables/thread-1')
    expect(wrapper.get('[data-roundtable-waiting]').text()).toBe('等待 Cora Fenn')
    const exchanges = wrapper.get('[data-roundtable-exchanges]')
    expect(exchanges.text()).toContain('评审过了')
    expect(exchanges.text()).not.toContain('能看一下部署吗？')
    const requests = wrapper.findAll('[data-roundtable-request]')
    expect(requests.map(request => request.text())).toEqual([
      expect.stringContaining('等待 Cora Fenn'),
      expect.stringContaining('等待 Remote Lead'),
    ])
    expect(requests[0]!.text()).toContain('对方没有可唤醒的客户端会话')
    expect(requests[1]!.text()).toContain('未送达')
    expect(requests[1]!.text()).toContain('发送到对方设备失败')
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
      if (url === '/api/roundtable/chats') return { chats: [room], hasMore: false }
      if (url.startsWith('/api/roundtable/chats/room-1')) return { ...room, hasMore: false, nextAfter: 2, messages: [
        { messageId: 'c-1', seq: 1, from: 'local:lead-1', body: '部署窗口定在今晚', createdAt: '2026-10-10T09:01:00Z' },
        { messageId: 'c-2', seq: 2, from: 'local:ops-1', body: '收到，我来值守', createdAt: '2026-10-10T09:02:00Z' },
      ] }
      return detail
    })
    const wrapper = await mountAt('/roundtables/chat/room-1')
    const rooms = wrapper.findAll('[data-testid="roundtable-chat-room"]')
    expect(rooms).toHaveLength(1)
    expect(rooms[0]!.text()).toContain('群聊 · 2')
    expect(rooms[0]!.text()).toContain('Milo Reed · Cora Fenn')
    expect(wrapper.findAll('[data-testid="roundtable-thread"]')).toHaveLength(1)
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
      if (url === '/api/roundtable/chats') throw new Error('404')
      return detail
    })
    const wrapper = await mountAt('/roundtables')
    expect(wrapper.findAll('[data-testid="roundtable-thread"]')).toHaveLength(1)
    expect(wrapper.find('[data-testid="roundtable-chat-room"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('explains that Agents start conversations themselves when there are none', async () => {
    getJson.mockResolvedValue({ threads: [] })
    const wrapper = await mountAt('/roundtables')
    expect(wrapper.text()).toContain('还没有 Agent 之间的对话')
    expect(wrapper.text()).toContain('message_agent')
    expect(wrapper.find('button').exists()).toBe(false)
    wrapper.unmount()
  })
})
