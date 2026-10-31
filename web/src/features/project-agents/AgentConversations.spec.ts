import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, expect, it, vi } from 'vitest'
const { getJson, postJson, putJson } = vi.hoisted(() => ({ getJson: vi.fn(), postJson: vi.fn(), putJson: vi.fn() }))
vi.mock('@/api/client', () => ({ getJson, postJson, putJson }))
import AgentConversations from './AgentConversations.vue'
import { setLocale } from '@/i18n'
import { optionSelectStubs } from '@/test-support/OptionSelectStub'

const policy = { compact_after_kb: 64, context_budget: 2000, enabled: true }
const conversation = { id: 'conversation-a', summary: 'Prepare a new page', status: 'completed', revision: 2,
  last_activity: '2026-09-20T10:00:00Z', compacted_through: 12, raw_retained: true, policy,
  continuation_prompt: 'Continue @{agent} in project project-a using conversation conversation-a with a fresh task token.' }
const scope = { personalSpaceId: 'space', agentId: 'agent', personalProjectId: 'project-a' }
function render() {
  return mount(AgentConversations, { props: { personalSpaceId: 'space', agentId: 'agent',
    projects: [{ id: 'project-a', name: 'Project A' }, { id: 'project-b', name: 'Project B' }] }, global: { stubs: { ...optionSelectStubs } } })
}
async function open(wrapper: ReturnType<typeof render>, selector?: string) {
  // The panel itself is always shown and loads on display; only nested settings still open.
  if (!selector) return flushPromises()
  const details = wrapper.get(selector)
  ;(details.element as HTMLDetailsElement).open = true
  await details.trigger('toggle')
  await flushPromises()
}
beforeEach(() => {
  setLocale('zh-CN', { persist: false })
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
  postJson.mockReset().mockImplementation((_url, body) => Promise.resolve(body.mode === 'policy' ? policy : { conversations: [conversation] }))
  putJson.mockReset().mockResolvedValue(policy)
  getJson.mockReset().mockResolvedValue({ revision: 0, current: null, history: [], workLog: [] })
})
// Synthetic working-memory fixture, not a real employee record.
const memory = (summary: string, revision = 3) => ({ revision, authority: 'working_context_not_confirmed_knowledge',
  current: { revision, createdAt: '2026-10-10T08:00:00Z', sourceApplication: 'codex',
    memory: { summary, decisions: ['Keep raw history'], openThreads: ['Confirm export format'], nextActions: [] } } })
