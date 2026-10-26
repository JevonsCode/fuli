import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import manifest from '../../../../registry/client-links.json'
import type { ProjectAgentTaskBlocker, ProjectAgentTaskRecord } from '@/types'
import TaskBlockerNotice from './TaskBlockerNotice.vue'
import { blockerReasonText, lastBlockerClear } from './task-blocker'

const SESSION = '0f8fad5b-d9cb-469f-a165-70867728950e'
const blocker = (changes: Partial<ProjectAgentTaskBlocker> = {}): ProjectAgentTaskBlocker => ({
  reason: 'Which staging database should the migration target?', since: '2026-10-27T08:05:00Z',
  agentId: 'synthetic-engineer', application: 'codex', sessionId: SESSION, sessionUrl: null, observed: true, ...changes,
})
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

async function render(value: ProjectAgentTaskBlocker, updatedAt = '2026-10-27T09:30:00Z') {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ manifest, source: 'bundled', remoteUrl: '', autoUpdate: false,
    lastCheckedAt: null, history: [] })))
  const wrapper = mount(TaskBlockerNotice, { props: { blocker: value, updatedAt } })
  await flushPromises()
  return wrapper
}

describe('a blocked task says what, since when, where, and how to get back there', () => {
  it('shows the question, the time, the client session and a link that opens it', async () => {
    const wrapper = await render(blocker())
    expect(wrapper.get('[data-blocker-reason]').text()).toBe('Which staging database should the migration target?')
    expect(wrapper.get('[data-blocker-since]').text()).toMatch(/起阻塞$/)
    expect(wrapper.get('[data-blocker-where]').text()).toBe(`在 Codex · 会话 ${SESSION}`)
    const link = wrapper.get('[data-blocker-open]')
    expect(link.attributes('href')).toBe(`codex://threads/${SESSION}`)
    expect(link.text()).toBe('在 Codex 中打开会话')
    expect(wrapper.find('[data-blocker-copy]').exists()).toBe(true)
    expect(wrapper.get('[data-blocker-observed]').text()).toContain('自动解除')
  })

  it('offers only the session ID to copy where no verified link exists, and says when FULI cannot see progress', async () => {
    const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) }
    vi.stubGlobal('navigator', { clipboard })
    const wrapper = await render(blocker({ application: 'opencode', sessionId: 'ses_synthetic', observed: false }))
    expect(wrapper.find('[data-blocker-open]').exists()).toBe(false)
    await wrapper.get('[data-blocker-copy]').trigger('click')
    await flushPromises()
    expect(clipboard.writeText).toHaveBeenCalledWith('ses_synthetic')
    expect(wrapper.get('[data-blocker-copy]').text()).toBe('已复制会话 ID')
    const note = wrapper.get('[data-blocker-observed]')
    expect(note.attributes('data-observed')).toBe('false')
    expect(note.text()).toContain('最后一次更新于')
  })

  it('says when the client named no session instead of showing a process ID', async () => {
    const wrapper = await render(blocker({ application: 'claude', sessionId: null, observed: false }))
    expect(wrapper.get('[data-blocker-where]').text()).toBe('在 Claude，这个客户端没有提供会话 ID')
    expect(wrapper.find('[data-blocker-copy]').exists()).toBe(false)
  })
})

describe('blocker text', () => {
  it('turns a worker code into its sentence and keeps a reported question as written', () => {
    expect(blockerReasonText({ reason: 'worker_authentication_required. Actual model use is unverified.' }))
      .toBe('执行这个任务的客户端需要先登录。')
    expect(blockerReasonText({ reason: 'Need the API region.' })).toBe('Need the API region.')
    expect(blockerReasonText({ reason: null })).toBe('没有记录阻塞原因')
  })

  it('names why and when the latest block ended by itself', () => {
    const event = (status: string, at: string, blockerClearedBy: string | null = null) =>
      ({ eventId: at, taskId: 'task-a', status, summary: 's', createdAt: at, blockerClearedBy })
    const task = { taskId: 'task-a', title: 't', status: 'running', participants: [], events: [
      event('blocked', '2026-10-27T08:00:00Z'), event('running', '2026-10-27T09:00:00Z', 'session_reply'),
    ] } as unknown as ProjectAgentTaskRecord
    expect(lastBlockerClear(task)).toEqual({ cause: 'session_reply', at: '2026-10-27T09:00:00Z' })
    expect(lastBlockerClear({ ...task, status: 'blocked' })).toBeNull()
    const explicit = { ...task, events: [...task.events!, event('blocked', '2026-10-27T10:00:00Z'), event('running', '2026-10-27T11:00:00Z')] } as unknown as ProjectAgentTaskRecord
    expect(lastBlockerClear(explicit)).toBeNull()
  })
})
