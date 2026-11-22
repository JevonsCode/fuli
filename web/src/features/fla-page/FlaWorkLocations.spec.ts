import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import FlaContinueElsewhere from './FlaContinueElsewhere.vue'
import FlaWorkLocations from './FlaWorkLocations.vue'

const { getJson } = vi.hoisted(() => ({ getJson: vi.fn() }))
vi.mock('@/api/client', async importOriginal => ({ ...await importOriginal<typeof import('@/api/client')>(), getJson }))

// Synthetic rows and segments only; the server does the counting.
const row = (client: string, model: string | null, extra: Record<string, unknown> = {}) => ({
  client, model, model_source: model ? 'requested' : 'unknown', segments: 1, conversations: 1,
  last_seen: '2026-11-22T09:00:00Z', ...extra,
})
const segment = (client: string, sessionId: string | null, extra: Record<string, unknown> = {}) => ({
  conversation_id: 'c1', client, session_id: sessionId, session_short: sessionId?.slice(0, 8) ?? null,
  model: 'synthetic-model-s', model_source: 'requested', when: '2026-11-22T09:00:00Z',
  status: 'incomplete', title: 'Amount parser for the ledger import', ...extra,
})
const answer = (extra: Record<string, unknown> = {}) => ({
  rows: [], segments: 0, conversations_read: 0, partial: false, recent: [], continuation: null, ...extra,
})

const mounted: Array<{ unmount: () => void }> = []
const render = (component: typeof FlaWorkLocations | typeof FlaContinueElsewhere) => {
  const wrapper = mount(component, { props: { spaceId: 'space-a', agentId: 'lead-1', agentName: 'Lumen' } })
  mounted.push(wrapper)
  return wrapper
}

beforeEach(() => { setActivePinia(createPinia()); getJson.mockReset() })
afterEach(() => { mounted.splice(0).forEach(wrapper => wrapper.unmount()) })

describe('在哪儿干的活', () => {
  it('reads its own data from the FLA alone, so it can sit anywhere', async () => {
    getJson.mockResolvedValue(answer({ rows: [row('codex', 'synthetic-model-s')], segments: 1, conversations_read: 1 }))
    render(FlaWorkLocations)
    await flushPromises()
    expect(getJson.mock.calls[0][0]).toContain('/api/project-agent-work-locations?')
    expect(getJson.mock.calls[0][0]).toContain('agentId=lead-1')
    expect(getJson.mock.calls[0][0]).toContain('personalSpaceId=space-a')
  })

  it('shows each client and model with its counts', async () => {
    getJson.mockResolvedValue(answer({
      rows: [row('codex', 'synthetic-model-s', { segments: 4, conversations: 2 })], segments: 4, conversations_read: 2,
    }))
    const wrapper = render(FlaWorkLocations)
    await flushPromises()
    expect(wrapper.text()).toContain('Codex · synthetic-model-s')
    expect(wrapper.text()).toContain('4 段工作 · 2 个对话')
  })

  it('shows an unreported model as "-" with its reason, never as 0 or a default', async () => {
    getJson.mockResolvedValue(answer({
      rows: [row('cursor', null, { model_reason: 'client_sends_none' }),
        row('claude_code', null, { model_reason: 'not_recorded' })],
      segments: 2, conversations_read: 2,
    }))
    const wrapper = render(FlaWorkLocations)
    await flushPromises()
    const text = wrapper.text()
    expect(text).toContain('-')
    expect(text).toContain('Cursor 不报模型')
    expect(text).toContain('当时没记')
    expect(text).not.toContain('0 段工作')
  })

  it('says how far the count reaches rather than implying a lifetime total', async () => {
    getJson.mockResolvedValue(answer({ rows: [row('codex', 'synthetic-model-s')], segments: 1, conversations_read: 50, partial: true }))
    const wrapper = render(FlaWorkLocations)
    await flushPromises()
    expect(wrapper.text()).toContain('只数了最近 50 个对话')
  })

  it('shows nothing at all for an FLA with no recorded segment', async () => {
    getJson.mockResolvedValue(answer())
    const wrapper = render(FlaWorkLocations)
    await flushPromises()
    expect(wrapper.find('[data-widget="fla-work-locations"]').exists()).toBe(false)
  })

  it('offers the way back to a session, or says why it cannot, once segments are shown', async () => {
    getJson.mockImplementation((url: string) => url.includes('session-launch')
      ? Promise.resolve({ launcher: 'unavailable' })
      : Promise.resolve(answer({
        rows: [row('codex', 'synthetic-model-s'), row('cursor', null), row('opencode', null), row('dsh', null)],
        segments: 4, conversations_read: 1,
        recent: [segment('codex', 'f41c9a02-7b5d-4e18-9a30-0c2b7d6e4518'), segment('cursor', null)],
      })))
    const wrapper = render(FlaWorkLocations)
    await flushPromises()
    await wrapper.find('.worked-more').trigger('click')
    await flushPromises()
    // The launcher could not plan a link, so the ID is offered to copy — a click, not a text field.
    expect(wrapper.find('[data-copy-session]').exists()).toBe(true)
    expect(wrapper.find('[data-open-native-session]').exists()).toBe(false)
    // A segment with no recorded native session says only that, and offers nothing.
    expect(wrapper.find('[data-no-session]').text()).toBe('没记原生会话 ID')
  })
})

describe('换个客户端接着做', () => {
  it('is a separate control that says it opens a new session and leaves the original', async () => {
    getJson.mockResolvedValue(answer({
      continuation: { conversation_id: 'c1', prompt: '#FLA {lead-1} 继续。', opens: 'new_session', leaves_original: true },
    }))
    const wrapper = render(FlaContinueElsewhere)
    await flushPromises()
    expect(wrapper.find('[data-copy-continuation]').text()).toBe('复制开场指令')
    expect(wrapper.text()).toContain('原来那个会话留在原处')
    // It never doubles as the way back to a session.
    expect(wrapper.find('[data-open-native-session]').exists()).toBe(false)
  })

  it('shows nothing when there is no conversation to continue', async () => {
    getJson.mockResolvedValue(answer())
    const wrapper = render(FlaContinueElsewhere)
    await flushPromises()
    expect(wrapper.find('[data-widget="fla-continue-elsewhere"]').exists()).toBe(false)
  })
})
