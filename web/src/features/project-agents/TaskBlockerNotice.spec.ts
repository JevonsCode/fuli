import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import manifest from '../../../../registry/client-links.json'
import type { ProjectAgentTaskBlocker, ProjectAgentTaskRecord } from '@/types'
import TaskBlockerNotice from './TaskBlockerNotice.vue'
import { blockedFor, blockerIsStale, blockerReasonText, lastBlockerClear } from './task-blocker'

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

describe('a blocked card is one calm line', () => {
  it('names the reason and how long it has been blocked, without session details or reads', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    // Twelve days and an hour ago, against the shared clock the card reads.
    const since = new Date(Date.now() - (12 * 24 + 1) * 60 * 60 * 1000).toISOString()
    const wrapper = mount(TaskBlockerNotice, { props: { compact: true,
      blocker: blocker({ since, sessionId: null, observed: false }) } })
    await flushPromises()
    expect(wrapper.get('[data-blocker-reason]').text()).toBe('Which staging database should the migration target?')
    expect(wrapper.get('[data-blocker-age]').text()).toBe('已阻塞 12天')
    expect(wrapper.find('[data-blocker-where]').exists()).toBe(false)
    expect(wrapper.find('[data-blocker-observed]').exists()).toBe(false)
    expect(wrapper.find('[data-blocker-status]').exists()).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('leads with the red status chip where the card shows no status, and omits an unknown age', () => {
    const wrapper = mount(TaskBlockerNotice, { props: { compact: true, withStatus: true, blocker: blocker({ since: null }) } })
    const chip = wrapper.get('[data-blocker-status]')
    expect(chip.text()).toBe('阻塞')
    expect(chip.classes()).toContain('is-danger')
    expect(wrapper.find('[data-blocker-age]').exists()).toBe(false)
  })

  it('calls a block stale after about three days without activity', () => {
    const now = Date.parse('2026-10-28T09:00:00Z')
    expect(blockedFor({ since: '2026-10-28T06:00:00Z' }, now)).toBe('3小时')
    expect(blockerIsStale({ since: '2026-10-11T08:00:00Z' }, '2026-10-11T08:00:00Z', now)).toBe(true)
    expect(blockerIsStale({ since: '2026-10-11T08:00:00Z' }, '2026-10-27T08:00:00Z', now)).toBe(false)
    expect(blockerIsStale({ since: null }, null, now)).toBe(false)
  })
})

describe('blocker text', () => {
  it('reads a worker or staffing code as its sentence, keeps a reported question as written, and says when none was recorded', () => {
    expect(blockerReasonText({ reason: 'worker_authentication_required. Actual model use is unverified.' }))
      .toBe('执行这个任务的客户端需要先登录。')
    expect(blockerReasonText({ reason: 'explicit_agent: explicit Agent selected; executor: no usable executor' }))
      .toBe('交给你指定的 Agent；没有可用的执行客户端')
    expect(blockerReasonText({ reason: 'Need the API region.' })).toBe('Need the API region.')
    expect(blockerReasonText({ reason: null })).toBe('没有记录阻塞原因')
  })

  it('keeps the stored text under 原始信息 in the detail, and as the tooltip of the one-line card', async () => {
    const raw = 'project_team_lead: project team lead is the stable conversation owner and fits this work; executor: no usable executor'
    const detail = await render(blocker({ reason: raw }))
    expect(detail.get('[data-task-reason-text]').text()).toBe('由项目组长负责；没有可用的执行客户端')
    expect(detail.get('[data-task-reason-raw] summary').text()).toBe('原始信息')
    expect(detail.get('[data-task-reason-raw] code').text()).toBe(raw)
    const line = mount(TaskBlockerNotice, { props: { compact: true, blocker: blocker({ reason: raw }) } }).get('[data-blocker-reason]')
    expect(line.text()).toBe('由项目组长负责；没有可用的执行客户端')
    expect(line.attributes('title')).toBe(raw)
    const written = mount(TaskBlockerNotice, { props: { compact: true, blocker: blocker() } }).get('[data-blocker-reason]')
    expect(written.attributes('title')).toBe('Which staging database should the migration target?')
  })

  it('names why and when the latest block ended by itself', () => {
    const event = (status: string, at: string, blockerClearedBy: string | null = null) =>
      ({ eventId: at, taskId: 'task-a', status, summary: 's', createdAt: at, blockerClearedBy })
    const task = { taskId: 'task-a', title: 't', status: 'running', participants: [], events: [
      event('blocked', '2026-10-27T08:00:00Z'), event('running', '2026-10-27T09:00:00Z', 'session_reply'),
    ] } as unknown as ProjectAgentTaskRecord
    expect(lastBlockerClear(task)).toEqual({ cause: 'session_reply', at: '2026-10-27T09:00:00Z', note: null })
    expect(lastBlockerClear({ ...task, status: 'blocked' })).toBeNull()
    const explicit = { ...task, events: [...task.events!, event('blocked', '2026-10-27T10:00:00Z'), event('running', '2026-10-27T11:00:00Z')] } as unknown as ProjectAgentTaskRecord
    expect(lastBlockerClear(explicit)).toBeNull()
  })

  it('keeps a clear the person made, with their note', () => {
    const task = { taskId: 'task-a', title: 't', status: 'running', participants: [], events: [
      { eventId: 'a', taskId: 'task-a', status: 'blocked', summary: 's', createdAt: '2026-10-11T08:00:00Z' },
      { eventId: 'b', taskId: 'task-a', status: 'running', summary: 'Solved elsewhere.', createdAt: '2026-10-28T08:00:00Z',
        blockerClearedBy: 'person', blockerClearNote: 'Solved elsewhere.' },
    ] } as unknown as ProjectAgentTaskRecord
    expect(lastBlockerClear(task)).toEqual({ cause: 'person', at: '2026-10-28T08:00:00Z', note: 'Solved elsewhere.' })
  })
})
