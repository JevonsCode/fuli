import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import TaskRunControls from './TaskRunControls.vue'
import { runOutcomeUncertain, type TaskRunRecord } from './task-runs'
import type { ProjectAgentTaskRecord } from '@/types'

const task = (status: ProjectAgentTaskRecord['status']) => ({ taskId: 'task-1', personalProjectId: 'project-a', title: 'Port tests',
  status, participants: [] }) as unknown as ProjectAgentTaskRecord
const run = (overrides: Partial<TaskRunRecord> = {}): TaskRunRecord => ({ runId: 'run-aaaaaaaa-1', taskId: 'task-1', agentId: 'engineer',
  state: 'closed', executionStatus: 'failed', createdAt: '2026-10-19T00:00:00Z',
  executionResult: { status: 'failed', promptDispatched: true, terminalRecorded: true, processStopped: true, cleanupErrors: [] }, ...overrides })

function respond(routes: Record<string, unknown>) {
  const calls: { url: string; body?: unknown }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const key = Object.keys(routes).find(prefix => url.startsWith(prefix))
    const value = key ? routes[key] : undefined
    if (value instanceof Response) return value
    return new Response(JSON.stringify(value ?? {}), { status: value === undefined ? 404 : 200 })
  }))
  return calls
}

async function mountControls(status: ProjectAgentTaskRecord['status']) {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:any(.*)*', component: { template: '<div />' } }] })
  const wrapper = mount(TaskRunControls, { props: { task: task(status), personalSpaceId: 'space', active: true },
    global: { plugins: [router], stubs: { teleport: true } }, attachTo: document.body })
  await flushPromises()
  return wrapper
}

afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = '' })

describe('task run controls', () => {
  it('reads history in order and pages with the returned cursor', async () => {
    const calls = respond({ '/api/project-agent-tasks/task-1/runs?': { runs: [run()], nextCursor: 'run-aaaaaaaa-1', complete: false } })
    const wrapper = await mountControls('failed')
    expect(wrapper.findAll('.task-run-item')).toHaveLength(1)
    expect(wrapper.text()).toContain('1')
    await wrapper.findAll('button').find(button => /加载更多|Load more/.test(button.text()))!.trigger('click')
    await flushPromises()
    expect(calls.at(-1)!.url).toContain('cursor=run-aaaaaaaa-1')
  })

  it('stops only the selected active run and reports access revoked, not the process stopped', async () => {
    const active = run({ runId: 'run-bbbbbbbb-2', state: 'admitted', executionResult: null })
    const calls = respond({
      '/api/project-agent-tasks/task-1/runs/run-bbbbbbbb-2/stop': { status: 'stopping', run: { ...active, state: 'revoked' } },
      '/api/project-agent-tasks/task-1/runs?': { runs: [active], nextCursor: null, complete: true },
    })
    const wrapper = await mountControls('running')
    await wrapper.findAll('button').find(button => /停止运行|Stop run/.test(button.text()))!.trigger('click')
    await flushPromises()
    const confirm = [...document.querySelectorAll('dialog button')].find(button => /^(停止运行|Stop run)$/.test(button.textContent!.trim()))!
    ;(confirm as HTMLButtonElement).click()
    await flushPromises()
    const stop = calls.find(call => call.url.endsWith('/stop'))!
    expect(stop.body).toEqual({ personalSpaceId: 'space', personalProjectId: 'project-a' })
    expect(wrapper.text()).toMatch(/权限已撤销，进程状态待确认|Access revoked; process status unconfirmed/)
  })

  it('needs an explicit start choice, and an acknowledgement when an earlier outcome is uncertain', async () => {
    const unclear = run({ executionResult: { status: 'failed', promptDispatched: true, terminalRecorded: false, processStopped: true } })
    expect(runOutcomeUncertain(unclear)).toBe(true)
    const calls = respond({
      '/api/project-agent-tasks/task-1/retry': { task: { taskId: 'task-2', status: 'backlog' }, assignedAgent: { agentId: 'engineer' } },
      '/api/project-agent-tasks/task-1/runs?': { runs: [unclear], nextCursor: null, complete: true },
    })
    const wrapper = await mountControls('failed')
    await wrapper.findAll('button').find(button => /重试|Retry/.test(button.text()))!.trigger('click')
    await flushPromises()
    const submit = () => [...document.querySelectorAll('dialog button[type="submit"]')][0] as HTMLButtonElement
    expect(submit().disabled).toBe(true)
    const backlog = document.querySelector('dialog input[value="backlog"]') as HTMLInputElement
    backlog.checked = true
    backlog.dispatchEvent(new Event('change'))
    await flushPromises()
    expect(submit().disabled).toBe(true)
    const ack = document.querySelector('dialog input[type="checkbox"]') as HTMLInputElement
    ack.checked = true
    ack.dispatchEvent(new Event('change'))
    await flushPromises()
    expect(submit().disabled).toBe(false)
    submit().click()
    await flushPromises()
    expect(calls.find(call => call.url.endsWith('/retry'))!.body).toEqual({ personalSpaceId: 'space', personalProjectId: 'project-a', start: false })
    expect(wrapper.emitted('changed')).toHaveLength(1)
    expect(wrapper.find('a').attributes('href')).toContain('task=task-2')
  })

  it('treats a server failure on stop as an unconfirmed result', async () => {
    const active = run({ runId: 'run-cccccccc-3', state: 'claimed', executionResult: null })
    respond({
      '/api/project-agent-tasks/task-1/runs/run-cccccccc-3/stop': new Response('boom', { status: 503 }),
      '/api/project-agent-tasks/task-1/runs?': { runs: [active], nextCursor: null, complete: true },
    })
    const wrapper = await mountControls('running')
    await wrapper.findAll('button').find(button => /停止运行|Stop run/.test(button.text()))!.trigger('click')
    await flushPromises()
    ;([...document.querySelectorAll('dialog button')].find(button => /^(停止运行|Stop run)$/.test(button.textContent!.trim())) as HTMLButtonElement).click()
    await flushPromises()
    expect(document.body.textContent).toMatch(/操作结果未确认|The result is unconfirmed/)
  })

  it('offers no retry for a task that is still open', async () => {
    respond({ '/api/project-agent-tasks/task-1/runs?': { runs: [], nextCursor: null, complete: true } })
    const wrapper = await mountControls('awaiting_review')
    expect(wrapper.findAll('button').some(button => /重试|Retry/.test(button.text()))).toBe(false)
    expect(wrapper.text()).toMatch(/暂无运行记录|No recorded runs/)
  })
})
