import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, expect, it, vi } from 'vitest'
const { postJson, putJson } = vi.hoisted(() => ({ postJson: vi.fn(), putJson: vi.fn() }))
vi.mock('@/api/client', () => ({ postJson, putJson }))
import AgentConversations from './AgentConversations.vue'

const policy = { compact_after_kb: 64, context_budget: 2000, enabled: true }
const conversation = { id: 'conversation-a', summary: 'Prepare a new page', status: 'completed', revision: 2,
  last_activity: '2026-09-20T10:00:00Z', compacted_through: 12, raw_retained: true, policy,
  continuation_prompt: 'Continue @{agent} in project project-a using conversation conversation-a with a fresh task token.' }
const scope = { personalSpaceId: 'space', agentId: 'agent', personalProjectId: 'project-a' }
function render() {
  return mount(AgentConversations, { props: { personalSpaceId: 'space', agentId: 'agent',
    projects: [{ id: 'project-a', name: 'Project A' }, { id: 'project-b', name: 'Project B' }] } })
}
async function open(wrapper: ReturnType<typeof render>, selector = 'details') {
  const details = wrapper.get(selector)
  ;(details.element as HTMLDetailsElement).open = true
  await details.trigger('toggle')
  await flushPromises()
}
beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
  postJson.mockReset().mockImplementation((_url, body) => Promise.resolve(body.mode === 'policy' ? policy : { conversations: [conversation] }))
  putJson.mockReset().mockResolvedValue(policy)
})
it('reads only on expansion, with exact project and Agent scope', async () => {
  const wrapper = render()
  await flushPromises()
  expect(postJson).not.toHaveBeenCalled()
  await open(wrapper)
  expect(postJson).toHaveBeenCalledWith('/api/agent-conversations/query', { ...scope, mode: 'list', limit: 20 })
  expect(wrapper.text()).toContain('Prepare a new page')
  expect(wrapper.get('[data-memory-settings]').attributes('open')).toBeUndefined()
  expect(postJson.mock.calls.some(([, body]) => body.mode === 'events')).toBe(false)
})
it('reads archived originals in bounded pages only on request', async () => {
  const wrapper = render()
  await open(wrapper)
  postJson.mockResolvedValueOnce({ events: [{ role: 'user', content: 'First message', sequence: 1, kind: 'message' }], next_cursor: 1, has_more: true })
  await wrapper.get('[data-read-conversation]').trigger('click')
  await flushPromises()
  expect(postJson).toHaveBeenLastCalledWith('/api/agent-conversations/query', { ...scope, mode: 'events', conversationId: 'conversation-a', limit: 20 })
  postJson.mockResolvedValueOnce({ events: [{ role: 'assistant', content: 'Second message', sequence: 2, kind: 'message' }], has_more: false })
  await wrapper.get('[data-more-messages]').trigger('click')
  await flushPromises()
  expect(postJson).toHaveBeenLastCalledWith('/api/agent-conversations/query', { ...scope, mode: 'events', conversationId: 'conversation-a', after: 1, limit: 20 })
  expect(wrapper.text()).toContain('First message')
  expect(wrapper.text()).toContain('Second message')
})
it('loads authoritative policy before editing and saves scoped settings', async () => {
  const wrapper = render()
  await open(wrapper)
  await open(wrapper, '[data-memory-settings]')
  expect(wrapper.get<HTMLInputElement>('[name="compactAfterKb"]').element.value).toBe('64')
  await wrapper.get('[name="compactAfterKb"]').setValue(128)
  await wrapper.get('form').trigger('submit')
  await flushPromises()
  expect(putJson).toHaveBeenCalledWith('/api/agent-conversations/policy', { ...scope, compactAfterKb: 128, contextBudget: 2000, enabled: true })
})
it('discards stale message responses when switching projects', async () => {
  const wrapper = render()
  await open(wrapper)
  let resolve!: (value: unknown) => void
  postJson.mockImplementationOnce(() => new Promise(done => { resolve = done }))
  await wrapper.get('[data-read-conversation]').trigger('click')
  postJson.mockResolvedValue({ conversations: [] })
  await wrapper.get('select').setValue('project-b')
  await flushPromises()
  resolve({ events: [{ role: 'user', content: 'Old project secret', sequence: 1 }] })
  await flushPromises()
  expect(wrapper.text()).not.toContain('Old project secret')
})
it('keeps failures visible and allows retry without claiming an empty history', async () => {
  postJson.mockRejectedValueOnce(new Error('History unavailable'))
  const wrapper = render()
  await open(wrapper)
  expect(wrapper.get('[role="alert"]').text()).toContain('History unavailable')
  await wrapper.get('[data-retry-list]').trigger('click')
  await flushPromises()
  expect(wrapper.text()).toContain('Prepare a new page')
})
it('copies the authoritative continuation prompt exactly', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  const wrapper = render()
  await open(wrapper)
  await wrapper.get('[data-copy-continuation="conversation-a"]').trigger('click')
  await flushPromises()
  expect(writeText).toHaveBeenCalledExactlyOnceWith(conversation.continuation_prompt)
  expect(wrapper.get('[data-continuation-feedback]').text()).toContain('已复制接续指令')
})
it('shows the exact prompt for manual selection when clipboard copying fails', async () => {
  const writeText = vi.fn().mockRejectedValue(new Error('Permission denied'))
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  const wrapper = render()
  await open(wrapper)
  await wrapper.get('[data-copy-continuation="conversation-a"]').trigger('click')
  await flushPromises()
  const fallback = wrapper.get<HTMLTextAreaElement>('[data-continuation-fallback]')
  expect(fallback.element.value).toBe(conversation.continuation_prompt)
  expect(wrapper.get('[data-continuation-feedback]').text()).toContain('自动复制失败')
})
it('clears copy feedback and ignores stale clipboard results after switching projects', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  const wrapper = render()
  await open(wrapper)
  await wrapper.get('[data-copy-continuation="conversation-a"]').trigger('click')
  await flushPromises()
  expect(wrapper.find('[data-continuation-feedback]').exists()).toBe(true)

  let resolveCopy!: () => void
  writeText.mockImplementationOnce(() => new Promise<void>(resolve => { resolveCopy = resolve }))
  await wrapper.get('[data-copy-continuation="conversation-a"]').trigger('click')
  await wrapper.get('select').setValue('project-b')
  await flushPromises()
  resolveCopy()
  await flushPromises()
  expect(wrapper.find('[data-continuation-feedback]').exists()).toBe(false)
})
