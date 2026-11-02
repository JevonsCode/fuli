import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const postJson = vi.fn()
const putJson = vi.fn()
vi.mock('@/api/client', async (importOriginal) => ({ ...await importOriginal<typeof import('@/api/client')>(),
  postJson: (url: string, body: unknown) => postJson(url, body), putJson: (url: string, body: unknown) => putJson(url, body) }))

import { personProfile } from '@/features/person-home/person-profile'
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
    expect(bubbles[0]!.text()).toContain('我')
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

  it('keeps the composer in the same column as the messages', () => {
    const main = mountChat(conversation()).get('.rt-thread-main')
    expect(main.find('.rt-chat-body').exists()).toBe(true)
    expect(main.find('[data-roundtable-composer]').exists()).toBe(true)
  })

  it('lists the participants beside the conversation on a very wide window, once', () => {
    const narrow = mountChat(conversation())
    expect(narrow.find('[data-roundtable-side]').exists()).toBe(false)
    // The head is one line; who is in it opens in 详情.
    expect(narrow.find('[data-roundtable-details]').exists()).toBe(true)
    expect(narrow.findAll('[data-roundtable-seat]')).toHaveLength(0)
    const matchMedia = vi.fn((query: string) => ({ matches: query === '(min-width: 1440px)', media: query,
      addEventListener: vi.fn(), removeEventListener: vi.fn() }))
    vi.stubGlobal('matchMedia', matchMedia)
    try {
      const wide = mountChat(conversation())
      const side = wide.get('[data-roundtable-side]')
      expect(side.get('h3').text()).toBe('参与者（2）')
      expect(wide.findAll('[data-roundtable-seat]').map(seat => seat.text())).toEqual([expect.stringContaining('我'), expect.stringContaining('Ada Vale')])
      expect(side.findAll('[data-roundtable-seat]')).toHaveLength(2)

      // The person is 「我」: a link to their page with a plain face, never an FLA portrait; the head shows only the others.
      const me = side.get('[data-roundtable-seat-me]')
      expect(me.get('a[data-me-link]').text()).toBe('我')
      expect(me.get('a[data-me-link]').attributes('href')).toBe('/preferences')
      expect(me.find('[data-agent-portrait]').exists()).toBe(false)
      expect(me.get('.roundtable-seat-face').text()).toBe('我')
      expect(me.find('[data-me-avatar-face]').exists()).toBe(true)
      expect(me.text()).toContain('发言 2 次')
      expect(wide.get('.rt-chat-faces').findAll('[data-agent-portrait]').map(face => face.attributes('data-agent-portrait'))).toEqual(['ada'])
    } finally { vi.unstubAllGlobals() }
  })

  it('renders a reply as Markdown and opens its FULI receipt link on the Agent page inside the console', async () => {
    const router = createRouter({ history: createMemoryHistory(), routes: [
      { path: '/', component: { template: '<div />' } },
      { path: '/agents/:spaceId/:agentId', name: 'agent-profile', component: { template: '<div />' } },
    ] })
    await router.push('/')
    const receipt = 'Shipped **v2** with `npm test`.\n\nFULI Agent：[Ada Vale \\[fuli 负责人\\]](<fuli://agents/space-1/ada>)'
    const thread = conversation({ messages: [ask('p1', { status: 'answered', body: 'Ship <b>it</b>?' }),
      { id: 'r1', kind: 'reply', status: 'sent', body: receipt, inReplyTo: 'p1', via: null, error: null,
        createdAt: '2026-10-27T08:01:00Z', from: ada, to: you }] })
    const wrapper = mount(RoundtableThreadChat, { attachTo: document.body, props: { thread, time: () => '08:00' }, global: { plugins: [router] } })
    try {
      const [mine, reply] = wrapper.findAll('[data-roundtable-bubble]')
      expect(mine!.get('.rt-bubble').text()).toBe('Ship <b>it</b>?')
      expect(mine!.find('.rt-bubble b').exists()).toBe(false)
      expect(reply!.get('.rt-bubble strong').text()).toBe('v2')
      expect(reply!.get('.rt-bubble code').text()).toBe('npm test')
      const link = reply!.get('.rt-bubble a')
      expect(link.text()).toBe('Ada Vale [fuli 负责人]')
      expect(link.attributes('href')).toBe('/agents/space-1/ada')
      await link.trigger('click', { button: 0 })
      await flushPromises()
      expect(router.currentRoute.value.name).toBe('agent-profile')
      expect(router.currentRoute.value.params).toEqual({ spaceId: 'space-1', agentId: 'ada' })
    } finally { wrapper.unmount() }
  })

  it('shows the picture the person chose on their home in their seat, and the neutral face when it cannot load', async () => {
    personProfile.value = { name: 'Synthetic', look: { kind: 'generated', seed: 'synthetic-seed' } }
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: query === '(min-width: 1440px)', media: query,
      addEventListener: vi.fn(), removeEventListener: vi.fn() })))
    try {
      const drawn = mountChat(conversation()).get('[data-roundtable-side] [data-roundtable-seat-me]')
      expect(drawn.get('[data-me-avatar-picture]').attributes('src')).toMatch(/^data:image\/svg\+xml/)
      expect(drawn.find('[data-agent-portrait]').exists()).toBe(false)

      personProfile.value = { name: 'Synthetic', look: { kind: 'image', imageVersion: 'abcdef0123456789' } }
      const pictured = mountChat(conversation()).get('[data-roundtable-side] [data-roundtable-seat-me]')
      await pictured.get('[data-me-avatar-picture]').trigger('error')
      expect(pictured.find('[data-me-avatar-picture]').exists()).toBe(false)
      expect(pictured.get('[data-me-avatar-face]').text()).toBe('我')
    } finally {
      personProfile.value = null
      vi.unstubAllGlobals()
    }
  })
})