it('shows the selected scope working memory with revision and empty or failed states', async () => {
  getJson.mockResolvedValueOnce(memory('Synthetic project memory'))
  const wrapper = render()
  await open(wrapper)
  expect(getJson).toHaveBeenCalledWith('/api/project-agents/agent/memory?personalSpaceId=space&personalProjectId=project-a')
  const section = wrapper.get('[data-working-memory]')
  expect(section.text()).toContain('Synthetic project memory')
  expect(section.text()).toContain('Keep raw history')
  expect(section.text()).toContain('Confirm export format')
  expect(section.text()).toContain('3')
  expect(section.text()).not.toContain('下一步')
  getJson.mockRejectedValueOnce(new Error('Memory unavailable'))
  await wrapper.get('select').setValue('')
  await flushPromises()
  expect(getJson).toHaveBeenLastCalledWith('/api/project-agents/agent/memory?personalSpaceId=space')
  expect(wrapper.get('[data-working-memory] [role="alert"]').text()).toContain('Memory unavailable')
  await wrapper.get('[data-retry-memory]').trigger('click')
  await flushPromises()
  expect(wrapper.get('[data-working-memory]').text()).toContain('还没有经过检查点保存的工作记忆')
})
it('discards a stale working-memory response after switching scope', async () => {
  let resolve!: (value: unknown) => void
  getJson.mockImplementationOnce(() => new Promise(done => { resolve = done }))
  const wrapper = render()
  await open(wrapper)
  getJson.mockResolvedValueOnce(memory('Global memory', 1))
  await wrapper.get('select').setValue('')
  await flushPromises()
  resolve(memory('Old project memory'))
  await flushPromises()
  expect(wrapper.text()).toContain('Global memory')
  expect(wrapper.text()).not.toContain('Old project memory')
})
it('shows compacted extraction with source references distinct from originals', async () => {
  const wrapper = render()
  await open(wrapper)
  postJson.mockResolvedValueOnce({ events: [{ role: 'user', content: 'Title\nDecision: use port 3000', sequence: 1, kind: 'message' }],
    next_cursor: 1, has_more: false, digest: { tasks: [], notes: ['Legacy request'], omitted: 4, entries: [
      { kind: 'request', text: 'Title', sources: [{ role: 'user', sequence: 1 }] },
      { kind: 'compaction', text: 'Synthetic client compaction summary', sources: [{ role: 'summary', sequence: 7 }], truncated: true },
    ] } })
  await wrapper.get('[data-read-conversation]').trigger('click')
  await flushPromises()
  const digest = wrapper.get('[data-conversation-digest]')
  expect(digest.text()).toContain('较早消息折叠后的索引')
  expect(digest.text()).toContain('客户端压缩摘要')
  expect(digest.text()).toContain('Synthetic client compaction summary')
  expect(digest.text()).toContain('用户 #1')
  expect(digest.text()).toContain('摘要 #7')
  expect(digest.text()).toContain('已截断')
  expect(digest.text()).toContain('Legacy request')
  expect(digest.text()).toContain('4')
  // The original record remains readable alongside its sequence number.
  expect(wrapper.get('.conversation-messages > ol').text()).toContain('#1')
  expect(wrapper.get('.conversation-messages > ol').text()).toContain('Decision: use port 3000')
})
it('reports omissions even when nothing was extracted and keeps shared-prefix entries distinct', async () => {
  const wrapper = render()
  await open(wrapper)
  postJson.mockResolvedValueOnce({ events: [], has_more: false, digest: { entries: [], omitted: 2 } })
  await wrapper.get('[data-read-conversation]').trigger('click')
  await flushPromises()
  expect(wrapper.get('[data-conversation-digest]').text()).toContain('另有 2 行')
  const shared = { kind: 'compaction', text: 'Synthetic shared prefix…', truncated: true }
  postJson.mockResolvedValueOnce({ events: [], has_more: false, digest: { omitted: 0, entries: [
    { ...shared, sources: [{ role: 'summary', sequence: 1 }] }, { ...shared, sources: [{ role: 'summary', sequence: 2 }] }] } })
  await wrapper.get('[data-read-conversation]').trigger('click')
  await flushPromises()
  expect(wrapper.findAll('[data-conversation-digest] li')).toHaveLength(2)
})
it('names the working-memory source client readably', async () => {
  getJson.mockResolvedValueOnce({ ...memory('Synthetic memory'), current: { ...memory('Synthetic memory').current, sourceApplication: 'claude_code' } })
  const wrapper = render()
  await open(wrapper)
  expect(wrapper.get('[data-working-memory]').text()).toContain('Claude Code')
  expect(wrapper.get('[data-working-memory]').text()).not.toContain('claude_code')
})
it('reads once on display, with exact project and Agent scope', async () => {
  const wrapper = render()
  await open(wrapper)
  expect(postJson).toHaveBeenCalledTimes(1)
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
it('uses independent global conversations and policy when no project is assigned', async () => {
  const wrapper = render()
  await wrapper.setProps({ projects: [] })
  await open(wrapper)
  expect(postJson).toHaveBeenLastCalledWith('/api/agent-conversations/query', { ...scope, personalProjectId: null, mode: 'list', limit: 20 })
  await open(wrapper, '[data-memory-settings]')
  await wrapper.get('form').trigger('submit')
  await flushPromises()
  expect(putJson).toHaveBeenLastCalledWith('/api/agent-conversations/policy', { ...scope, personalProjectId: null, compactAfterKb: 64, contextBudget: 2000, enabled: true })
  wrapper.unmount()
})
it('switches between global and assigned project scopes without retaining old messages or settings', async () => {
  const wrapper = render()
  await open(wrapper)
  await open(wrapper, '[data-memory-settings]')
  let resolve!: (value: unknown) => void
  postJson.mockImplementationOnce(() => new Promise(done => { resolve = done }))
  await wrapper.get('[data-read-conversation]').trigger('click')
  await wrapper.get('select').setValue('')
  await flushPromises()
  resolve({ events: [{ role: 'user', content: 'Private project message', sequence: 1 }] })
  await flushPromises()
  expect(wrapper.text()).not.toContain('Private project message')
  expect(postJson).toHaveBeenCalledWith('/api/agent-conversations/query', { ...scope, personalProjectId: null, mode: 'policy' })
  await wrapper.get('select').setValue('project-b')
  await flushPromises()
  expect(postJson).toHaveBeenLastCalledWith('/api/agent-conversations/query', { ...scope, personalProjectId: 'project-b', mode: 'list', limit: 20 })
  wrapper.unmount()
})
// Synthetic export payload; downloads are observed through a stubbed object URL and anchor click.
const exported = (filename: string) => ({ filename, markdown: `# Synthetic\n\n${filename}\n` })
function downloads() {
  const saved: Array<{ name: string; blob: Blob }> = []
  const blobs = new Map<string, Blob>()
  let next = 0
  vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => { const url = `blob:test-${next++}`; blobs.set(url, blob as Blob); return url })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    saved.push({ name: this.download, blob: blobs.get(this.getAttribute('href') ?? '')! })
  })
  return saved
}
const exportCalls = () => getJson.mock.calls.map(([url]) => url as string).filter(url => url.includes('/memory/export'))
it('exports only the selected scope with truthful loading, success and retry states', async () => {
  const saved = downloads()
  const wrapper = render()
  await open(wrapper)
  const button = wrapper.get('[data-export-memory]')
  expect(button.attributes('aria-label')).toContain('Markdown')
  let resolve!: (value: unknown) => void
  getJson.mockImplementationOnce(() => new Promise(done => { resolve = done }))
  await button.trigger('click')
  expect(button.attributes('disabled')).toBeDefined()
  expect(button.attributes('aria-busy')).toBe('true')
  expect(button.text()).toContain('正在导出工作记忆')
  await button.trigger('click')
  expect(exportCalls()).toEqual(['/api/project-agents/agent/memory/export?personalSpaceId=space&personalProjectId=project-a'])
  resolve(exported('fuli-agent-project-project-a-memory-r3.md'))
  await flushPromises()
  expect(saved.map(({ name }) => name)).toEqual(['fuli-agent-project-project-a-memory-r3.md'])
  expect(await saved[0].blob.text()).toContain('project-a-memory-r3')
  expect(wrapper.get('[data-export-feedback]').attributes('role')).toBe('status')
  expect(wrapper.get('[data-export-feedback]').text()).toContain('不会被导入')
  expect(button.attributes('disabled')).toBeUndefined()

  getJson.mockRejectedValueOnce(new Error('internal provider detail'))
  await button.trigger('click')
  await flushPromises()
  expect(wrapper.get('[data-export-feedback]').attributes('role')).toBe('alert')
  expect(wrapper.get('[data-export-feedback]').text()).toContain('导出失败')
  expect(wrapper.text()).not.toContain('internal provider detail')
  expect(saved).toHaveLength(1)
  getJson.mockResolvedValueOnce(exported('retry.md'))
  await button.trigger('click')
  await flushPromises()
  expect(saved.map(({ name }) => name)).toEqual(['fuli-agent-project-project-a-memory-r3.md', 'retry.md'])
  // Existing memory content stays visible throughout.
  expect(wrapper.get('[data-working-memory]').text()).toContain('还没有经过检查点保存的工作记忆')
  vi.restoreAllMocks()
})
it('never downloads an export answered after the scope, Agent or panel changed', async () => {
  const saved = downloads()
  const wrapper = render()
  await open(wrapper)
  const pending: Array<(value: unknown) => void> = []
  getJson.mockImplementation(url => (url as string).includes('/memory/export')
    ? new Promise(done => { pending.push(done) }) : Promise.resolve({ revision: 0, current: null }))
  await wrapper.get('[data-export-memory]').trigger('click')
  await wrapper.get('select').setValue('')
  await flushPromises()
  expect(wrapper.get('[data-export-memory]').attributes('disabled')).toBeUndefined()
  await wrapper.get('[data-export-memory]').trigger('click')
  expect(exportCalls().at(-1)).toBe('/api/project-agents/agent/memory/export?personalSpaceId=space')
  pending[0](exported('stale-project.md'))
  await flushPromises()
  expect(saved).toEqual([])
  pending[1](exported('global.md'))
  await flushPromises()
  expect(saved.map(({ name }) => name)).toEqual(['global.md'])

  await wrapper.get('[data-export-memory]').trigger('click')
  await wrapper.setProps({ agentId: 'other-agent' })
  await flushPromises()
  pending[2](exported('previous-agent.md'))
  await flushPromises()
  await wrapper.get('[data-export-memory]').trigger('click')
  wrapper.unmount()
  pending[3](exported('closed-panel.md'))
  await flushPromises()
  expect(saved.map(({ name }) => name)).toEqual(['global.md'])
  expect(exportCalls()[2]).toBe('/api/project-agents/agent/memory/export?personalSpaceId=space')
  expect(exportCalls()[3]).toBe('/api/project-agents/other-agent/memory/export?personalSpaceId=space')
  vi.restoreAllMocks()
})
it('never downloads a pending export after the component unmounts', async () => {
  const saved = downloads()
  const wrapper = render()
  await open(wrapper)
  let finish!: (value: unknown) => void
  getJson.mockImplementationOnce(() => new Promise(done => { finish = done }))
  await wrapper.get('[data-export-memory]').trigger('click')
  wrapper.unmount()
  finish(exported('after-unmount.md'))
  await flushPromises()
  expect(URL.createObjectURL).not.toHaveBeenCalled()
  expect(saved).toEqual([])
  vi.restoreAllMocks()
})


