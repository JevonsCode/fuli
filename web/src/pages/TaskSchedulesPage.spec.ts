import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TaskSchedulesPage from './TaskSchedulesPage.vue'
import { intervalTooShort, scheduleState, type TaskSchedule } from '@/features/task-schedules/task-schedules'
import { useConsoleStore } from '@/stores/console'

const schedule = (overrides: Partial<TaskSchedule> = {}): TaskSchedule => ({
  id: 'sched-1', personalSpaceId: 'space-1', personalProjectId: 'project-a', revision: 2, enabled: true,
  body: { title: 'Nightly check', objective: 'Run the checks.', workKind: 'verification', requiredCapabilities: [], leadAgentId: null,
    every: { unit: 'hours', count: 24 }, startMode: 'backlog', failureThreshold: 3 },
  nextRunAt: '2026-10-20T00:00:00Z', pausedReason: null, recentRuns: [{ slot: '2026-10-19T00:00:00Z', taskId: null, status: 'failed', createdAt: '2026-10-19T00:00:01Z' }],
  ...overrides,
})

let calls: { url: string; method: string; body?: Record<string, unknown> }[] = []
function serve(routes: Record<string, (body?: Record<string, unknown>) => Response | unknown>) {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ url, method: init?.method ?? 'GET', body })
    const key = Object.keys(routes).find(prefix => url.startsWith(prefix))
    const value = key ? routes[key](body) : undefined
    if (value instanceof Response) return value
    return new Response(JSON.stringify(value ?? {}), { status: value === undefined ? 404 : 200 })
  }))
}

async function mountPage() {
  const store = useConsoleStore()
  // The page reads the active space and the project list from the console store.
  Object.assign(store, { state: { personalProjects: [{ project_id: 'project-a', profile: { name: 'Alpha' } }] } })
  vi.spyOn(store, 'activePersonalSpace', 'get').mockReturnValue({ id: 'space-1' } as never)
  const wrapper = mount(TaskSchedulesPage, { attachTo: document.body, global: { stubs: { teleport: true } } })
  await flushPromises()
  return wrapper
}

beforeEach(() => setActivePinia(createPinia()))
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.innerHTML = '' })

describe('task schedules page', () => {
  it('derives state from enabled and the paused reason, and enforces the 15 minute floor', () => {
    expect(scheduleState(schedule())).toBe('enabled')
    expect(scheduleState(schedule({ enabled: false, pausedReason: 'paused_by_user' }))).toBe('paused')
    expect(scheduleState(schedule({ enabled: false, pausedReason: 'circuit_open' }))).toBe('circuit_open')
    expect(intervalTooShort({ unit: 'minutes', count: 14 })).toBe(true)
    expect(intervalTooShort({ unit: 'minutes', count: 15 })).toBe(false)
  })

  it('lists schedules with the project name, plan time zone and a failed submit without inventing a task', async () => {
    serve({ '/api/task-schedules?': () => ({ schedules: [schedule()] }) })
    const wrapper = await mountPage()
    const row = wrapper.find('[data-schedule-row="sched-1"]')
    expect(row.text()).toContain('Nightly check')
    expect(row.text()).toContain('Alpha')
    expect(row.text()).toContain(Intl.DateTimeFormat().resolvedOptions().timeZone)
    expect(row.text()).toMatch(/提交失败|Submit failed/)
  })

  it('pauses with the revision it showed and reloads after a conflict instead of overwriting', async () => {
    let listed = 0
    serve({
      '/api/task-schedules/sched-1/pause': () => new Response(JSON.stringify({ error: 'changed', code: 'task_schedule_conflict' }), { status: 409 }),
      '/api/task-schedules?': () => { listed += 1; return { schedules: [schedule({ revision: listed + 1 })] } },
    })
    const wrapper = await mountPage()
    await wrapper.find('[data-schedule-pause]').trigger('click')
    await flushPromises()
    expect(calls.find(call => call.url.endsWith('/pause'))!.body).toEqual({ personalSpaceId: 'space-1', expectedRevision: 2 })
    expect(listed).toBe(2)
    expect(wrapper.text()).toMatch(/已重新读取|was reloaded/)
  })

  it('asks before resuming and explains that missed time is not replayed', async () => {
    serve({
      '/api/task-schedules/sched-1/resume': () => schedule({ enabled: true, revision: 4 }),
      '/api/task-schedules?': () => ({ schedules: [schedule({ enabled: false, pausedReason: 'circuit_open', revision: 3 })] }),
    })
    const wrapper = await mountPage()
    await wrapper.find('[data-schedule-resume]').trigger('click')
    await flushPromises()
    expect(document.body.textContent).toMatch(/不补跑|not replayed/)
    ;(document.querySelector('[data-schedule-resume-confirm]') as HTMLButtonElement).click()
    await flushPromises()
    expect(calls.find(call => call.url.endsWith('/resume'))!.body).toEqual({ personalSpaceId: 'space-1', expectedRevision: 3 })
  })

  it('will not create without an explicit start mode and reports a lost create as unconfirmed', async () => {
    serve({
      '/api/task-schedules?': () => ({ schedules: [] }),
      '/api/task-schedules': () => new Response('boom', { status: 502 }),
    })
    const wrapper = await mountPage()
    await wrapper.find('[data-schedule-new]').trigger('click')
    await flushPromises()
    const form = document.querySelector('dialog form') as HTMLFormElement
    form.dispatchEvent(new Event('submit'))
    await flushPromises()
    expect(calls.some(call => call.method === 'POST')).toBe(false)
    expect(document.body.textContent).toMatch(/请选择项目|Choose a project/)
  })
})
