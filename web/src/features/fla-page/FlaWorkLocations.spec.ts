import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import FlaContinueElsewhere from './FlaContinueElsewhere.vue'
import FlaWorkLocations from './FlaWorkLocations.vue'
import { forgetWorkLocations } from './work-locations'

const { getJson } = vi.hoisted(() => ({ getJson: vi.fn() }))
vi.mock('@/api/client', async importOriginal => ({ ...await importOriginal<typeof import('@/api/client')>(), getJson }))

// Synthetic rows and segments only; the server does the counting.
const segment = (sessionId: string | null, extra: Record<string, unknown> = {}) => ({
  conversation_id: 'c1', personal_project_id: 'ledger', client: 'codex', session_id: sessionId,
  session_short: sessionId?.slice(0, 8) ?? null, when: '2026-11-22T09:00:00Z', status: 'incomplete',
  title: 'Amount parser for the ledger import', on_this_computer: null, ...extra,
})
const row = (client: string | null, model: string | null, extra: Record<string, unknown> = {}) => ({
  client, model, model_source: model ? 'actual' : 'unknown', segments: 1, conversations: 1,
  last_seen: '2026-11-22T09:00:00Z', recent: [segment('f41c9a02-7b5d-4e18-9a30-0c2b7d6e4518', { client })], ...extra,
})
const answer = (extra: Record<string, unknown> = {}) => ({
  rows: [], segments: 0, conversations_read: 0, complete: true, continuation: null, ...extra,
})
const serve = (locations: unknown, offers: unknown = { launcher: 'unavailable' }) =>
  getJson.mockImplementation((url: string) => Promise.resolve(url.includes('session-launch') ? offers : locations))

const mounted: Array<{ unmount: () => void }> = []
const render = (component: typeof FlaWorkLocations | typeof FlaContinueElsewhere) => {
  const wrapper = mount(component, { props: { spaceId: 'space-a', agentId: 'lead-1', agentName: 'Lumen',
    projectName: (id: string) => ({ ledger: 'Ledger import', billing: 'Billing' })[id] ?? id } })
  mounted.push(wrapper)
  return wrapper
}

beforeEach(() => { setActivePinia(createPinia()); getJson.mockReset(); forgetWorkLocations() })
afterEach(() => { mounted.splice(0).forEach(wrapper => wrapper.unmount()); forgetWorkLocations() })

describe('在哪儿干的活', () => {
  it('reads its own data from the FLA alone, once for both widgets', async () => {
    serve(answer({ rows: [row('codex', 'synthetic-model-s')], segments: 1, conversations_read: 1,
      continuation: { conversation_id: 'c1', personal_project_id: 'ledger', prompt: '#FLA {lead-1}', opens: 'new_session', leaves_original: true } }))
    render(FlaWorkLocations)
    render(FlaContinueElsewhere)
    await flushPromises()
    const reads = getJson.mock.calls.filter(([url]) => String(url).includes('/api/project-agent-work-locations?'))
    expect(reads).toHaveLength(1)
    expect(reads[0][0]).toContain('agentId=lead-1')
  })

  it('shows each client and model with its counts, and marks a requested model as requested', async () => {
    serve(answer({ rows: [row('codex', 'synthetic-model-s', { model_source: 'requested', segments: 4, conversations: 2 })],
      segments: 4, conversations_read: 2 }))
    const wrapper = render(FlaWorkLocations)
    await flushPromises()
    expect(wrapper.text()).toContain('Codex · synthetic-model-s')
    expect(wrapper.text()).toContain('请求的模型，实际回答的未知')
    expect(wrapper.text()).toContain('4 段工作 · 2 个对话')
  })

  it('shows an unknown model as "-" with why, never as 0 or blamed on the client', async () => {
    serve(answer({ rows: [row('cursor', null, { model_reason: 'not_read' }), row('claude_code', null, { model_reason: 'not_recorded' })],
      segments: 2, conversations_read: 2 }))
    const text = (await (async () => { const wrapper = render(FlaWorkLocations); await flushPromises(); return wrapper.text() })())
    expect(text).toContain('Cursor · -')
    expect(text).toContain('FULI 没读这个客户端的模型')
    expect(text).toContain('当时没记')
    expect(text).not.toMatch(/不报模型|0 段工作/)
  })

  it('opens the segments of a row with one click, however few rows there are', async () => {
    serve(answer({ rows: [row('codex', 'synthetic-model-s')], segments: 1, conversations_read: 1 }))
    const wrapper = render(FlaWorkLocations)
    await flushPromises()
    expect(wrapper.find('[data-worked-segments]').exists()).toBe(false)
    await wrapper.find('[data-worked-row]').trigger('click')
    await flushPromises()
    const segments = wrapper.find('[data-worked-segments]')
    expect(segments.text()).toContain('Amount parser for the ledger import')
    expect(segments.text()).toContain('Ledger import')
    expect(segments.text()).toContain('没做完')
  })

  it('says how far the count reaches and what it could not read, instead of hiding the block', async () => {
    serve(answer({ complete: false, unavailable: [{ personal_project_id: 'billing', reason: 'provider_timeout' }],
      truncated: [{ reason: 'projects_limit', read: 3, total: 5 }] }))
    const wrapper = render(FlaWorkLocations)
    await flushPromises()
    const gaps = wrapper.find('[data-worked-gaps]').text()
    expect(gaps).toContain('Billing 没读到，没算在内')
    expect(gaps).toContain('这位助手在 5 个项目里，只数了 3 个')
  })

  it('says the read failed rather than showing an FLA as having done nothing', async () => {
    getJson.mockRejectedValue(Object.assign(new Error('synthetic'), { status: 503 }))
    const wrapper = render(FlaWorkLocations)
    await flushPromises()
    expect(wrapper.find('[data-worked-failed]').exists()).toBe(true)
  })

  it('shows nothing only when everything was read and there was no work', async () => {
    serve(answer())
    const wrapper = render(FlaWorkLocations)
    await flushPromises()
    expect(wrapper.find('[data-widget="fla-work-locations"]').exists()).toBe(false)
  })
})

