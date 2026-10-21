import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'

const getJson = vi.hoisted(() => vi.fn())
vi.mock('@/api/client', async (original) => ({ ...(await original<typeof import('@/api/client')>()), getJson }))

import { setLocale } from '@/i18n'
import { router as appRouter } from '@/router'
import { useConsoleStore } from '@/stores/console'
import SessionRecordsPage from './SessionRecordsPage.vue'

// rec#5 C6: the receipt's 本会话已记录 link opens this list. Synthetic host
// view only: the numbers, types and links come from the host as the Agent gets them.
const local = (hour: number, minute: number) => new Date(2026, 9, 20, hour, minute).toISOString()
const project = { id: 'thesis', name: '毕业论文', temporary: false }
const summary = { item_kind: 'entity', version: 1, type: 'ProjectFact', profile_aspect: null, category: 'fact',
  scope: { kind: 'projects', projects: [project], status: 'set' }, weight: null, tags: [],
  content_source: 'agent_inferred' }

function view() {
  const turns = [1, 2, 3, 4, 5].map(index => ({ number: index, group: 'transcript', key: `turn:t${index}`, kind: 'turn',
    type: '会话原文', summary: `第 ${index} 轮的原话`, at: local(10, index), project, link: '',
    detail: { messages: [{ role: 'user', text: `第 ${index} 轮的原话，完整的一段` }, { role: 'assistant', text: '回答' }],
      items: index === 3 ? ['entity:cite'] : [] } }))
  turns.push({ ...turns[0], number: 6, key: 'turn:t14', summary: '第 14 轮的原话', at: local(15, 10),
    detail: { messages: [{ role: 'user', text: '第 14 轮' }], items: [] } })
  const item = (number: number, key: string, group: string, extra: object) => ({ number, group, key, kind: 'entity',
    type: '', summary: '', at: local(10, 3), project, link: '', status: 'pending', turn: 'turn:t3',
    detail: { sources: [{ episode_id: `episode-${number}`, turn: 'turn:t3' }], item: { ...summary, item_id: key.slice(7), title: key, content: key,
      confirmation_status: 'pending', change: 'created', episode_id: `episode-${number}`, ...extra } }, ...extra })
  return { session: { sourceApplication: 'codex', sessionId: 'native-session-123456', url: '' }, total: 9, truncated: false,
    entries: [...turns,
      item(7, 'entity:gate', 'knowledge', { summary: 'Deploys use the staging gate' }),
      item(8, 'entity:port', 'knowledge', { summary: 'The service listens on 9090', status: 'confirmed' }),
      item(9, 'entity:cite', 'preference_evidence', { summary: '以后引用都按 GB/T 7714', excerpt: '以后引用都按 GB/T 7714',
        profile_aspect: 'judgment_preference', category: 'judgment' })],
    stretches: [{ from: local(14, 32), to: local(15, 10), paused: true, reasons: [] }] }
}

// The receipt's short link is read in the console's active space.
function activeSpace() {
  const pinia = createPinia()
  setActivePinia(pinia)
  useConsoleStore().state = { mode: 'personal_only', activePersonalSpaceId: 'space', personalSpaces: [{ id: 'space', name: '我' }],
    personalProjects: [], projects: [], subscriptions: [] } as never
  return pinia
}

async function open(path: string, response: unknown = view()) {
  getJson.mockReset()
  getJson.mockResolvedValue(response)
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/s/:sessionId', component: SessionRecordsPage },
    { path: '/knowledge/item/:spaceId/:itemKind/:itemId', component: { template: '<div />' } }] })
  await router.push(path)
  await router.isReady()
  const wrapper = mount(SessionRecordsPage, { attachTo: document.body, global: { plugins: [activeSpace(), router] } })
  await flushPromises()
  return { wrapper, router }
}

