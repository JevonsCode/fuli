import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
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
  router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:any(.*)*', component: { template: '<div />' } }] })
  await router.push('/task-schedules')
  const wrapper = mount(TaskSchedulesPage, { attachTo: document.body, global: { plugins: [router], stubs: { teleport: true } } })
  await flushPromises()
  return wrapper
}
let router: ReturnType<typeof createRouter>

beforeEach(() => setActivePinia(createPinia()))
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.innerHTML = '' })

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

describe('task schedules page after acceptance review', () => {
  async function fillCreate(wrapper: Awaited<ReturnType<typeof mountPage>>) {
    await wrapper.find('[data-schedule-new]').trigger('click')
    await flushPromises()
    const setText = (selector: string, value: string) => {
      const field = document.querySelector(`${selector} input, ${selector} textarea, input${selector}, textarea${selector}`) as HTMLInputElement
      field.value = value
      field.dispatchEvent(new Event('input'))
    }
    setText('[data-schedule-title]', 'Nightly check')
    setText('[data-schedule-objective]', 'Run the checks.')
    setText('[data-schedule-work-kind]', 'verification')
    const backlog = document.querySelector('dialog input[value="backlog"]') as HTMLInputElement
    backlog.checked = true
    backlog.dispatchEvent(new Event('change'))
    await flushPromises()
  }

  it('never offers a second create after an unconfirmed one, only reading the list again', async () => {
    serve({
      '/api/task-schedules?': () => ({ schedules: [] }),
      '/api/task-schedules': () => new Response('boom', { status: 502 }),
    })
    const wrapper = await mountPage()
    await fillCreate(wrapper)
    // The project select is set through the component model directly.
    const page = wrapper.vm as unknown as { draft: { project: string } }
    page.draft.project = 'project-a'
    await flushPromises()
    ;(document.querySelector('dialog form') as HTMLFormElement).dispatchEvent(new Event('submit'))
    await flushPromises()
    expect(calls.filter(call => call.method === 'POST')).toHaveLength(1)
    expect(document.querySelector('[data-schedule-save]')).toBeNull()
    expect(document.querySelector('[data-schedule-verify]')).not.toBeNull()
    ;(document.querySelector('dialog form') as HTMLFormElement).dispatchEvent(new Event('submit'))
    await flushPromises()
    expect(calls.filter(call => call.method === 'POST')).toHaveLength(1)
  })

  it('shows the exact first slot and sends that same time', async () => {
    serve({ '/api/task-schedules?': () => ({ schedules: [] }), '/api/task-schedules': body => ({ ...schedule(), ...body }) })
    const wrapper = await mountPage()
    await fillCreate(wrapper)
    const planned = document.querySelector('[data-schedule-planned]')!.textContent!
    const page = wrapper.vm as unknown as { draft: { project: string } }
    page.draft.project = 'project-a'
    await flushPromises()
    ;(document.querySelector('dialog form') as HTMLFormElement).dispatchEvent(new Event('submit'))
    await flushPromises()
    const sent = calls.find(call => call.method === 'POST')!.body!.firstRunAt as string
    expect(planned).toContain(sent)
  })

  it('edits with the shown revision and lists the latest 50 task records on request', async () => {
    serve({
      '/api/task-schedules/sched-1/update': body => ({ ...schedule(), revision: 3, body: { ...schedule().body, title: String(body?.title) } }),
      '/api/task-schedules/sched-1/runs': () => ({ runs: [{ slot: '2026-10-19T00:00:00Z', taskId: 'task-9', status: 'completed', createdAt: '2026-10-19T00:00:01Z' }] }),
      '/api/task-schedules?': () => ({ schedules: [schedule()] }),
    })
    const wrapper = await mountPage()
    await wrapper.find('[data-schedule-runs]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-schedule-run-panel]').text()).toContain('task-9')
    expect(wrapper.get('[data-schedule-run-panel]').text()).toMatch(/最近 50 条|Latest 50/)
    await wrapper.find('[data-schedule-edit]').trigger('click')
    await flushPromises()
    ;(document.querySelector('dialog form') as HTMLFormElement).dispatchEvent(new Event('submit'))
    await flushPromises()
    const update = calls.find(call => call.url.endsWith('/update'))!
    expect(update.body).toMatchObject({ personalSpaceId: 'space-1', expectedRevision: 2, title: 'Nightly check', startMode: 'backlog' })
  })

  const submit = async () => {
    ;(document.querySelector('dialog form') as HTMLFormElement).dispatchEvent(new Event('submit'))
    await flushPromises()
  }
  const chooseProject = async (wrapper: Awaited<ReturnType<typeof mountPage>>) => {
    ;(wrapper.vm as unknown as { draft: { project: string } }).draft.project = 'project-a'
    await flushPromises()
  }

  it('keeps an unconfirmed create locked when reading the list to check it also fails', async () => {
    let listFails = false
    serve({
      '/api/task-schedules?': () => listFails ? new Response('down', { status: 503 }) : { schedules: [] },
      '/api/task-schedules': () => new Response('down', { status: 503 }),
    })
    const wrapper = await mountPage()
    await fillCreate(wrapper)
    await chooseProject(wrapper)
    await submit()
    listFails = true
    ;(document.querySelector('[data-schedule-verify]') as HTMLButtonElement).click()
    await flushPromises()
    expect(document.querySelector('[data-schedule-verify]')).not.toBeNull()
    expect(document.querySelector('[data-schedule-save]')).toBeNull()
    expect(document.body.textContent).toContain('还不能确认上一次创建的结果')
  })

  it('moves a default first slot that has passed and asks again before sending it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-19T08:00:00Z'))
    serve({ '/api/task-schedules?': () => ({ schedules: [] }), '/api/task-schedules': body => ({ ...schedule(), ...body }) })
    const wrapper = await mountPage()
    await fillCreate(wrapper)
    await chooseProject(wrapper)
    vi.setSystemTime(new Date('2026-10-21T08:00:00Z'))
    await submit()
    expect(calls.some(call => call.method === 'POST')).toBe(false)
    expect(document.body.textContent).toContain('原来的首次计划时间已经过去')
    await submit()
    const sent = calls.find(call => call.method === 'POST')!.body!.firstRunAt as string
    expect(new Date(sent).getTime()).toBeGreaterThan(Date.now())
  })

  it('treats a create with no answer within 30 seconds as unconfirmed, without sending it again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    serve({ '/api/task-schedules?': () => ({ schedules: [] }) })
    const fetch = globalThis.fetch as ReturnType<typeof vi.fn>
    const list = fetch.getMockImplementation() as (url: string, init?: RequestInit) => Promise<Response>
    fetch.mockImplementation((url: string, init?: RequestInit) => init?.method === 'POST'
      ? new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
      : list(url, init))
    const wrapper = await mountPage()
    await fillCreate(wrapper)
    await chooseProject(wrapper)
    await submit()
    expect(document.querySelector('[data-schedule-verify]')).toBeNull()
    vi.advanceTimersByTime(30_000)
    await flushPromises()
    expect(document.querySelector('[data-schedule-verify]')).not.toBeNull()
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  })

  it('opens the task a schedule created from its record', async () => {
    serve({
      '/api/task-schedules/sched-1/runs': () => ({ runs: [{ slot: '2026-10-19T00:00:00Z', taskId: 'task-9', status: 'completed', createdAt: '2026-10-19T00:00:01Z' }] }),
      '/api/task-schedules?': () => ({ schedules: [schedule()] }),
      '/api/project-agent-tasks/task-9?': () => ({ taskId: 'task-9', status: 'completed', leadAgentId: 'lead-1', personalProjectId: 'project-a' }),
    })
    const wrapper = await mountPage()
    await wrapper.find('[data-schedule-runs]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-schedule-open-task]').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/project-agents/manage')
    expect(router.currentRoute.value.query).toEqual({ agent: 'lead-1', project: 'project-a', task: 'task-9' })
  })

  it('after a conflict shows what changed and saves the kept draft with the latest revision', async () => {
    let listed = 0
    serve({
      '/api/task-schedules/sched-1/update': body => body?.expectedRevision === 2
        ? new Response(JSON.stringify({ error: 'changed' }), { status: 409 }) : { ...schedule(), revision: 4 },
      '/api/task-schedules?': () => {
        listed += 1
        return { schedules: [listed === 1 ? schedule() : schedule({ revision: 3, body: { ...schedule().body, title: 'Changed elsewhere' } })] }
      },
    })
    const wrapper = await mountPage()
    await wrapper.find('[data-schedule-edit]').trigger('click')
    await flushPromises()
    await submit()
    expect(document.body.textContent).toContain('修订 3')
    expect(document.body.textContent).toContain('标题')
    await submit()
    const updates = calls.filter(call => call.url.endsWith('/update'))
    expect(updates.map(call => call.body!.expectedRevision)).toEqual([2, 3])
    expect(updates[1]!.body!.title).toBe('Nightly check')
  })

  it('locks the form while a create is sent and shows what was sent when the result is unknown', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    serve({ '/api/task-schedules?': () => ({ schedules: [] }) })
    const fetch = globalThis.fetch as ReturnType<typeof vi.fn>
    const list = fetch.getMockImplementation() as (url: string, init?: RequestInit) => Promise<Response>
    fetch.mockImplementation((url: string, init?: RequestInit) => init?.method === 'POST'
      ? new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
      : list(url, init))
    const wrapper = await mountPage()
    await fillCreate(wrapper)
    await chooseProject(wrapper)
    await submit()
    expect((document.querySelector('dialog fieldset') as HTMLFieldSetElement).disabled).toBe(true)
    // A change made while the request is out cannot reach what is shown as sent.
    ;(wrapper.vm as unknown as { draft: { title: string } }).draft.title = 'NOT-SENT'
    vi.advanceTimersByTime(30_000)
    await flushPromises()
    const summary = document.querySelector('[data-schedule-submitted]')!.textContent!
    const sent = fetch.mock.calls.find(([, init]) => init?.method === 'POST')![1]!
    expect(JSON.parse(String(sent.body)).title).toBe('Nightly check')
    expect(summary).toContain('Nightly check')
    expect(summary).not.toContain('NOT-SENT')
    expect(summary).toContain(JSON.parse(String(sent.body)).firstRunAt)
  })
})

