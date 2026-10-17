import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
import { nextTick } from 'vue'
import { useConsoleStore } from '@/stores/console'
import { t } from '@/i18n'
import { forgetLoadedRosters } from '@/features/agent-profile/useAgentRosterPages'
import AgentsDirectoryPage from './AgentsDirectoryPage.vue'

const { getJson, putJson, postJson } = vi.hoisted(() => ({ getJson: vi.fn(), putJson: vi.fn(), postJson: vi.fn() }))
vi.mock('@/api/client', () => ({ getJson, putJson, postJson, patchJson: vi.fn() }))
const mounted: Array<{ unmount: () => void }> = []
const roster = ['Aster', 'Birch'].map((name, index) => ({
  agentId: `agent-${index}`, personalSpaceId: 'space-a',
  employeeNumber: `00000${index + 1}`,
  profile: { name, responsibility: 'Synthetic review role', capabilities: ['review'], initialPreferences: [], status: 'active' },
}))
// The directory reads Agents with open work first, then the whole roster.
const ROSTER_OPEN = '/api/project-agent-pages?personalSpaceId=space-a&limit=50&work=open'
const ROSTER_ALL = '/api/project-agent-pages?personalSpaceId=space-a&limit=50'
const isRosterPage = (url: string) => url.startsWith('/api/project-agent-pages?')
const rosterPage = (url: string, items: unknown[]) => ({
  items: url.includes('work=open') ? [] : items, nextCursor: null, complete: true,
})
beforeEach(() => {
  forgetLoadedRosters()
  setActivePinia(createPinia())
  const store = useConsoleStore()
  store.state = { mode: 'connected', activePersonalSpaceId: 'space-a', personalSpaces: [{ id: 'space-a', name: 'Synthetic space' }], personalProjects: [], projects: [], subscriptions: [] }
  store.runtimeStatus = 'ready'
  getJson.mockReset()
  getJson.mockImplementation(async (url: string) => {
    if (isRosterPage(url)) return rosterPage(url, roster)
    if (url === '/api/project-agent-tasks?personalSpaceId=space-a&limit=200') return []
    if (url === '/api/agent-pins?personalSpaceId=space-a') return { revision: 1, agentIds: ['agent-0'] }
    throw new Error(`Unexpected detail request: ${url}`)
  })
  putJson.mockReset()
  putJson.mockResolvedValue({ revision: 2, agentIds: [] })
  postJson.mockReset()
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
    getJson.mockImplementation(async (url: string) => {
      if (isRosterPage(url)) return rosterPage(url, [{ ...roster[0], profile: { ...roster[0]!.profile, status: 'inactive' }, assignments }])
      if (url === '/api/project-agent-tasks?personalSpaceId=space-a&limit=200') return []
      if (url === '/api/agent-pins?personalSpaceId=space-a') return { revision: 1, agentIds: [] }
      throw new Error(`Unexpected detail request: ${url}`)
    })
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
      [ROSTER_OPEN],
      [ROSTER_ALL],
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
      ROSTER_OPEN,
      ROSTER_ALL,
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
      if (isRosterPage(url)) {
        return rosterPage(url, [{ ...roster[0], profile: { ...roster[0]!.profile, status: 'inactive' } }])
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
      if (isRosterPage(url)) {
        return rosterPage(url, [
          { ...roster[0], workStatus: birch === 'running' ? 'idle' : 'running', currentTaskId: birch === 'running' ? null : 'task-a' },
          { ...roster[1], workStatus: birch, currentTaskId: birch === 'running' ? 'task-b' : null },
        ])
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

  it('explains a blocked Agent with the reason its task recorded', async () => {
    getJson.mockImplementation(async (url: string) => {
      if (isRosterPage(url)) return rosterPage(url, [{ ...roster[0], workStatus: 'blocked', currentTaskId: 'task-b' }])
      if (url === '/api/project-agent-tasks?personalSpaceId=space-a&limit=200') {
        return [{ taskId: 'task-b', personalSpaceId: 'space-a', title: 'Synthetic deploy', status: 'blocked',
          resultSummary: 'Waiting for a person to grant staging access.', updatedAt: '2026-10-17T01:00:00Z', participants: [] }]
      }
      if (url === '/api/agent-pins?personalSpaceId=space-a') return { revision: 1, agentIds: [] }
      throw new Error(`Unexpected detail request: ${url}`)
    })
    const { wrapper } = await setup()
    expect(wrapper.get('[data-status-detail]').text()).toBe('受阻：Waiting for a person to grant staging access.')
  })

  it('shows running time from the recorded run start, not the last update', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-17T03:00:00Z'))
    try {
      getJson.mockImplementation(async (url: string) => {
        if (isRosterPage(url)) {
          return rosterPage(url, [{ ...roster[0], workStatus: 'running', currentTaskId: 'task-a', currentTaskRunningSince: '2026-10-17T02:35:00Z' }])
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
      if (isRosterPage(url)) return rosterPage(url, roster)
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
      if (isRosterPage(url)) return rosterPage(url, roster)
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
      if (isRosterPage(url)) return rosterPage(url, roster)
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
      if (isRosterPage(url)) return rosterPage(url, roster)
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
      if (isRosterPage(url)) return rosterPage(url, roster)
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
      if (isRosterPage(url)) return rosterPage(url, roster.map(item => ({ ...item, personalProjectId: 'project-a' })))
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
      if (isRosterPage(url)) {
        return rosterPage(url, [
          { ...roster[0], personalProjectId: 'project-b', workStatus: 'running', currentTaskId: 'task-a' },
          { ...roster[1], personalProjectId: 'project-a' },
        ])
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

  it('says the roster is partial until the last page and retries a failed page in place', async () => {
    let failNext = true
    getJson.mockImplementation(async (url: string) => {
      if (url === ROSTER_OPEN) return { items: [], nextCursor: null, complete: true }
      if (url === ROSTER_ALL) return { items: [roster[0]], nextCursor: 'c1', complete: false }
      if (url === `${ROSTER_ALL}&cursor=c1`) {
        if (failNext) { failNext = false; throw new Error('Synthetic outage') }
        return { items: [roster[1]], nextCursor: null, complete: true }
      }
      if (url === '/api/project-agent-tasks?personalSpaceId=space-a&limit=200') return []
      if (url === '/api/agent-pins?personalSpaceId=space-a') return { revision: 1, agentIds: [] }
      throw new Error(`Unexpected detail request: ${url}`)
    })
    const { wrapper } = await setup('/project-agents?q=birch')

    expect(wrapper.get('.agents-directory-count').text()).toBe(t('agentProfiles.membersLoaded', { count: 1 }))
    expect(wrapper.get('.agents-directory-partial').text()).toBe(t('agentProfiles.partialFilter', { count: 1 }))
    // No match among loaded rows is not reported as "no match" while more remain.
    expect(wrapper.find('.agent-profile-empty').exists()).toBe(false)

    await wrapper.get('[data-roster-more]').trigger('click')
    await flushPromises()
    expect(wrapper.get('.agents-directory-more-error').text()).toContain('Synthetic outage')
    expect(wrapper.findAll('.agent-directory-name a')).toHaveLength(0)

    await wrapper.get('[data-roster-retry]').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('.agent-directory-name a').map(link => link.text())).toEqual(['Birch'])
    expect(wrapper.get('.agents-directory-count').text()).toBe(t('agentProfiles.members', { count: 2 }))
    expect(wrapper.find('.agents-directory-partial').exists()).toBe(false)
    expect(wrapper.find('.agents-directory-more').exists()).toBe(false)
  })

  it('redirects a legacy agent query while preserving the remaining query', async () => {
    const { router } = await setup('/project-agents?agent=agent-1&project=project-a')
    expect(router.currentRoute.value.path).toBe('/agents/space-a/agent-1')
    expect(router.currentRoute.value.query).toEqual({ project: 'project-a' })
  })

  it('shows only formal projects with purpose, lead, and member occupations in project view while surfacing unassigned conversations at the top', async () => {
    const store = useConsoleStore()
    store.state!.personalProjects = [
      {
        project_id: 'project-formal',
        personal_space_id: 'space-a',
        status: 'active',
        profile: { name: 'Formal Product', purpose: 'Ship clean v2 project agent pages', origin: 'manual' },
      },
      {
        project_id: `conversation-${'f'.repeat(64)}`,
        personal_space_id: 'space-a',
        status: 'active',
        profile: { name: 'Temp Conversation Project', origin: 'conversation_fallback' },
      },
      {
        project_id: 'project-archived',
        personal_space_id: 'space-a',
        status: 'archived',
        profile: { name: 'Archived Project' },
      },
    ]
    getJson.mockImplementation(async (url: string) => {
      if (isRosterPage(url)) {
        return rosterPage(url, [
          {
            ...roster[0],
            personalProjectId: 'project-formal',
            occupation: { role: 'lead', tags: [], updatedAt: '2026-10-18T00:00:00Z' },
            profile: { ...roster[0]!.profile, occupationEmoji: '🧭', responsibility: 'Coordinates project delivery' },
          },
          {
            ...roster[1],
            personalProjectId: 'project-formal',
            occupation: { role: 'engineering', tags: [], updatedAt: '2026-10-18T00:00:00Z' },
            profile: { ...roster[1]!.profile, occupationEmoji: '🛠️', responsibility: 'Builds frontend views' },
          },
          {
            agentId: 'employee.assistant',
            personalSpaceId: 'space-a',
            employeeNumber: '000099',
            personalProjectId: null,
            occupation: { role: 'assistant', tags: [], updatedAt: '2026-10-18T00:00:00Z' },
            profile: { name: 'Fuli Assistant', responsibility: 'Handles unassigned sessions', capabilities: [], initialPreferences: [], status: 'active' },
          },
        ])
      }
      if (url === '/api/project-agent-tasks?personalSpaceId=space-a&limit=200') return []
      if (url === '/api/agent-pins?personalSpaceId=space-a') return { revision: 1, agentIds: [] }
      throw new Error(`Unexpected detail request: ${url}`)
    })
    postJson.mockImplementation(async (url: string, body: Record<string, unknown>) => {
      if (url === '/api/agent-conversations/query') {
        expect(body).toMatchObject({
          personalSpaceId: 'space-a',
          personalProjectId: null,
          agentId: 'employee.assistant',
          mode: 'list',
        })
        return {
          conversations: [
            {
              conversationId: 'conv-unassigned-1',
              personalSpaceId: 'space-a',
              personalProjectId: null,
              agentId: 'employee.assistant',
              title: 'Quick CSS alignment fix',
              summary: 'Adjusted button padding',
              status: 'active',
              startedAt: '2026-10-18T01:00:00Z',
              endedAt: null,
              updatedAt: '2026-10-18T01:05:00Z',
              metadata: { openingLine: 'Please fix the button padding in header', jefaTriage: 'pending' },
            },
          ],
        }
      }
      if (url === '/api/conversation-triage/record') {
        return { triage: { kind: 'one_off', source: 'user' } }
      }
      throw new Error(`Unexpected POST request: ${url}`)
    })

    const { wrapper } = await setup('/project-agents?view=projects')
    const groups = wrapper.findAll('[data-directory-project]')
    expect(groups.map((group) => group.attributes('data-directory-project'))).toEqual(['project-formal'])
    expect(groups[0]!.get('[data-project-purpose]').text()).toBe('Ship clean v2 project agent pages')
    expect(groups[0]!.get('[data-project-header-lead]').text()).toContain('Aster')
    const occupations = groups[0]!.get('[data-project-member-occupations]').text()
    expect(occupations).toContain(t('agentRedesign.occupation.keys.lead'))
    expect(occupations).toContain(t('agentRedesign.occupation.keys.engineering'))

    const unassignedPanel = wrapper.get('[data-unassigned-conversations]')
    expect(unassignedPanel.text()).toContain(t('agentRedesign.unassigned.count', { count: 1 }))
    await unassignedPanel.get('[data-unassigned-toggle]').trigger('click')
    await flushPromises()

    const list = wrapper.get('[data-unassigned-list]')
    expect(list.text()).toContain('Please fix the button padding in header')
    expect(list.get('[data-unassigned-triage]').text()).toBe(t('agentRedesign.unassigned.triage.pending'))
    expect(list.find('[data-unassigned-move]').exists()).toBe(true)
    expect(list.find('[data-unassigned-create-project]').exists()).toBe(true)
    expect(list.find('[data-unassigned-one-off]').exists()).toBe(true)

    await list.get('[data-unassigned-one-off]').trigger('click')
    await flushPromises()
    expect(postJson).toHaveBeenCalledWith('/api/conversation-triage/record', {
      personalSpaceId: 'space-a',
      conversationId: 'conv-unassigned-1',
      kind: 'one_off',
      personalProjectId: null,
      topic: null,
      source: 'user',
    })
  })
})

