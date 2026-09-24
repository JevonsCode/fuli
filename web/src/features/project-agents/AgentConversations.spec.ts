import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, expect, it, vi } from 'vitest'
const { postJson, putJson } = vi.hoisted(() => ({ postJson: vi.fn(), putJson: vi.fn() }))
vi.mock('@/api/client', () => ({ postJson, putJson }))
import AgentConversations from './AgentConversations.vue'

const policy = { idle_days: 7, context_budget: 2000, enabled: true }
const conversation = { id: 'conversation-a', summary: 'Prepare a new page', status: 'completed', revision: 2,
  last_activity: '2026-09-20T10:00:00Z', archived: true, raw_retained: true, policy }
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
  expect(wrapper.get<HTMLInputElement>('[name="idleDays"]').element.value).toBe('7')
  await wrapper.get('[name="idleDays"]').setValue(14)
  await wrapper.get('form').trigger('submit')
  await flushPromises()
  expect(putJson).toHaveBeenCalledWith('/api/agent-conversations/policy', { ...scope, idleDays: 14, contextBudget: 2000, enabled: true })
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