it('retains a scrubbed current revision without reading its null body or falling back to history', async () => {
  getJson.mockResolvedValue({ revision: 7, current: { revision: 7, createdAt: '2026-10-10T08:00:00Z', memory: null, memoryState: 'scrubbed', scrubbedBy: 'synthetic-deletion' },
    history: [memory('OLDER SECRET').current] })
  const wrapper = render()
  await open(wrapper)
  expect(wrapper.get('[data-working-memory]').text()).toContain('当前工作记忆正文已随来源删除清除（修订 7）')
  expect(wrapper.get('[data-working-memory]').text()).toContain('expectedRevision 7')
  expect(wrapper.get('[data-working-memory]').text()).not.toContain('OLDER SECRET')
  expect(wrapper.find('.memory-summary').exists()).toBe(false)
  wrapper.unmount()
})

it('explains a scrubbed current revision in English without showing old content', async () => {
  setLocale('en-US', { persist: false })
  getJson.mockResolvedValue({ revision: 8, current: { revision: 8, createdAt: '2026-10-10T08:00:00Z', memory: null, memoryState: 'scrubbed' } })
  const wrapper = render()
  await open(wrapper)
  expect(wrapper.get('[data-memory-scrubbed]').text()).toBe('The current working-memory text was cleared with a source deletion (revision 8); it does not fall back to an older version. Rewrite it at the end of this task with expectedRevision 8.')
  expect(wrapper.find('.memory-summary').exists()).toBe(false)
  wrapper.unmount()
})
