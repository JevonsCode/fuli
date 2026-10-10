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
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/roundtables/:threadId?', component: RoundtablesPage }] })
  await router.push(path)
  const wrapper = mount(RoundtablesPage, { global: { plugins: [router] } })
  await flushPromises()
  return wrapper
}

describe('RoundtablesPage', () => {
  beforeEach(() => { setLocale('zh-CN', { persist: false }); getJson.mockReset() })

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

  it('explains that Agents start conversations themselves when there are none', async () => {
    getJson.mockResolvedValue({ threads: [] })
    const wrapper = await mountAt('/roundtables')
    expect(wrapper.text()).toContain('还没有 Agent 之间的对话')
    expect(wrapper.text()).toContain('message_agent')
    expect(wrapper.find('button').exists()).toBe(false)
    wrapper.unmount()
  })
})