describe('回原会话', () => {
  const open = async (locations: unknown, offers?: unknown) => {
    serve(locations, offers)
    const wrapper = render(FlaWorkLocations)
    await flushPromises()
    await wrapper.find('[data-worked-row]').trigger('click')
    await flushPromises()
    return wrapper
  }
  const sessionId = 'f41c9a02-7b5d-4e18-9a30-0c2b7d6e4518'

  it('opens the session only when this computer recorded it and the launcher planned a link', async () => {
    const wrapper = await open(answer({ rows: [row('codex', 'm', { recent: [segment(sessionId, { on_this_computer: true })] })] }),
      { launcher: 'available', offers: [{ sourceApplication: 'codex', sessionId, client: 'codex', offer: 'link', href: `codex://threads/${sessionId}` }] })
    expect(wrapper.find('[data-open-native-session]').attributes('href')).toBe(`codex://threads/${sessionId}`)
  })

  it('a session FULI cannot place on this computer is not offered as a jump', async () => {
    const wrapper = await open(answer({ rows: [row('codex', 'm', { recent: [segment(sessionId, { on_this_computer: null })] })] }),
      { launcher: 'available', offers: [{ sourceApplication: 'codex', sessionId, client: 'codex', offer: 'link', href: 'codex://threads/x' }] })
    expect(wrapper.find('[data-open-native-session]').exists()).toBe(false)
    expect(wrapper.find('[data-session-why]').text()).toBe('没法确认是这台电脑上的会话')
    expect(wrapper.find('[data-copy-session]').exists()).toBe(true)
  })

  it('names why there is no link here: the launcher, or the client', async () => {
    const down = await open(answer({ rows: [row('codex', 'm', { recent: [segment(sessionId, { on_this_computer: true })] })] }),
      { launcher: 'unavailable' })
    expect(down.find('[data-session-why]').text()).toBe('这台电脑的会话启动器不可用')
    const noLink = await open(answer({ rows: [row('cursor', 'm', { recent: [segment(sessionId, { client: 'cursor', on_this_computer: true })] })] }),
      { launcher: 'available', offers: [{ sourceApplication: 'cursor', sessionId, client: 'cursor', offer: 'none' }] })
    expect(noLink.findAll('[data-session-why]').at(-1)?.text()).toBe('这个客户端没有可用的打开方式')
  })

  it('a segment with no native session ID says only that', async () => {
    const wrapper = await open(answer({ rows: [row('cursor', null, { recent: [segment(null, { client: 'cursor' })] })] }))
    expect(wrapper.find('[data-no-session]').text()).toBe('没记原生会话 ID')
    expect(wrapper.find('[data-copy-session]').exists()).toBe(false)
  })
})

describe('换个客户端接着做', () => {
  it('names the work and project it carries, and says it leaves the original where it is', async () => {
    serve(answer({ continuation: { conversation_id: 'c2', personal_project_id: 'billing', title: 'CSV export',
      prompt: '#FLA {lead-1} 继续。', opens: 'new_session', leaves_original: true } }))
    const wrapper = render(FlaContinueElsewhere)
    await flushPromises()
    expect(wrapper.find('[data-continuation-what]').text()).toBe('「CSV export」· Billing')
    expect(wrapper.text()).toContain('原来的会话留在原处')
    expect(wrapper.find('[data-copy-continuation]').text()).toBe('复制开场指令')
    expect(wrapper.find('[data-open-native-session]').exists()).toBe(false)
  })

  it('shows nothing when there is no conversation to continue', async () => {
    serve(answer())
    const wrapper = render(FlaContinueElsewhere)
    await flushPromises()
    expect(wrapper.find('[data-widget="fla-continue-elsewhere"]').exists()).toBe(false)
  })
})
