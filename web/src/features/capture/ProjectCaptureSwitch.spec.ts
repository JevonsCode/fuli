import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'

import { useConsoleStore } from '@/stores/console'
import type { CapturePolicy } from '@/types'
import CaptureProjectSettings from './CaptureProjectSettings.vue'
import ProjectCaptureSwitch from './ProjectCaptureSwitch.vue'
import ProjectOverview from '@/features/projects/ProjectOverview.vue'

const PROJECTS = [
  { project_id: 'family-ledger', personal_space_id: 'space', profile: { name: '家庭账本' } },
  { project_id: 'novel', personal_space_id: 'space', profile: { name: '小说连载' } },
]

// The console's own API: GET reads the saved settings, PATCH answers what one request asks.
function consoleApi(saved: CapturePolicy, patch: (body: Record<string, unknown>) => Promise<Response>) {
  const calls: Array<[string, unknown]> = []
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push([`${init?.method ?? 'GET'} ${input}`, body])
    if (input !== '/api/capture-policy') return Response.json({}, { status: 404 })
    return init?.method === 'PATCH' ? patch(body) : Response.json(saved)
  }))
  return calls
}

function mountBoth(policy: CapturePolicy) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const store = useConsoleStore()
  store.state = { mode: 'personal_only', personalSpaces: [{ id: 'space', name: '我' }], activePersonalSpaceId: 'space',
    projects: [], subscriptions: [], personalProjects: PROJECTS, capturePolicy: policy }
  const toggle = mount(ProjectCaptureSwitch, { props: { projectId: 'family-ledger', projectName: '家庭账本' },
    global: { plugins: [pinia] } })
  const settings = mount(CaptureProjectSettings, { global: { plugins: [pinia] } })
  return { toggle, settings, store }
}

const switchOf = (wrapper: ReturnType<typeof mount>) => wrapper.get('[role="switch"]')

