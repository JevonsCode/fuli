import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useConsoleStore } from '@/stores/console'
import type { CapturePolicy } from '@/types'
import CaptureProjectSettings from './CaptureProjectSettings.vue'

const PROJECTS = [
  { project_id: 'thesis', personal_space_id: 'space', profile: { name: '毕业论文' } },
  { project_id: 'job-hunt', personal_space_id: 'space', profile: { name: '求职准备' } },
  { project_id: 'novel', personal_space_id: 'space', profile: { name: '小说连载' } },
  { project_id: 'other-space', personal_space_id: 'elsewhere', profile: { name: '别的空间' } },
  { project_id: 'scratch', personal_space_id: 'space', scope_type: 'temporary' as const, profile: { name: '临时' } },
]

function mountSettings(policy: CapturePolicy, patch: (body: Record<string, unknown>) => Promise<Response>) {
  const patches: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    if (input !== '/api/capture-policy') return Response.json({}, { status: 404 })
    if (init?.method !== 'PATCH') return Response.json(policy)
    const body = JSON.parse(String(init.body))
    patches.push(body)
    return patch(body)
  }))
  const pinia = createPinia()
  setActivePinia(pinia)
  const store = useConsoleStore()
  store.state = { mode: 'personal_only', personalSpaces: [{ id: 'space', name: '我' }], activePersonalSpaceId: 'space',
    projects: [], subscriptions: [], personalProjects: PROJECTS, capturePolicy: policy }
  return { wrapper: mount(CaptureProjectSettings, { global: { plugins: [pinia] }, attachTo: document.body }), patches, store }
}

const checked = (wrapper: ReturnType<typeof mount>) => wrapper.findAll('[data-capture-project]')
  .map(row => [row.attributes('data-capture-project'), row.get('[role="checkbox"]').attributes('aria-checked')])

describe('CaptureProjectSettings (rec#5 C4-1)', () => {
  afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = '' })

  it('lists this space\'s projects with whether each is recorded', async () => {
    const { wrapper } = mountSettings({ enabled: true, projectMode: 'all_except', excludedProjectIds: ['job-hunt'] },
      async () => Response.json({}))
    await flushPromises()
    expect(checked(wrapper)).toEqual([['thesis', 'true'], ['job-hunt', 'false'], ['novel', 'true']])
    expect(wrapper.get('[data-capture-projects-count]').text()).toBe('记录 2 / 3 个项目')
    expect(wrapper.get('[data-capture-unregistered] [role="switch"]').attributes('aria-checked')).toBe('true')
    wrapper.unmount()
  })

  it('changes the mode at once with an inline status', async () => {
    let answer!: (response: Response) => void
    const { wrapper, patches } = mountSettings({ enabled: true }, () => new Promise(resolve => { answer = resolve }))
    await flushPromises()
    await wrapper.get('[data-capture-mode="selected"] [role="radio"]').trigger('click')
    expect(patches).toEqual([{ projectMode: 'selected' }])
    expect(wrapper.get('[data-capture-mode="selected"] [role="radio"]').attributes('aria-checked')).toBe('true')
    expect(wrapper.get('[data-capture-pending]').attributes('aria-label')).toBe('正在改为「只记录勾选的项目」')
    answer(Response.json({ enabled: true, projectMode: 'selected', selectedProjectIds: [], unregisteredDirectories: 'skip' }))
    await flushPromises()
    expect(wrapper.find('[data-capture-pending]').exists()).toBe(false)
    expect(checked(wrapper).every(([, state]) => state === 'false')).toBe(true)
    expect(wrapper.get('[data-capture-unregistered] [role="switch"]').attributes('aria-checked')).toBe('false')
    wrapper.unmount()
  })

  it('saves a batch of checked projects in one request, sending only what changed', async () => {
    const { wrapper, patches } = mountSettings({ enabled: true, projectMode: 'selected', selectedProjectIds: ['thesis'] },
      async body => Response.json({ enabled: true, projectMode: 'selected',
        selectedProjectIds: Object.entries(body.recordProjects as Record<string, boolean>).filter(([, on]) => on).map(([id]) => id) }))
    await flushPromises()
    expect(wrapper.get('[data-capture-projects-save]').attributes('disabled')).toBeDefined()
    await wrapper.get('[data-capture-select-all]').trigger('click')
    await wrapper.get('[data-capture-project="thesis"] [role="checkbox"]').trigger('click')
    await wrapper.get('[data-capture-projects-save]').trigger('click')
    await flushPromises()
    expect(patches).toEqual([{ recordProjects: { thesis: false, 'job-hunt': true, novel: true } }])
    expect(checked(wrapper)).toEqual([['thesis', 'false'], ['job-hunt', 'true'], ['novel', 'true']])
    expect(wrapper.get('[data-capture-message]').text()).toBe('项目记录选择已保存')
    wrapper.unmount()
  })

  it('saves only the projects ticked here; one switched off elsewhere meanwhile stays off (dot review P2-1, PR 262)', async () => {
    const { wrapper, patches, store } = mountSettings({ enabled: true },
      async body => Response.json({ enabled: true, projectMode: 'all_except',
        excludedProjectIds: ['job-hunt', ...Object.keys(body.recordProjects as Record<string, boolean>)] }))
    await flushPromises()
    // The person unticks 毕业论文 here…
    await wrapper.get('[data-capture-project="thesis"] [role="checkbox"]').trigger('click')
    // …while 求职准备 is switched off on its project page (or by a confirmed Agent request).
    store.rememberCapturePolicy({ enabled: true, projectMode: 'all_except', excludedProjectIds: ['job-hunt'] })
    await flushPromises()
    expect(checked(wrapper)).toEqual([['thesis', 'false'], ['job-hunt', 'false'], ['novel', 'true']])
    await wrapper.get('[data-capture-projects-save]').trigger('click')
    await flushPromises()
    expect(patches).toEqual([{ recordProjects: { thesis: false } }])
    expect(checked(wrapper)).toEqual([['thesis', 'false'], ['job-hunt', 'false'], ['novel', 'true']])
    wrapper.unmount()
  })

  it('keeps the saved settings and says why when a change is refused', async () => {
    const { wrapper } = mountSettings({ enabled: true },
      async () => Response.json({ error: 'Capture policy unregisteredDirectories must be one of capture, skip' }, { status: 400 }))
    await flushPromises()
    await wrapper.get('[data-capture-unregistered] [role="switch"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-capture-unregistered] [role="switch"]').attributes('aria-checked')).toBe('true')
    expect(wrapper.get('[data-capture-message]').attributes('role')).toBe('alert')
    expect(wrapper.get('[data-capture-message]').text()).toContain('must be one of capture, skip')
    wrapper.unmount()
  })
})