describe('SessionRecordsPage', () => {
  afterEach(() => { document.body.innerHTML = '' })

  it('C6-1: three groups, nine numbered records, each with its time and project', async () => {
    setLocale('zh-CN')
    const { wrapper } = await open('/s/native-session-123456')
    expect(getJson).toHaveBeenCalledWith('/api/session-records?personalSpaceId=space&sessionId=native-session-123456')
    expect(wrapper.get('[data-session-total]').text()).toBe('共 9 项')
    const groups = wrapper.findAll('[data-session-group]')
    expect(groups.map(group => group.attributes('data-session-group'))).toEqual(['transcript', 'knowledge', 'preference_evidence'])
    expect(groups.map(group => group.findAll('[data-session-entry]').length)).toEqual([6, 2, 1])
    for (const row of wrapper.findAll('[data-session-entry]')) expect(row.text()).toContain('毕业论文')
    expect(wrapper.get('[data-session-entry="entity:port"]').text()).toContain('#8')
    expect(wrapper.get('[data-session-entry="entity:port"]').text()).toContain('你已确认')
    expect(wrapper.get('[data-session-entry="entity:gate"]').text()).toContain('待确认')
    expect(wrapper.find('h1').exists()).toBe(false)
    wrapper.unmount()
  })

  it('C6-4: the paused stretch sits between the turns it separates and holds nothing', async () => {
    setLocale('zh-CN')
    const { wrapper } = await open('/s/native-session-123456')
    const transcript = wrapper.get('[data-session-group="transcript"]')
    const rows = transcript.findAll('li').map(row => row.attributes('data-session-stretch') !== undefined ? 'stretch'
      : row.get('[data-session-entry]').attributes('data-session-entry'))
    expect(rows).toEqual(['turn:t1', 'turn:t2', 'turn:t3', 'turn:t4', 'turn:t5', 'stretch', 'turn:t14'])
    const stretch = transcript.get('[data-session-stretch]')
    expect(stretch.text()).toContain('14:32～15:10 暂停记录')
    expect(stretch.find('[data-session-entry]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('C6-3: a knowledge source link opens the turn that wrote it, with its words and records', async () => {
    setLocale('zh-CN')
    const { wrapper, router } = await open('/s/native-session-123456?item=space/episode%3Aepisode-9')
    const peek = document.querySelector('[data-session-peek]')!
    expect(peek.textContent).toContain('#3 会话原文')
    expect(peek.querySelector('[data-peek-message="user"]')!.textContent).toContain('第 3 轮的原话，完整的一段')
    expect(peek.querySelector('[data-peek-turn-records]')!.textContent).toContain('#9 偏好证据')
    expect(wrapper.get('[data-session-entry="turn:t3"]').classes()).toContain('shadow-md')
    // From the evidence back to its turn, all inside the quick look.
    await router.push('/s/native-session-123456?item=space/entity%3Acite')
    await flushPromises()
    const item = document.querySelector('[data-session-peek]')!
    expect(item.querySelector('[data-peek-evidence]')!.textContent).toContain('以后引用都按 GB/T 7714')
    expect(item.querySelector('[data-peek-source-turn]')!.textContent).toContain('第 3 项')
    expect(item.querySelector('[data-peek-edit]')!.getAttribute('href')).toBe('/knowledge/item/space/entity/cite')
    wrapper.unmount()
  })

  it('a row opens its record in the URL, so a refresh or shared link reopens it', async () => {
    const { wrapper, router } = await open('/s/native-session-123456')
    await wrapper.get('[data-session-entry="entity:gate"] button').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query.item).toBe('space/entity%3Agate')
    expect(document.querySelector('[data-session-peek]')).not.toBeNull()
    wrapper.unmount()
  })

  it('an empty session says so; a failed read offers a retry', async () => {
    setLocale('zh-CN')
    const empty = await open('/s/s', { ...view(), total: 0, entries: [], stretches: [] })
    expect(empty.wrapper.get('[data-session-empty]').text()).toBe('这个会话还没有记录任何内容。')
    empty.wrapper.unmount()
    getJson.mockReset()
    getJson.mockRejectedValue(new Error('Provider unavailable'))
    const router = createRouter({ history: createMemoryHistory(), routes: [
      { path: '/s/:sessionId', component: SessionRecordsPage }] })
    await router.push('/s/s')
    const failed = mount(SessionRecordsPage, { global: { plugins: [activeSpace(), router] } })
    await flushPromises()
    expect(failed.get('[role="alert"]').text()).toContain('Provider unavailable')
    failed.unmount()
  })

  it('the receipt link resolves to its own canvas page', () => {
    const resolved = appRouter.resolve('/s/0b3c6f5e-2d41-4c8a-9e57-6a1f0c2d9b84')
    expect(resolved.name).toBe('session-records')
    expect(resolved.meta.layout).toBe('canvas')
  })
})

describe('SessionRecordsPage short link', () => {
  it('two clients sharing a session ID are offered, never guessed; a chosen client is read by name', async () => {
    setLocale('zh-CN')
    const { wrapper } = await open('/s/shared-id?item=space/turn%3At1', { session: { sourceApplication: null, sessionId: 'shared-id', url: '' },
      clients: ['claude_code', 'codex'], total: 0, entries: [], stretches: [], truncated: false })
    const links = wrapper.findAll('[data-session-clients] a').map(link => decodeURIComponent(link.attributes('href') ?? ''))
    // dot #263: choosing a client keeps the record the link opened.
    expect(links).toEqual(['/s/shared-id?item=space/turn:t1&client=claude_code', '/s/shared-id?item=space/turn:t1&client=codex'])
    expect(document.querySelector('[data-session-peek]')).toBeNull()
    expect(wrapper.find('[data-session-group]').exists()).toBe(false)
    expect(wrapper.find('[data-session-empty]').exists()).toBe(false)
    wrapper.unmount()
    const chosen = await open('/s/shared-id?client=codex')
    expect(getJson).toHaveBeenCalledWith('/api/session-records?personalSpaceId=space&sessionId=shared-id&sourceApplication=codex')
    chosen.wrapper.unmount()
  })
})