describe('ProjectCaptureSwitch (rec#5 C4-1)', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('flips at once, shows the save inline, and the settings list follows', async () => {
    let answer!: (response: Response) => void
    const calls = consoleApi({ enabled: true }, () => new Promise(resolve => { answer = resolve }))
    const { toggle, settings } = mountBoth({ enabled: true })
    await flushPromises()
    expect(switchOf(toggle).attributes('aria-checked')).toBe('true')

    await switchOf(toggle).trigger('click')
    expect(switchOf(toggle).attributes('aria-checked')).toBe('false')
    expect(toggle.get('[data-project-capture-pending]').attributes('aria-label')).toBe('正在关闭「家庭账本」的记忆')
    expect(switchOf(toggle).attributes('disabled')).toBeDefined()
    expect(calls.at(-1)).toEqual(['PATCH /api/capture-policy', { recordProjects: { 'family-ledger': false } }])

    answer(Response.json({ enabled: true, projectMode: 'all_except', excludedProjectIds: ['family-ledger'],
      projectsOffSince: { 'family-ledger': '2026-10-20T09:30:00.000Z' } }))
    await flushPromises()
    expect(toggle.find('[data-project-capture-pending]').exists()).toBe(false)
    expect(switchOf(toggle).attributes('aria-checked')).toBe('false')
    expect(toggle.text()).toContain('自 2026/10/20 起不再记录')
    // The settings page reads the same saved settings: the project is unchecked there now.
    expect(settings.get('[data-capture-mode="all_except"] [role="radio"]').attributes('aria-checked')).toBe('true')
    expect(settings.get('[data-capture-project="family-ledger"] [role="checkbox"]').attributes('aria-checked')).toBe('false')
    expect(settings.get('[data-capture-project="family-ledger"]').text()).toContain('自 2026/10/20 起未记录')
  })

  it('says nothing changed when the save is refused', async () => {
    consoleApi({ enabled: true }, async () => Response.json({ error: 'Capture policy could not be read' }, { status: 400 }))
    const { toggle } = mountBoth({ enabled: true })
    await flushPromises()
    await switchOf(toggle).trigger('click')
    await flushPromises()
    expect(switchOf(toggle).attributes('aria-checked')).toBe('true')
    expect(toggle.get('[data-project-capture-error]').text()).toBe('没能保存，设置没有改动：Capture policy could not be read')
    expect(toggle.find('[role="alert"]').exists()).toBe(true)
  })

  it('after a failure that may have saved, shows the settings read again, or says the state is unknown (dot review, PR 262)', async () => {
    // The save may have landed before the connection failed: the page reads the settings again.
    let saved: CapturePolicy = { enabled: true }
    consoleApi({ enabled: true }, async () => Response.json({}))
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (init?.method === 'PATCH') {
        saved = { enabled: true, projectMode: 'all_except', excludedProjectIds: ['family-ledger'] }
        return Response.json({ error: 'Internal server error' }, { status: 502 })
      }
      return Response.json(saved)
    })
    const { toggle } = mountBoth({ enabled: true })
    await flushPromises()
    await switchOf(toggle).trigger('click')
    await flushPromises()
    expect(switchOf(toggle).attributes('aria-checked')).toBe('false')
    expect(toggle.get('[data-project-capture-error]').text()).toContain('没能确认是否保存，下面已按最新设置显示')

    // When the second read fails too, the page does not pretend to know.
    vi.mocked(fetch).mockImplementation(async () => { throw new TypeError('Failed to fetch') })
    await switchOf(toggle).trigger('click')
    await flushPromises()
    expect(toggle.get('[data-project-capture-error]').text()).toContain('保存结果未知，请刷新页面确认')
  })

  it('on the project page, a request for one project never shows on the next one (dot review, PR 262)', async () => {
    let answer!: (response: Response) => void
    consoleApi({ enabled: true }, () => new Promise(resolve => { answer = resolve }))
    const pinia = createPinia()
    setActivePinia(pinia)
    useConsoleStore().state = { mode: 'personal_only', personalSpaces: [], projects: [], subscriptions: [],
      personalProjects: PROJECTS, capturePolicy: { enabled: true } }
    const project = ref(PROJECTS[0])
    const Harness = defineComponent(() => () => h(ProjectOverview, { spaceId: 'space', project: project.value }))
    const page = mount(Harness, { global: { plugins: [pinia], stubs: { ProjectTeamSummary: true, RouterLink: true } } })
    await flushPromises()
    await switchOf(page).trigger('click')
    expect(page.find('[data-project-capture-pending]').exists()).toBe(true)
    // The person opens another project while 家庭账本 is still saving.
    project.value = PROJECTS[1]
    await flushPromises()
    expect(page.get('[data-project-capture]').attributes('data-project-capture')).toBe('novel')
    expect(page.find('[data-project-capture-pending]').exists()).toBe(false)
    expect(switchOf(page).attributes('aria-checked')).toBe('true')
    // The old request fails late: nothing of it lands on 小说连载.
    answer(Response.json({ error: 'refused' }, { status: 400 }))
    await flushPromises()
    expect(page.find('[data-project-capture-error]').exists()).toBe(false)
    expect(switchOf(page).attributes('aria-checked')).toBe('true')
  })

  it('shows what an Agent saved since the page loaded (C4-4)', async () => {
    consoleApi({ enabled: true, projectMode: 'selected', selectedProjectIds: ['novel'] }, async () => Response.json({}))
    const { toggle } = mountBoth({ enabled: true })
    expect(switchOf(toggle).attributes('aria-checked')).toBe('true')
    await flushPromises()
    expect(switchOf(toggle).attributes('aria-checked')).toBe('false')
  })

  it('says the switch waits for the global switch when capture is off', async () => {
    consoleApi({ enabled: false }, async () => Response.json({}))
    const { toggle } = mountBoth({ enabled: false })
    await flushPromises()
    expect(toggle.find('[data-project-capture-global-off]').exists()).toBe(true)
  })
})
