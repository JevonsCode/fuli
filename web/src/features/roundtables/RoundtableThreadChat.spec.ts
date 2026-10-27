import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const postJson = vi.fn()
const putJson = vi.fn()
vi.mock('@/api/client', async (importOriginal) => ({ ...await importOriginal<typeof import('@/api/client')>(),
  postJson: (url: string, body: unknown) => postJson(url, body), putJson: (url: string, body: unknown) => putJson(url, body) }))

import { setLocale } from '@/i18n'
import type { RoundtableMessage, RoundtableThread } from './roundtable-api'
import RoundtableThreadChat from './RoundtableThreadChat.vue'

const you = { agentId: null, name: null, client: 'person' }
const ada = { agentId: 'ada', name: 'Ada Vale', client: 'codex' }
const ask = (id: string, extra: Partial<RoundtableMessage> = {}): RoundtableMessage => ({ id, kind: 'ask', status: 'queued', body: `Question ${id}`,
  inReplyTo: null, via: null, error: null, createdAt: '2026-10-27T08:00:00Z', from: you, to: ada, ...extra })
const conversation = (extra: Partial<RoundtableThread> = {}): RoundtableThread => ({ id: 'thread-1', subject: 'Release', projectId: 'alpha',
  createdAt: '2026-10-27T08:00:00Z', mode: 'instant', subscribers: [{ agentId: 'ada', name: 'Ada Vale', delivery: 'instant', instantBlocked: null }],
  messages: [ask('p1', { status: 'answered' }),
    { id: 'r1', kind: 'reply', status: 'sent', body: 'All clear', inReplyTo: 'p1', via: 'codex:new', error: null,
      createdAt: '2026-10-27T08:01:00Z', from: ada, to: you },
    ask('p2', { status: 'delivering' })], ...extra })
const mountChat = (thread: RoundtableThread) => mount(RoundtableThreadChat, { props: { thread, time: () => '08:00' } })

describe('RoundtableThreadChat', () => {
  beforeEach(() => { setLocale('zh-CN', { persist: false }); postJson.mockReset(); putJson.mockReset() })

  it('shows the person on one side, the FLA on the other, and a running reply as a live state', () => {
    const wrapper = mountChat(conversation())
    const bubbles = wrapper.findAll('[data-roundtable-bubble]')
    expect(bubbles.map(bubble => bubble.attributes('data-mine') ?? 'theirs')).toEqual(['true', 'theirs', 'true'])
    expect(bubbles[0]!.text()).toContain('你')
    expect(bubbles[0]!.text()).toContain('Ada Vale 已回复')
    expect(bubbles[1]!.text()).toContain('Ada Vale')
    expect(bubbles[1]!.text()).toContain('新会话回答')
    expect(bubbles[2]!.get('[role="status"]').attributes('aria-label')).toBe('Ada Vale 正在回复…')
    expect(wrapper.find('details[data-roundtable-record]').exists()).toBe(false)
  })

  it('sends the next message in the chosen mode and shows the thread as the server recorded it', async () => {
    const recorded = conversation({ messages: [...conversation().messages, ask('p3', { body: 'Ship it?' })] })
    postJson.mockResolvedValue(recorded)
    const wrapper = mountChat(conversation())
    await wrapper.get('textarea').setValue('Ship it?')
    await wrapper.get('textarea').trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(postJson).toHaveBeenCalledWith('/api/roundtable/threads/thread-1/messages', { body: 'Ship it?', mode: 'instant' })
    expect(wrapper.emitted('updated')).toEqual([[recorded]])
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('')
  })

  it('switches a subscribed thread between board and instant through the server and keeps the text on failure', async () => {
    putJson.mockResolvedValue(conversation({ mode: 'board' }))
    const wrapper = mountChat(conversation())
    await wrapper.get('[data-roundtable-mode="board"] button').trigger('click')
    await flushPromises()
    expect(putJson).toHaveBeenCalledWith('/api/roundtable/threads/thread-1/mode', { mode: 'board' })
    postJson.mockRejectedValue(new Error('offline'))
    await wrapper.get('textarea').setValue('Still there?')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('发送失败')
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('Still there?')
  })

  it('says plainly when an FLA cannot reply instantly, and that its messages stay on the board', () => {
    const wrapper = mountChat(conversation({ subscribers: [{ agentId: 'ada', name: 'Ada Vale', delivery: 'instant', instantBlocked: 'no_client' }],
      messages: [ask('p1', { error: 'no_client' })] }))
    expect(wrapper.get('[data-roundtable-instant-blocked]').text()).toContain('Ada Vale 现在不能即时回复')
    expect(wrapper.get('[data-roundtable-delivery="held"]').text()).toContain('消息留在留言板')
    expect(wrapper.text()).not.toContain('终端')
  })

  it('posts to the local FLAs of an Agents-only thread and offers no box when none is on this computer', async () => {
    const remoteAsk = ask('x1', { from: { agentId: 'peer:abc:lead', name: 'Peer · Laptop', client: 'codex' }, status: 'failed', error: 'lead_changed' })
    postJson.mockResolvedValue(conversation())
    const local = mountChat(conversation({ mode: null, subscribers: [], messages: [remoteAsk] }))
    expect(local.text()).toContain('发给 Ada Vale')
    expect(local.get('[data-roundtable-delivery="failed"]').text()).toContain('共享项目的负责人换了')
    await local.get('textarea').setValue('I will reshare')
    await local.get('form').trigger('submit')
    await flushPromises()
    expect(postJson).toHaveBeenCalledWith('/api/roundtable/threads/thread-1/messages', { body: 'I will reshare', mode: 'board', to: ['ada'] })
    const remote = mountChat(conversation({ mode: null, subscribers: [], messages: [{ ...remoteAsk, to: { agentId: 'peer:x', name: 'X', client: null } }] }))
    expect(remote.find('[data-roundtable-composer]').exists()).toBe(false)
    expect(remote.get('[data-roundtable-no-recipients]').text()).toContain('不能在这里发消息')
  })
})
