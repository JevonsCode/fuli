import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProjectAgentTaskBlocker, ProjectAgentTaskRecord } from '@/types'
import ProjectAgentTaskCard from './ProjectAgentTaskCard.vue'
import TaskBlockerClear from './TaskBlockerClear.vue'

// 标记为已解除: the person ends a block whose session will never continue.
const DAY = 24 * 60 * 60 * 1000
const daysAgo = (days: number) => new Date(Date.now() - days * DAY).toISOString()
const scope = { personalSpaceId: 'space-a', personalProjectId: 'project-a', taskId: 'task-a' }
const blocker = (since: string): ProjectAgentTaskBlocker => ({
  reason: 'Need the staging region.', since, agentId: 'synthetic-engineer', application: 'codex',
  sessionId: null, sessionUrl: null, observed: false,
})

function respond(status: number, body: unknown) {
  const calls: { url: string; body: unknown }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init?.body)) })
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }))
  return calls
}

function render(since: string, updatedAt = since) {
  return mount(TaskBlockerClear, { props: { scope, title: 'Migrate staging', blocker: blocker(since), updatedAt },
    attachTo: document.body })
}

async function confirm(wrapper: ReturnType<typeof render>, note: string) {
  await wrapper.get('[data-blocker-clear-open]').trigger('click')
  await flushPromises()
  await wrapper.get('[data-blocker-clear-note]').setValue(note)
  ;(document.querySelector('[data-blocker-clear-confirm]') as HTMLButtonElement).click()
  await flushPromises()
}

afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = '' })

describe('mark a blocked task as unblocked', () => {
  it('offers the action with a quiet hint only when the block has had no progress for days', () => {
    const stale = render(daysAgo(12))
    expect(stale.get('[data-blocker-clear-open]').text()).toBe('标记为已解除')
    expect(stale.get('[data-blocker-clear-open]').attributes('data-term')).toBe('work.unblock')
    expect(stale.get('[data-blocker-stale]').text()).toBe('很久没有进展，如果已经解决可以标记为已解除')
    const recent = render(daysAgo(1))
    expect(recent.find('[data-blocker-stale]').exists()).toBe(false)
  })

  it('keeps the hint only as the tooltip where the page says it once', () => {
    const quiet = mount(TaskBlockerClear, { props: { scope, title: 'Migrate staging', blocker: blocker(daysAgo(12)), updatedAt: daysAgo(12), hint: 'tooltip' } })
    expect(quiet.find('[data-blocker-stale]').exists()).toBe(false)
    expect(quiet.get('[data-blocker-clear-open]').attributes('title')).toBe('很久没有进展，如果已经解决可以标记为已解除')
  })

  it('sends the note to the console route and hands back the running task', async () => {
    const task = { taskId: 'task-a', title: 'Migrate staging', status: 'running', participants: [] }
    const calls = respond(200, task)
    const wrapper = render(daysAgo(12))
    await confirm(wrapper, '  Solved elsewhere.  ')
    expect(calls).toEqual([{ url: '/api/project-agent-tasks/task-a/blocker/clear',
      body: { personalSpaceId: 'space-a', personalProjectId: 'project-a', note: 'Solved elsewhere.' } }])
    expect(wrapper.emitted('cleared')).toEqual([[task]])
    expect(document.querySelector('dialog')).toBeNull()
  })

  it('sends no note when none was written, and says when the task already moved on', async () => {
    const calls = respond(409, { error: 'the task is no longer blocked; reload it' })
    const wrapper = render(daysAgo(12))
    await confirm(wrapper, '   ')
    expect((calls[0].body as { note: unknown }).note).toBeNull()
    expect(wrapper.emitted('cleared')).toBeUndefined()
    expect(document.querySelector('dialog')?.textContent).toContain('这个任务已经不是阻塞状态了')
  })
})

describe('the task detail', () => {
  const stubs = { TaskExecutionPlan: true, TaskRunControls: true, ProjectAgentTaskDiagnostics: true, TaskBlockerNotice: true }
  const detail = (task: Partial<ProjectAgentTaskRecord>) => mount(ProjectAgentTaskCard, {
    props: { task: { taskId: 'task-a', personalProjectId: 'project-a', title: 'Migrate staging', participants: [], ...task } as ProjectAgentTaskRecord,
      projectName: 'Synthetic', agents: [], personalSpaceId: 'space-a', linked: false },
    global: { stubs } })

  it('offers the clear on a blocked task', () => {
    const wrapper = detail({ status: 'blocked', blocker: blocker(daysAgo(12)) })
    expect(wrapper.find('[data-blocker-clear-open]').exists()).toBe(true)
  })

  it('keeps who ended the block, when, and their note', () => {
    const wrapper = detail({ status: 'running', events: [
      { eventId: 'a', taskId: 'task-a', status: 'blocked', summary: 'Need the region.', createdAt: '2026-10-11T08:00:00Z' },
      { eventId: 'b', taskId: 'task-a', status: 'running', summary: 'Solved elsewhere.', createdAt: '2026-10-28T08:00:00Z',
        blockerClearedBy: 'person', blockerClearNote: 'Solved elsewhere.' },
    ] as ProjectAgentTaskRecord['events'] })
    expect(wrapper.find('[data-blocker-clear-open]').exists()).toBe(false)
    const cleared = wrapper.get('[data-blocker-cleared]')
    expect(cleared.attributes('data-cause')).toBe('person')
    expect(cleared.text()).toMatch(/^阻塞已于 .+ 由你手动解除/)
    expect(cleared.get('[data-blocker-clear-note]').text()).toBe('备注：Solved elsewhere.')
  })
})
