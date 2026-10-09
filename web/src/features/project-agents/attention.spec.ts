import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
const { getJson, postJson } = vi.hoisted(() => ({ getJson: vi.fn(), postJson: vi.fn() }))
vi.mock('@/api/client', () => ({ getJson, postJson }))
import { attentionTaskHref, useAgentAttention } from './attention-store'
import AgentHand from './AgentHand.vue'
import AgentAttentionCenter from './AgentAttentionCenter.vue'
import { UiSelectStub } from '@/test-support/UiSelectStub'

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
    await expect(store.respond(item, '选择 A')).rejects.toThrow('其他空间')
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

  it('loads a scoped preview without opening or replacing the full attention drawer', async () => {
    const store = useAgentAttention(); store.setSpace('space-a'); await flushPromises()
    const drawerItem = { ...item, requestId: 'drawer-item' }
    const previewItem = { ...item, requestId: 'preview-item' }
    store.open = true; store.agentId = 'agent-drawer'; store.items = [drawerItem]
    getJson.mockResolvedValue({ items: [previewItem], total: 1, counts: { 'agent-a': 1 } })

    await store.refreshPreview('space-a', { force: true })

    expect(store.open).toBe(true)
    expect(store.agentId).toBe('agent-drawer')
    expect(store.items).toEqual([drawerItem])
    expect(store.previewItems).toEqual([previewItem])
    expect(getJson.mock.calls.at(-1)?.[0]).toBe('/api/agent-attention?personalSpaceId=space-a&status=open&limit=5')
  })

  it('ignores a late preview response from a previous personal space', async () => {
    let resolveOld!: (value: unknown) => void
    const old = new Promise(resolve => { resolveOld = resolve })
    const next = { ...item, personalSpaceId: 'space-b', requestId: 'space-b-request' }
    getJson.mockImplementation((url: string) => url.includes('space-a')
      ? old
      : { items: [next], total: 1, counts: {} })
    const store = useAgentAttention()
    const oldRequest = store.refreshPreview('space-a', { force: true })
    await store.refreshPreview('space-b', { force: true })
    resolveOld({ items: [item], total: 1, counts: {} })
    await oldRequest

    expect(store.previewSpaceId).toBe('space-b')
    expect(store.previewItems).toEqual([next])
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
    textarea.value = '方案 A'; textarea.dispatchEvent(new Event('input', { bubbles: true })); await flushPromises()
    postJson.mockRejectedValue(new Error('Conflict: reload'))
    document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flushPromises()
    expect(document.body.textContent).toContain('Conflict')
    expect(document.querySelector('textarea')!.value).toBe('方案 A')
    wrapper.unmount()
  })
  it('requires an explicit selection and sends the selected reply with its optional note', async () => {
    getJson.mockImplementation(async (url: string) => url.startsWith('/api/project-agents?') ? [] : { items: [{ ...item, kind: 'review' }], total: 1, counts: {} })
    const wrapper = mount(AgentAttentionCenter, { attachTo: document.body, props: { personalSpaceId: 'space-a', projects: [] } })
    await flushPromises(); useAgentAttention().show(); await flushPromises()
    expect((document.querySelector('button[type=submit]') as HTMLButtonElement).disabled).toBe(true)
    expect(document.querySelector('input:checked')).toBeNull()
    ;(document.querySelector('input[value=accept]') as HTMLInputElement).click(); await flushPromises()
    expect(postJson).not.toHaveBeenCalled()
    const textarea = document.querySelector('textarea')!
    textarea.value = '保留当前布局'; textarea.dispatchEvent(new Event('input', { bubbles: true })); await flushPromises()
    postJson.mockResolvedValue({ status: 'resolved' })
    document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await flushPromises()
    expect(postJson.mock.calls[0]![1].response).toBe('审核通过\n\n保留当前布局')
    wrapper.unmount()
  })

  it('keeps independent drafts while switching requests through the mobile selector', async () => {
    const second = { ...item, requestId: 'request-b', title: '第二个问题' }
    getJson.mockImplementation(async (url: string) => url.startsWith('/api/project-agents?') ? [] : { items: [item, second], total: 2, counts: {} })
    const wrapper = mount(AgentAttentionCenter, { attachTo: document.body, props: { personalSpaceId: 'space-a', projects: [] }, global: { stubs: { UiSelect: UiSelectStub } } })
    await flushPromises(); useAgentAttention().show(); await flushPromises()
    const textarea = document.querySelector('textarea')!
    textarea.value = '第一个回复'; textarea.dispatchEvent(new Event('input', { bubbles: true })); await flushPromises()
    const select = document.querySelector('select[aria-label]') as HTMLSelectElement
    select.value = 'request-b'; select.dispatchEvent(new Event('change', { bubbles: true })); await flushPromises()
    expect(document.querySelector('textarea')!.value).toBe('')
    select.value = 'request-a'; select.dispatchEvent(new Event('change', { bubbles: true })); await flushPromises()
    expect(document.querySelector('textarea')!.value).toBe('第一个回复')
    expect((document.querySelector('input[value=other]') as HTMLInputElement).checked).toBe(true)
    expect(postJson).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('filters foreign-space and foreign-Agent rows from the full queue and later pages', async () => {
    const store = useAgentAttention(); store.setSpace('space-a'); await flushPromises()
    getJson.mockResolvedValue({ items: [item, { ...item, requestId: 'foreign-space', personalSpaceId: 'space-b' }, { ...item, requestId: 'foreign-agent', agentId: 'agent-b' }], total: 3, counts: {} })
    store.show('agent-a'); await flushPromises()
    expect(store.items.map(row => row.requestId)).toEqual(['request-a'])
    await store.more()
    expect(store.items.map(row => row.requestId)).toEqual(['request-a'])
  })

  it('keeps revision warnings on their own request and rechecks saved drafts after reopening', async () => {
    const second = { ...item, requestId: 'request-b', title: '第二个问题' }
    let items = [item, second]
    getJson.mockImplementation(async (url: string) => url.startsWith('/api/project-agents?') ? [] : { items, total: 2, counts: {} })
    const wrapper = mount(AgentAttentionCenter, { attachTo: document.body, props: { personalSpaceId: 'space-a', projects: [] }, global: { stubs: { UiSelect: UiSelectStub } } })
    await flushPromises(); const store = useAgentAttention(); store.show(); await flushPromises()
    const textarea = document.querySelector('textarea')!
    textarea.value = '仍需保留的说明'; textarea.dispatchEvent(new Event('input', { bubbles: true })); await flushPromises()
    const select = document.querySelector('select[aria-label]') as HTMLSelectElement
    select.value = 'request-b'; select.dispatchEvent(new Event('change', { bubbles: true })); await flushPromises()
    items = [{ ...item, revision: 3 }, second]; await store.refresh(); await flushPromises()
    expect(document.body.textContent).not.toContain('请求已更新')
    select.value = 'request-a'; select.dispatchEvent(new Event('change', { bubbles: true })); await flushPromises()
    expect(document.body.textContent).toContain('请求已更新')
    expect(document.querySelector('textarea')!.value).toBe('仍需保留的说明')
    expect(document.querySelector('input:checked')).toBeNull()
    expect((document.querySelector('button[type=submit]') as HTMLButtonElement).disabled).toBe(true)
    store.open = false; await flushPromises(); items = [{ ...item, revision: 4 }, second]; store.show(); await flushPromises()
    expect(document.body.textContent).toContain('请求已更新')
    expect(postJson).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('releases the old space lock without allowing its completion to unlock a new submission', async () => {
    const finishes: Array<() => void> = []
    postJson.mockImplementation(() => new Promise<void>(resolve => { finishes.push(resolve) }))
    getJson.mockImplementation(async (url: string) => url.startsWith('/api/project-agents?') ? [] : {
      items: [{ ...item, personalSpaceId: url.includes('space-b') ? 'space-b' : 'space-a' }], total: 1, counts: {},
    })
    const wrapper = mount(AgentAttentionCenter, { attachTo: document.body, props: { personalSpaceId: 'space-a', projects: [] } })
    await flushPromises(); const store = useAgentAttention(); store.show(); await flushPromises()
    const submit = async () => {
      ;(document.querySelector('input[value=clarify]') as HTMLInputElement).click(); await flushPromises()
      document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await flushPromises()
    }
    await submit()
    await wrapper.setProps({ personalSpaceId: 'space-b' }); await flushPromises(); store.show(); await flushPromises()
    expect((document.querySelector('button[aria-label="关闭"]') as HTMLButtonElement).disabled).toBe(false)
    await submit()
    finishes[0]!(); await flushPromises()
    expect((document.querySelector('button[aria-label="关闭"]') as HTMLButtonElement).disabled).toBe(true)
    finishes[1]!(); await flushPromises()
    expect((document.querySelector('button[aria-label="关闭"]') as HTMLButtonElement).disabled).toBe(false)
    expect(postJson.mock.calls.map(([, payload]) => payload.personalSpaceId)).toEqual(['space-a', 'space-b'])
    wrapper.unmount()
  })

  it('does not announce a submission when the request list is only refreshing', async () => {
    const wrapper = mount(AgentAttentionCenter, { attachTo: document.body, props: { personalSpaceId: 'space-a', projects: [] } })
    await flushPromises(); const store = useAgentAttention(); store.show(); await flushPromises()
    store.loading = true; await flushPromises()
    const submit = document.querySelector('button[type=submit]') as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    expect(submit.textContent).toContain('提交回复')
    expect(document.body.textContent).not.toContain('正在提交')
    wrapper.unmount()
  })

  it('does not offer an already submitted request again when the follow-up refresh fails', async () => {
    const store = useAgentAttention(); store.setSpace('space-a'); await flushPromises(); store.show(); await flushPromises()
    postJson.mockResolvedValue({ status: 'resolved' })
    getJson.mockRejectedValue(new Error('refresh unavailable'))
    await store.respond(item, '方案 A')
    expect(store.items).toEqual([])
    expect(store.previewItems).toEqual([])
    expect(store.total).toBe(200)
    expect(store.counts['agent-a']).toBe(200)
    expect(store.error).toContain('refresh unavailable')
  })

  it('does not label the next request as submitting while refreshing after a confirmed reply', async () => {
    const second = { ...item, requestId: 'request-b', title: '第二个问题' }
    getJson.mockImplementation(async (url: string) => url.startsWith('/api/project-agents?') ? [] : { items: [item, second], total: 2, counts: {} })
    const wrapper = mount(AgentAttentionCenter, { attachTo: document.body, props: { personalSpaceId: 'space-a', projects: [] } })
    await flushPromises(); const store = useAgentAttention(); store.show(); await flushPromises()
    let finish!: (value: unknown) => void
    getJson.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    postJson.mockResolvedValue({ status: 'resolved' })
    ;(document.querySelector('input[value=clarify]') as HTMLInputElement).click(); await flushPromises()
    document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await flushPromises()
    expect(document.body.textContent).toContain('第二个问题')
    expect(document.body.textContent).not.toContain('正在提交')
    expect((document.querySelector('button[type=submit]') as HTMLButtonElement).disabled).toBe(true)
    finish({ items: [second], total: 1, counts: {} }); await flushPromises()
    finish({ items: [second], total: 1, counts: {} }); await flushPromises()
    expect(postJson).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

})
