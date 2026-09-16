import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
const { getJson, postJson } = vi.hoisted(() => ({ getJson: vi.fn(), postJson: vi.fn() }))
vi.mock('@/api/client', () => ({ getJson, postJson }))
import { attentionTaskHref, useAgentAttention } from './attention-store'
import AgentHand from './AgentHand.vue'
import AgentAttentionCenter from './AgentAttentionCenter.vue'

const item = { requestId: 'request-a', personalSpaceId: 'space-a', personalProjectId: 'project-a', agentId: 'agent-a', taskId: null,
  title: '选择方案', detail: '有两个可行的方案。', requestedAction: '请明确选择 A 或 B。', kind: 'question', status: 'open' as const, revision: 2, createdAt: '2026-09-04T00:00:00Z' }
beforeEach(() => {
  setActivePinia(createPinia()); getJson.mockReset(); postJson.mockReset()
  getJson.mockImplementation(async (url: string) => url.startsWith('/api/project-agents?')
    ? [{ agentId: 'agent-a', profile: { name: '工程师', displayName: 'Milo' } }]
    : { items: [item], total: 201, counts: { 'agent-a': 201 } })
})

describe('Agent attention', () => {
  it('retains exact project and task when following a request', () => {
    expect(attentionTaskHref({ ...item, taskId: 'task-a' })).toBe('/project-agents?agent=agent-a&project=project-a&task=task-a#task-task-a')
  })
  it('does not send a reply to an item from a previous space', async () => {
    const store = useAgentAttention(); store.setSpace('space-b'); await flushPromises()
    await expect(store.respond(item, '选择 A')).rejects.toThrow('different space')
    expect(postJson).not.toHaveBeenCalled()
  })
  it('shows only explicit pending counts and opens the exact Agent queue', async () => {
    const store = useAgentAttention()
    const wrapper = mount(AgentHand, { props: { agentId: 'agent-a' } })
    expect(wrapper.find('button').exists()).toBe(false)
    store.setSpace('space-a'); await flushPromises()
    expect(wrapper.get('button').attributes('aria-label')).toContain('201')
    await wrapper.get('button').trigger('click'); await flushPromises()
    expect(store.open).toBe(true); expect(store.agentId).toBe('agent-a')
    expect(getJson.mock.calls.some(([url]) => url.includes('agentId=agent-a'))).toBe(true)
    store.setSpace('space-b')
    expect(store.counts).toEqual({}); expect(store.items).toEqual([]); expect(store.open).toBe(false)
  })

  it('a failed refresh is not an empty success', async () => {
    const store = useAgentAttention(); store.setSpace('space-a'); await flushPromises()
    getJson.mockRejectedValue(new Error('offline'))
    await store.refresh()
    expect(store.error).toContain('offline'); expect(store.total).toBe(201)
  })

  it('ignores late responses from a previous space', async () => {
    let finish!: (value: unknown) => void
    getJson.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const store = useAgentAttention(); store.setSpace('space-a'); store.setSpace('')
    finish({ items: [item], total: 1, counts: { 'agent-a': 1 } }); await flushPromises()
    expect(store.counts).toEqual({}); expect(store.total).toBe(0)
  })

  it('records an explicit human reply with exact scope/revision; clears hand only after server refresh', async () => {
    const store = useAgentAttention(); store.setSpace('space-a'); await flushPromises()
    postJson.mockResolvedValue({ status: 'resolved' })
    getJson.mockResolvedValue({ items: [], total: 0, counts: {} })
    await store.respond(item, '方案 A')
    expect(postJson).toHaveBeenCalledWith('/api/agent-attention/respond', { personalSpaceId: 'space-a', personalProjectId: 'project-a', requestId: 'request-a', expectedRevision: 2, response: '方案 A' })
    expect(store.counts).toEqual({})
  })

  it('renders the requested action, preserves a failed reply draft, and makes no write on opening', async () => {
    const wrapper = mount(AgentAttentionCenter, { attachTo: document.body, props: { personalSpaceId: 'space-a', projects: [] } })
    await flushPromises(); useAgentAttention().show('agent-a'); await flushPromises()
    expect(document.body.textContent).toContain('Milo')
    expect(document.body.textContent).toContain('请明确选择 A 或 B。')
    expect(postJson).not.toHaveBeenCalled()
    const textarea = document.querySelector('textarea')!
    textarea.value = '方案 A'; textarea.dispatchEvent(new Event('input', { bubbles: true }))
    postJson.mockRejectedValue(new Error('Conflict: reload'))
    document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flushPromises()
    expect(document.body.textContent).toContain('Conflict')
    expect(document.querySelector('textarea')!.value).toBe('方案 A')
    wrapper.unmount()
  })
})
