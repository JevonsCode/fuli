import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
import { nextTick } from 'vue'
import { useConsoleStore } from '@/stores/console'
import { t } from '@/i18n'
import AgentsDirectoryPage from './AgentsDirectoryPage.vue'

const { getJson, putJson } = vi.hoisted(() => ({ getJson: vi.fn(), putJson: vi.fn() }))
vi.mock('@/api/client', () => ({ getJson, putJson, postJson: vi.fn(), patchJson: vi.fn() }))
const mounted: Array<{ unmount: () => void }> = []
const roster = ['Aster', 'Birch'].map((name, index) => ({
  agentId: `agent-${index}`, personalSpaceId: 'space-a',
  employeeNumber: `00000${index + 1}`,
  profile: { name, responsibility: 'Synthetic review role', capabilities: ['review'], initialPreferences: [], status: 'active' },
}))
beforeEach(() => {
  setActivePinia(createPinia())
  const store = useConsoleStore()
  store.state = { mode: 'connected', activePersonalSpaceId: 'space-a', personalSpaces: [{ id: 'space-a', name: 'Synthetic space' }], personalProjects: [], projects: [], subscriptions: [] }
  store.runtimeStatus = 'ready'
  getJson.mockReset()
  getJson.mockImplementation(async (url: string) => {
    if (url === '/api/project-agents?personalSpaceId=space-a') return roster
    if (url === '/api/project-agent-tasks?personalSpaceId=space-a&limit=200') return []
    if (url === '/api/agent-pins?personalSpaceId=space-a') return { revision: 1, agentIds: ['agent-0'] }
    throw new Error(`Unexpected detail request: ${url}`)
  })
  putJson.mockReset()
  putJson.mockResolvedValue({ revision: 2, agentIds: [] })
})
afterEach(() => mounted.splice(0).forEach(wrapper => wrapper.unmount()))
async function setup(path = '/project-agents') {
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/project-agents', component: AgentsDirectoryPage },
    { path: '/agents/:spaceId/:agentId', component: { template: '<div>Profile destination</div>' } },
    { path: '/employees/bole', component: { template: '<div />' } },
    { path: '/personal/:spaceId/projects/directory', component: { template: '<div>Project destination</div>' } },
  ] })
  await router.push(path)
  const wrapper = mount(RouterView, { global: { plugins: [router] } })
  mounted.push(wrapper)
  await flushPromises()
  return { router, wrapper }
}
describe('Agent directory integration', () => {
  it('finds an Agent by its employee number', async () => {
    const { wrapper } = await setup('/project-agents?q=000002')
    expect(wrapper.findAll('.agent-directory-name a').map(link => link.text())).toEqual(['Birch'])
    expect(wrapper.get('.fla-employee-number').text()).toBe('FLA 000002')
  })
  it('explains how to start the first task at the main directory entry', async () => {
    const { wrapper } = await setup()
    expect(wrapper.get('.project-agent-first-task').text()).toContain('开始第一个任务')
  })

  it('renders membership state and a compact project summary on each card', async () => {
    const store = useConsoleStore()
    store.state!.personalProjects = ['project-a', 'project-b', 'project-c'].map((id) => ({
      project_id: id,
      personal_space_id: 'space-a',
      profile: { name: `Synthetic ${id}` },
    }))
    const assignments = ['project-a', 'project-b', 'project-c'].map((personalProjectId) => ({
      assignmentId: `assignment-${personalProjectId}`,
      personalSpaceId: 'space-a',
      personalProjectId,
      agentId: 'agent-0',
      responsibility: 'Synthetic review role',
      status: 'active' as const,
      assignedAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-01T00:00:00Z',
    }))
    getJson.mockResolvedValue([{ ...roster[0], profile: { ...roster[0]!.profile, status: 'inactive' }, assignments }])
    const { wrapper } = await setup()
    expect(wrapper.get('.agent-card-status').classes()).toContain('is-inactive')
    expect(wrapper.findAll('.agent-card-project-list .ui-badge')).toHaveLength(3)
    expect(wrapper.get('.agent-card-project-count').text()).toBe('+1')
  })

  it('loads only the roster and sends each name to its own profile', async () => {
    const { router, wrapper } = await setup()
    const links = wrapper.findAll('.agent-directory-name a')
    expect(links.map(link => [link.text(), link.attributes('href')])).toEqual([
      ['Aster', '/agents/space-a/agent-0'], ['Birch', '/agents/space-a/agent-1'],
    ])
    expect(getJson.mock.calls).toEqual(expect.arrayContaining([
      ['/api/project-agents?personalSpaceId=space-a'],
      ['/api/project-agent-tasks?personalSpaceId=space-a&limit=200'],
    ]))
    await links[0]!.trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/agents/space-a/agent-0')
    await router.push('/project-agents')
    await flushPromises()
    await wrapper.findAll('.agent-directory-name a')[1]!.trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/agents/space-a/agent-1')
    expect(getJson.mock.calls.every(([url]) => [
      '/api/project-agents?personalSpaceId=space-a',
      '/api/project-agent-tasks?personalSpaceId=space-a&limit=200',
      '/api/agent-pins?personalSpaceId=space-a',
    ].includes(url) || String(url).startsWith('/api/employee-templates'))).toBe(true)
  })

  it('toggles a card pin without changing the profile route', async () => {
    const { router, wrapper } = await setup()
    const toggle = wrapper.findAll('[data-agent-pin-toggle]')[0]!

    expect(toggle.attributes('aria-pressed')).toBe('true')
    await toggle.trigger('click')
    await flushPromises()

    expect(putJson).toHaveBeenCalledWith('/api/agent-pins', {
      personalSpaceId: 'space-a',
      agentId: 'agent-0',
      pinned: false,
      expectedRevision: 1,
    })
    expect(router.currentRoute.value.path).toBe('/project-agents')
    expect(wrapper.findAll('[data-agent-pin-toggle]')[0]!.attributes('aria-pressed')).toBe('false')
  })

  it('separates membership state from a reported active work state', async () => {
    getJson.mockImplementation(async (url: string) => {
      if (url === '/api/project-agents?personalSpaceId=space-a') {
        return [{ ...roster[0], profile: { ...roster[0]!.profile, status: 'inactive' } }]
      }
      if (url === '/api/project-agent-tasks?personalSpaceId=space-a&limit=200') {
        return [{
          taskId: 'task-running', personalSpaceId: 'space-a', title: 'Synthetic active task', status: 'running',
          participants: [{ agentId: 'agent-0', status: 'running' }],
        }]
      }
      throw new Error(`Unexpected detail request: ${url}`)
    })
    const { wrapper } = await setup()
    expect(wrapper.find('[data-membership-status="inactive"]').exists()).toBe(true)
    expect(wrapper.find('[data-work-status="running"]').exists()).toBe(true)
    expect(wrapper.get('[data-work-status="running"]').text()).toBe(t('agentRedesign.workStatus.running'))
  })

  it('lists active work first from the roster projection and keeps that order while reading', async () => {
    let birch = 'running'
    getJson.mockImplementation(async (url: string) => {
      if (url === '/api/project-agents?personalSpaceId=space-a') {
        return [
          { ...roster[0], workStatus: birch === 'running' ? 'idle' : 'running', currentTaskId: birch === 'running' ? null : 'task-a' },
          { ...roster[1], workStatus: birch, currentTaskId: birch === 'running' ? 'task-b' : null },
        ]
      }
      if (url === '/api/project-agent-tasks?personalSpaceId=space-a&limit=200') {
        return [{
          taskId: 'task-b', personalSpaceId: 'space-a', title: 'Synthetic review task', status: 'running',
          createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-17T01:00:00Z',
          participants: [{ agentId: 'agent-1', role: 'lead', status: 'running', updatedAt: '2026-10-17T02:00:00Z' }],
        }]
      }
      if (url === '/api/agent-pins?personalSpaceId=space-a') return { revision: 1, agentIds: [] }
      throw new Error(`Unexpected detail request: ${url}`)
    })
    const { wrapper } = await setup()
    const names = () => wrapper.findAll('.agent-directory-name a').map(link => link.text())
    expect(names()).toEqual(['Birch', 'Aster'])
    const current = wrapper.get('[data-current-task]')
    expect(current.text()).toContain('Synthetic review task')
    // No recorded run start: say unknown rather than turn the update time into a duration.
    expect(current.find('[data-last-update]').exists()).toBe(false)
    expect(current.get('[data-running-since]').text()).toBe(t('agentRedesign.workbench.runningForUnknown'))
    expect(wrapper.findAll('[data-current-task]')).toHaveLength(1)
    expect(wrapper.find('[data-workbench-reorder]').exists()).toBe(false)

    birch = 'idle'
    await (wrapper.getComponent(AgentsDirectoryPage).vm as unknown as { retryDirectory: () => Promise<void> }).retryDirectory()
    await flushPromises()
    expect(names()).toEqual(['Birch', 'Aster'])
    expect(wrapper.get('[data-work-status="running"]').element.closest('.agent-card')!.textContent).toContain('Aster')

    await wrapper.get('[data-workbench-reorder]').trigger('click')
    expect(names()).toEqual(['Aster', 'Birch'])
    expect(wrapper.find('[data-workbench-reorder]').exists()).toBe(false)
  })

  it('shows running time from the recorded run start, not the last update', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-17T03:00:00Z'))
    try {
      getJson.mockImplementation(async (url: string) => {
        if (url === '/api/project-agents?personalSpaceId=space-a') {
          return [{ ...roster[0], workStatus: 'running', currentTaskId: 'task-a', currentTaskRunningSince: '2026-10-17T02:35:00Z' }]
        }
        if (url === '/api/project-agent-tasks?personalSpaceId=space-a&limit=200') {
          return [{
            taskId: 'task-a', personalSpaceId: 'space-a', title: 'Synthetic run', status: 'running',
            createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-17T02:59:00Z',
            participants: [{ agentId: 'agent-0', role: 'lead', status: 'running', updatedAt: '2026-10-17T02:59:00Z' }],
          }]
        }
        if (url === '/api/agent-pins?personalSpaceId=space-a') return { revision: 1, agentIds: [] }
        throw new Error(`Unexpected detail request: ${url}`)
      })
      const { wrapper } = await setup()
      const running = wrapper.get('[data-running-since]')
      expect(running.attributes('title')).toBe('2026-10-17T02:35:00Z')
      expect(running.text()).toContain('25')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not turn an unavailable work summary into an idle state', async () => {
    getJson.mockImplementation(async (url: string) => {
      if (url === '/api/project-agents?personalSpaceId=space-a') return roster
      if (url === '/api/project-agent-tasks?personalSpaceId=space-a&limit=200') {
        throw new Error('Task summary unavailable')
      }
      throw new Error(`Unexpected detail request: ${url}`)
    })
    const { wrapper } = await setup()
    expect(wrapper.find('[data-work-status="unavailable"]').exists()).toBe(true)
    expect(wrapper.find('[data-work-status="none"]').exists()).toBe(false)
  })

  it('keeps a full task page explicitly unreported instead of calling it idle', async () => {
    getJson.mockImplementation(async (url: string) => {
      if (url === '/api/project-agents?personalSpaceId=space-a') return roster
      if (url === '/api/project-agent-tasks?personalSpaceId=space-a&limit=200') {
        return {
          tasks: Array.from({ length: 200 }, (_, index) => ({
            taskId: `completed-${index}`,
            personalSpaceId: 'space-a',
            title: `Completed ${index}`,
            status: 'completed',
            participants: [{ agentId: 'agent-0', status: 'completed' }],
          })),
        }
      }
      throw new Error(`Unexpected detail request: ${url}`)
    })
    const { wrapper } = await setup()
    expect(wrapper.find('[data-work-status="unreported"]').exists()).toBe(true)
    expect(wrapper.find('[data-work-status="none"]').exists()).toBe(false)
  })

  it('keeps the last reported work state visible when a refresh fails', async () => {
    getJson.mockImplementation(async (url: string) => {
      if (url === '/api/project-agents?personalSpaceId=space-a') return roster
      if (url === '/api/project-agent-tasks?personalSpaceId=space-a&limit=200') {
        return [{
          taskId: 'task-running', personalSpaceId: 'space-a', title: 'Synthetic active task', status: 'running',
          participants: [{ agentId: 'agent-0', status: 'running' }],
        }]
      }
      throw new Error(`Unexpected detail request: ${url}`)
    })
    const { wrapper } = await setup()
    getJson.mockImplementation(async (url: string) => {
      if (url === '/api/project-agent-tasks?personalSpaceId=space-a&limit=200') throw new Error('Task summary unavailable')
      if (url === '/api/project-agents?personalSpaceId=space-a') return roster
      throw new Error(`Unexpected detail request: ${url}`)
    })
    const page = wrapper.getComponent(AgentsDirectoryPage)
    await (page.vm as unknown as { loadWorkSummary: () => Promise<void> }).loadWorkSummary()
    await flushPromises()
    expect(wrapper.findAll('.agent-card')[0]!.find('[data-work-status="running"]').exists()).toBe(true)
    expect(wrapper.findAll('.agent-card')[0]!.find('[data-work-status="unavailable"]').exists()).toBe(false)
    expect(wrapper.find('.agent-directory-work-error').exists()).toBe(true)

    getJson.mockImplementation(async (url: string) => {
      if (url === '/api/project-agent-tasks?personalSpaceId=space-a&limit=200') return []
      if (url === '/api/project-agents?personalSpaceId=space-a') return roster
      throw new Error(`Unexpected detail request: ${url}`)
    })
    await wrapper.get('.agent-directory-work-error button').trigger('click')
    await flushPromises()
    expect(wrapper.find('.agent-directory-work-error').exists()).toBe(false)
    expect(wrapper.find('[data-work-status="none"]').exists()).toBe(true)
  })

  it('keeps a loaded grid in place while refresh feedback stays inline', async () => {
    const { wrapper } = await setup()
    useConsoleStore().runtimeStatus = 'loading'
    await nextTick()
    expect(wrapper.get('.agents-directory-heading .growth-loading').classes()).toContain('growth-loading--inline')
    expect(wrapper.find('.agents-directory > .growth-loading--compact').exists()).toBe(false)
    expect(wrapper.findAll('.agent-card')).toHaveLength(2)
  })

  it('preserves URL search and project filters during the initial space load', async () => {
    const store = useConsoleStore()
    const readyState = store.state!
    readyState.personalProjects = [{ project_id: 'project-a', personal_space_id: 'space-a', profile: { name: 'Synthetic project' } }]
    store.state = null; store.runtimeStatus = 'loading'
    getJson.mockImplementation(async (url: string) => {
      if (url === '/api/project-agents?personalSpaceId=space-a') return roster.map(item => ({ ...item, personalProjectId: 'project-a' }))
      throw new Error(`Unexpected request: ${url}`)
    })
    const { wrapper } = await setup('/project-agents?q=aster&project=project-a')
    expect(wrapper.find('.project-agent-first-task').exists()).toBe(false)
    store.state = readyState; store.runtimeStatus = 'ready'
    await flushPromises()
    expect((wrapper.get('input[type="search"]').element as HTMLInputElement).value).toBe('aster')
    expect(wrapper.findAll('.agent-directory-name a').map(link => link.text())).toEqual(['Aster'])
    expect(wrapper.find('.project-agent-first-task').exists()).toBe(false)
  })

  it('keeps filters in the URL and returns to the same filters and scroll position', async () => {
    const store = useConsoleStore()
    store.state!.personalProjects = ['project-a', 'project-b'].map((id) => ({
      project_id: id, personal_space_id: 'space-a', profile: { name: `Synthetic ${id}` },
    }))
    const { router, wrapper } = await setup('/project-agents?project=project-a&project=project-b&status=inactive&q=as')
    expect((wrapper.get('input[type="search"]').element as HTMLInputElement).value).toBe('as')

    await wrapper.get('input[type="search"]').setValue('aster')
    await new Promise((resolve) => setTimeout(resolve, 300))
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({ project: ['project-a', 'project-b'], status: 'inactive', q: 'aster' })

    await wrapper.get('input[type="search"]').setValue('')
    await new Promise((resolve) => setTimeout(resolve, 300))
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({ project: ['project-a', 'project-b'], status: 'inactive' })
  })

  it('groups Agents by project and reads a lead only for an opened project', async () => {
    const store = useConsoleStore()
    store.state!.personalProjects = ['project-a', 'project-b'].map((id) => ({
      project_id: id, personal_space_id: 'space-a', profile: { name: `Synthetic ${id}` },
    }))
    getJson.mockImplementation(async (url: string) => {
      if (url === '/api/project-agents?personalSpaceId=space-a') {
        return [
          { ...roster[0], personalProjectId: 'project-b', workStatus: 'running', currentTaskId: 'task-a' },
          { ...roster[1], personalProjectId: 'project-a' },
        ]
      }
      if (url === '/api/project-agent-tasks?personalSpaceId=space-a&limit=200') return []
      if (url === '/api/agent-pins?personalSpaceId=space-a') return { revision: 1, agentIds: [] }
      if (url === '/api/project-team?personalSpaceId=space-a&personalProjectId=project-b') {
        return { personalProjectId: 'project-b', status: 'ready', lead: { agentId: 'agent-0', name: 'Aster', employeeNumber: '000001', occupationEmoji: null, responsibility: '', peerRole: false }, unavailableLead: null, members: [], collaborators: [], peers: [], unavailableMemberIds: [] }
      }
      throw new Error(`Unexpected detail request: ${url}`)
    })
    const { router, wrapper } = await setup()
    await wrapper.findAll('[data-directory-view] button')[1]!.trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({ view: 'projects' })
    const groups = () => wrapper.findAll('[data-directory-project]')
    expect(groups().map((group) => group.attributes('data-directory-project'))).toEqual(['project-a', 'project-b'])
    expect(groups()[1]!.text()).toContain(t('agentRedesign.projectView.running', { count: 1 }))
    expect(wrapper.findAll('.agent-card')).toHaveLength(0)
    expect(getJson.mock.calls.some(([url]) => String(url).startsWith('/api/project-team'))).toBe(false)

    await groups()[1]!.get('.directory-project-toggle').trigger('click')
    await flushPromises()
    expect(groups()[1]!.findAll('.agent-directory-name a').map(link => link.text())).toEqual(['Aster'])
    expect(groups()[1]!.get('[data-project-lead]').text()).toContain('Aster')
    expect(getJson.mock.calls.filter(([url]) => String(url).startsWith('/api/project-team'))).toHaveLength(1)
    expect(groups()[0]!.find('.agent-card').exists()).toBe(false)
  })

  it('updates filters when query navigation reuses the directory', async () => {
    const { router, wrapper } = await setup('/project-agents?q=aster')
    await router.push('/project-agents?q=birch&status=active&project=project-a')
    await flushPromises()
    expect((wrapper.get('input[type="search"]').element as HTMLInputElement).value).toBe('birch')
    await router.push('/project-agents')
    await flushPromises()
    expect((wrapper.get('input[type="search"]').element as HTMLInputElement).value).toBe('')
    expect(wrapper.findAll('.agent-directory-name a')).toHaveLength(2)
    router.back()
    await flushPromises()
    expect((wrapper.get('input[type="search"]').element as HTMLInputElement).value).toBe('birch')
    expect(wrapper.findAll('.agent-directory-name a')).toHaveLength(0)
  })

  it('keeps the latest filter when leaving before the old debounce interval', async () => {
    const { router, wrapper } = await setup()
    await wrapper.get('input[type="search"]').setValue('aster')
    // Separate browser input and click events drain navigation microtasks,
    // without waiting for the former 250ms debounce timer.
    await flushPromises()
    await wrapper.get('.agent-directory-name a').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/agents/space-a/agent-0')
    router.back()
    await flushPromises()
    expect(router.currentRoute.value.query.q).toBe('aster')
    expect((wrapper.get('input[type="search"]').element as HTMLInputElement).value).toBe('aster')
  })

  it('restores the directory scroll position when coming back from a profile', async () => {
    const { router, wrapper } = await setup()
    const scroller = () => wrapper.get('.agents-directory').element as HTMLElement
    scroller().scrollTop = 840
    await wrapper.findAll('.agent-directory-name a')[1]!.trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/agents/space-a/agent-1')

    router.back()
    await flushPromises()
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/project-agents')
    expect(scroller().scrollTop).toBe(840)

    // The latest position wins on the next return.
    scroller().scrollTop = 120
    await router.push('/agents/space-a/agent-0')
    await router.push('/project-agents')
    await flushPromises()
    expect(scroller().scrollTop).toBe(120)
  })

  it('redirects a legacy agent query while preserving the remaining query', async () => {
    const { router } = await setup('/project-agents?agent=agent-1&project=project-a')
    expect(router.currentRoute.value.path).toBe('/agents/space-a/agent-1')
    expect(router.currentRoute.value.query).toEqual({ project: 'project-a' })
  })
})
