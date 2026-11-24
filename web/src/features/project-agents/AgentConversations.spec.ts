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
  continuation_prompt: 'Continue #FLA {agent} in project project-a using conversation conversation-a with a fresh task token.' }
const scope = { personalSpaceId: 'space', agentId: 'agent', personalProjectId: 'project-a' }
function render() {
  return mount(AgentConversations, { props: { personalSpaceId: 'space', agentId: 'agent',
    projects: [{ project_id: 'project-a', personal_space_id: 'space', profile: { name: 'Project A' } }, { project_id: 'project-b', personal_space_id: 'space', profile: { name: 'Project B' } }] }, global: { stubs: { ...optionSelectStubs } } })
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

// 11-19: a task result opens the exact checkpoint that wrote it, with its client
// and session; a missing or moved source never shows another record.
const claudeSource = { sequence: 3, event_id: 'synthetic-claude:summary', client: 'claude_code', session_id: 'synthetic-claude-session' }
const codexSource = { sequence: 5, event_id: 'synthetic-codex:summary', client: 'codex', session_id: 'synthetic-codex-session' }
async function openTasks(tasks: unknown[]) {
  const wrapper = render()
  await open(wrapper)
  postJson.mockResolvedValueOnce({ events: [], has_more: false, digest: { entries: [], omitted: 0, tasks } })
  await wrapper.get('[data-read-conversation]').trigger('click')
  await flushPromises()
  return wrapper
}
it('opens the exact checkpoint of each task result, even when two clients wrote the same words', async () => {
  const wrapper = await openTasks([
    { at: '2026-11-18T21:00:00Z', status: 'completed', summary: 'Same words', source: claudeSource },
    { at: '2026-11-18T21:01:00Z', status: 'completed', summary: 'Same words', source: codexSource }])
  expect(wrapper.get('[data-conversation-digest]').text()).toContain('Agent 收尾时写的工作小结')
  let resolve!: (value: unknown) => void
  postJson.mockImplementationOnce(() => new Promise(done => { resolve = done }))
  await wrapper.findAll('[data-digest-task]')[1].get('[data-view-source]').trigger('click')
  expect(wrapper.findAll('[data-digest-task]')[1].text()).toContain('正在读取这条小结的原记录')
  expect(postJson).toHaveBeenLastCalledWith('/api/agent-conversations/query', { ...scope, mode: 'events',
    conversationId: 'conversation-a', after: 4, limit: 1, eventId: 'synthetic-codex:summary' }, expect.objectContaining({ schema: expect.anything() }))
  resolve({ source_check: 'verified', events: [{ ...codexSource, content: 'Same words', kind: 'checkpoint', role: 'summary' }] })
  await flushPromises()
  const record = wrapper.findAll('[data-digest-task]')[1].get('[data-source-record]')
  expect(record.text()).toContain('任务小结（checkpoint #5）')
  expect(record.text()).toContain('Codex')
  expect(record.text()).toContain('synthetic-codex-session')
  expect(wrapper.findAll('[data-digest-task]')[0].find('[data-source-record]').exists()).toBe(false)
})
it('says unavailable when the source is gone or another event answers, and unknown when none was kept', async () => {
  const wrapper = await openTasks([
    { at: '2026-11-18T21:00:00Z', status: 'completed', summary: 'Older words', source: null },
    { at: '2026-11-18T21:01:00Z', status: 'completed', summary: 'Moved', source: codexSource },
    { at: '2026-11-18T21:02:00Z', status: 'completed', summary: 'Next one', source: claudeSource }])
  const rows = () => wrapper.findAll('[data-digest-task]')
  expect(rows()[0].find('[data-view-source]').exists()).toBe(false)
  // Neutral: a missing source may be an older result or a write with no single matching checkpoint.
  expect(rows()[0].get('[data-source-unknown]').text()).toBe('来源未知')
  setLocale('en-US', { persist: false })
  await flushPromises()
  expect(rows()[0].get('[data-source-unknown]').text()).toBe('Source unknown')
  setLocale('zh-CN', { persist: false })
  await flushPromises()
  postJson.mockResolvedValueOnce({ source_check: 'unavailable', events: [] })
  await rows()[1].get('[data-view-source]').trigger('click')
  await flushPromises()
  expect(rows()[1].get('[data-source-unavailable]').text()).toContain('原记录不可用')
  // An older Provider that ignores eventId returns whatever comes next: never shown as the original.
  postJson.mockResolvedValueOnce({ events: [{ sequence: 4, event_id: 'synthetic-other', content: 'Someone else', kind: 'message',
    role: 'user', client: 'codex', session_id: 'x' }] })
  await rows()[2].get('[data-view-source]').trigger('click')
  await flushPromises()
  expect(rows()[2].find('[data-source-record]').exists()).toBe(false)
  expect(rows()[2].text()).not.toContain('Someone else')
  expect(rows()[2].find('[data-source-unavailable]').exists()).toBe(true)
})
it('lets a failed source read be tried again', async () => {
  const wrapper = await openTasks([{ at: '2026-11-18T21:00:00Z', status: 'completed', summary: 'Words', source: claudeSource }])
  postJson.mockRejectedValueOnce(new Error('offline'))
  await wrapper.get('[data-view-source]').trigger('click')
  await flushPromises()
  expect(wrapper.get('[data-digest-task]').text()).toContain('原记录读取失败')
  postJson.mockResolvedValueOnce({ source_check: 'verified', events: [{ ...claudeSource, content: 'Words', kind: 'checkpoint', role: 'summary' }] })
  await wrapper.get('[data-view-source]').trigger('click')
  await flushPromises()
  expect(wrapper.get('[data-source-record]').text()).toContain('Claude Code')
})
it('shows the original only when sequence, event ID, client, session and checkpoint kind all match', async () => {
  const deleted = { sequence: 2, event_id: 'synthetic-deleted:summary', client: 'codex', session_id: 'synthetic-codex-session' }
  const wrapper = await openTasks([
    { at: '2026-11-18T21:00:00Z', status: 'completed', summary: 'Words', source: claudeSource },
    { at: '2026-11-18T21:01:00Z', status: 'completed', summary: 'Words', source: codexSource },
    { at: '2026-11-18T21:02:00Z', status: 'completed', summary: 'Gone', source: deleted }])
  const rows = () => wrapper.findAll('[data-digest-task]')
  // Same sequence and ID, written by another client or session: not the original.
  postJson.mockResolvedValueOnce({ source_check: 'verified', events: [{ ...claudeSource, client: 'codex', content: 'Words', kind: 'checkpoint' }] })
  await rows()[0].get('[data-view-source]').trigger('click')
  await flushPromises()
  expect(rows()[0].find('[data-source-unavailable]').exists()).toBe(true)
  // A plain message at that place is not the task result.
  postJson.mockResolvedValueOnce({ source_check: 'verified', events: [{ ...codexSource, content: 'Words', kind: 'message' }] })
  await rows()[1].get('[data-view-source]').trigger('click')
  await flushPromises()
  expect(rows()[1].find('[data-source-unavailable]').exists()).toBe(true)
  // The event was deleted: after:1/limit:1 now finds sequence 3, which is never shown as the original.
  postJson.mockResolvedValueOnce({ events: [{ sequence: 3, event_id: 'synthetic-next:summary', client: 'codex',
    session_id: 'synthetic-codex-session', content: 'The next one', kind: 'checkpoint' }] })
  await rows()[2].get('[data-view-source]').trigger('click')
  await flushPromises()
  expect(rows()[2].find('[data-source-record]').exists()).toBe(false)
  expect(rows()[2].text()).not.toContain('The next one')
  expect(rows()[2].find('[data-source-unavailable]').exists()).toBe(true)
})

it('offers named projects by name and the FLA\'s temporary projects by number, never their generated name', async () => {
  postJson.mockResolvedValue({ conversations: [] })
  const temporary = { project_id: `temporary-${'a'.repeat(64)}`, personal_space_id: 'space', scope_type: 'temporary' as const, profile: { name: '临时任务 / Temporary task' } }
  const wrapper = mount(AgentConversations, { props: { personalSpaceId: 'space', agentId: 'agent',
    projects: [{ project_id: 'project-a', personal_space_id: 'space', profile: { name: 'Project A' } }, temporary] }, global: { stubs: { ...optionSelectStubs } } })
  await open(wrapper)
  // The fold itself is OptionCombobox's (its spec); this spec stubs it as a native select.
  const labels = wrapper.findAll('select option').map(option => option.text())
  expect(labels).toContain('Project A')
  expect(labels).toContain('#aaaaaaaa')
  expect(labels.join(' ')).not.toContain('Temporary task')
  wrapper.unmount()
})
