import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
import { nextTick } from 'vue'
import { useConsoleStore } from '@/stores/console'
import type { ProjectAgentRecord } from '@/types'
import AgentProfilePage from './AgentProfilePage.vue'

const { getJson, postJson, putJson } = vi.hoisted(() => ({ getJson: vi.fn(), postJson: vi.fn(), putJson: vi.fn() }))
vi.mock('@/api/client', () => ({ getJson, postJson, putJson, patchJson: vi.fn() }))
const mounted: Array<{ unmount: () => void }> = []
const person = (id: string): ProjectAgentRecord => ({ agentId: id, personalSpaceId: 'space-a',
  createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
  profile: { name: id === 'alpha' ? 'Aster' : id === 'beta' ? 'Birch' : 'Cedar', responsibility: `Synthetic ${id} role`, capabilities: ['review'], initialPreferences: [], status: 'active' },
})
const assignment = (agentId: string, status = 'active', projectId = 'project-a') => ({
  assignmentId: `${agentId}-${projectId}`, personalSpaceId: 'space-a', personalProjectId: projectId,
  agentId, responsibility: 'Recorded assignment responsibility', status,
})
const task = (id: string, agentId: string, title: string, status = 'completed') => ({
  taskId: id, personalSpaceId: 'space-a', personalProjectId: 'project-a', title, status,
  resultSummary: 'Recorded test evidence.', updatedAt: '2026-09-01T00:00:00Z',
  participants: [{ agentId, status }, { agentId: 'beta', status }],
})
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
beforeEach(() => {
  setActivePinia(createPinia())
  const store = useConsoleStore()
  store.state = { mode: 'connected', activePersonalSpaceId: 'space-a', personalSpaces: [{ id: 'space-a', name: 'Synthetic space' }],
    personalProjects: ['project-a', 'project-old'].map(id => ({ project_id: id, personal_space_id: 'space-a', profile: { name: id === 'project-a' ? 'Synthetic active project' : 'Synthetic previous project' } })), projects: [], subscriptions: [] }
  store.runtimeStatus = 'ready'
  getJson.mockReset(); postJson.mockReset(); putJson.mockReset()
  getJson.mockImplementation(async (url: string) => {
    const parsed = new URL(url, 'http://fixture')
    const id = parsed.searchParams.get('agentId') ?? 'alpha'
    if (parsed.pathname === '/api/project-agents') return [person('alpha'), person('beta'), person('gamma')]
    if (parsed.pathname === '/api/project-agent-assignments') return [assignment(id), assignment(id, 'ended', 'project-old')]
    if (parsed.pathname === '/api/project-agent-tasks') return [task('done', id, 'Completed evidence'), task('queued', id, 'Only scheduled', 'queued')]
    if (parsed.pathname === '/api/project-agent-coordination-policy') return { teamLeadAgentId: 'beta', teamMemberAgentIds: ['alpha', 'beta', 'gamma'], personalSpaceId: 'space-a', personalProjectId: 'project-a' }
    if (parsed.pathname === '/api/executors') return []
    throw new Error(`Unexpected request: ${url}`)
  })
  putJson.mockImplementation(async (_url: string, payload: { profile: ProjectAgentRecord['profile'] }) => ({ ...person('alpha'), profile: payload.profile }))
  postJson.mockImplementation(async (_url: string, payload: { mode: string }) => payload.mode === 'list' ? { conversations: [] } : { events: [] })
})
afterEach(() => mounted.splice(0).forEach(wrapper => wrapper.unmount()))
async function setup(path = '/agents/space-a/alpha') {
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/agents/:spaceId/:agentId', component: AgentProfilePage },
    { path: '/:pathMatch(.*)*', component: { template: '<div />' } },
  ] })
  await router.push(path)
  const wrapper = mount(RouterView, { attachTo: document.body, global: { plugins: [router] } })
  mounted.push(wrapper); await flushPromises()
  return { router, wrapper }
}
describe('Agent profile integration', () => {
  it('exposes conversation retention under an accessible secondary tab', async () => {
    const normal = getJson.getMockImplementation()!
    getJson.mockImplementation((url: string) => {
      if (url.startsWith('/api/project-agents?')) return Promise.resolve([{ ...person('alpha'), memoryScope: 'reviewed_agent' }, person('beta'), person('gamma')])
      return normal(url)
    })
    const { wrapper } = await setup()
    const tab = wrapper.get('[role="tab"][aria-controls="agent-panel-conversations"]')
    expect(tab.attributes('aria-selected')).toBe('false')
    await tab.trigger('click')
    expect(wrapper.get('[role="tabpanel"][id="agent-panel-conversations"]').attributes('aria-hidden')).toBe('false')
    expect(wrapper.find('.agent-conversations').exists()).toBe(true)
    const details = wrapper.get('.agent-conversations')
    ;(details.element as HTMLDetailsElement).open = true
    await details.trigger('toggle')
    await flushPromises()
    expect(postJson).toHaveBeenCalledWith('/api/agent-conversations/query', { personalSpaceId: 'space-a', personalProjectId: 'project-a', agentId: 'alpha', mode: 'list', limit: 20 })
  })

  it('supports roving keyboard navigation for profile tabs', async () => {
    const normal = getJson.getMockImplementation()!
    getJson.mockImplementation((url: string) => {
      if (url.startsWith('/api/project-agents?')) {
        return Promise.resolve([{ ...person('alpha'), memoryScope: 'reviewed_agent' }, person('beta'), person('gamma')])
      }
      return normal(url)
    })
    const { wrapper } = await setup()
    const tabs = () => wrapper.findAll('[role="tab"]')
    expect(tabs().map((tab) => tab.attributes('tabindex'))).toEqual(['0', '-1', '-1', '-1', '-1', '-1',])

    const first = tabs()[0]!
    ;(first.element as HTMLButtonElement).focus()
    await first.trigger('keydown', { key: 'ArrowRight' })
    await nextTick()
    expect(wrapper.get('[role="tab"][aria-selected="true"]').attributes('id')).toBe('agent-tab-history')
    expect(document.activeElement).toBe(wrapper.get('#agent-tab-history').element)

    const scrollIntoView = vi.fn()
    Object.defineProperty(wrapper.get('#agent-tab-management').element, 'scrollIntoView', { configurable: true, value: scrollIntoView })
    await wrapper.get('#agent-tab-history').trigger('keydown', { key: 'End' })
    await nextTick()
    expect(wrapper.get('[role="tab"][aria-selected="true"]').attributes('id')).toBe('agent-tab-management')
    expect(document.activeElement).toBe(wrapper.get('#agent-tab-management').element)
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' })

    await wrapper.get('#agent-tab-management').trigger('keydown', { key: 'Home' })
    await nextTick()
    expect(wrapper.get('[role="tab"][aria-selected="true"]').attributes('id')).toBe('agent-tab-overview')
    expect(document.activeElement).toBe(wrapper.get('#agent-tab-overview').element)
  })

  it('puts current work first and keeps a long project list compact', async () => {
    const store = useConsoleStore()
    const projectIds = ['project-a', 'project-b', 'project-c', 'project-d', 'project-e', 'project-f', 'project-g']
    store.state!.personalProjects = projectIds.map((id) => ({
      project_id: id,
      personal_space_id: 'space-a',
      profile: { name: `Synthetic ${id}` },
    }))
    const normal = getJson.getMockImplementation()!
    getJson.mockImplementation((url: string) => {
      if (url.startsWith('/api/project-agent-assignments?')) {
        return Promise.resolve(projectIds.map((personalProjectId) => ({
          ...assignment('alpha', 'active', personalProjectId),
          responsibility: 'Synthetic alpha role',
        })))
      }
      if (url.startsWith('/api/project-agent-tasks?')) {
        return Promise.resolve([task('active', 'alpha', 'Current evidence', 'running')])
      }
      return normal(url)
    })

    const { wrapper } = await setup()
    const overview = wrapper.get('#agent-panel-overview')
    expect(overview.findAll('.agent-resume-section').map((section) => section.classes())).toEqual([
      expect.arrayContaining(['agent-current-work-section']),
      expect.arrayContaining(['agent-projects-section']),
    ])
    expect(overview.findAll('.agent-current-project-list > .agent-project-item')).toHaveLength(4)
    expect(overview.find('.agent-project-overflow').exists()).toBe(true)
    expect(overview.findAll('.agent-project-overflow .agent-project-item')).toHaveLength(3)
    expect(overview.findAll('.agent-project-link').map((link) => link.attributes('href'))[0]).toBe('/personal/space-a/projects/project-a/graph')
    expect(overview.findAll('.agent-project-responsibility')).toHaveLength(0)
  })

  it('uses recorded assignments, team policy and actual shared work for its resume', async () => {
    const { wrapper } = await setup()
    expect(wrapper.get('h1').text()).toBe('Aster')
    expect(wrapper.text()).toContain('Synthetic active project')
    expect(wrapper.text()).toContain('Synthetic previous project')
    expect(wrapper.get('.agent-org-lead a').text()).toBe('Birch')
    expect(wrapper.get('.agent-org-lead').text()).toContain('项目总负责人')
    expect(wrapper.get('.agent-org-reporting').text()).toContain('成员 → 项目总负责人 → 你')
    expect(wrapper.get('.agent-org-lead a').attributes('href')).toBe('/agents/space-a/beta')
    expect(wrapper.findAll('.agent-org-members a').map(link => link.text())).toEqual(['Aster', 'Cedar'])
    expect(wrapper.findAll('.agent-collaborators a').map(link => link.text())).toEqual(['Birch'])
    expect(wrapper.get('.agent-collaborators').text()).toContain('1')
    expect(wrapper.get('.agent-work-timeline').text()).toContain('Completed evidence')
    const params = getJson.mock.calls.filter(([url]) => url.startsWith('/api/project-agent-tasks?')).map(([url]) => new URL(url, 'http://fixture').searchParams)
    expect(params).toHaveLength(1)
    expect(params[0]!.get('personalSpaceId')).toBe('space-a')
    expect(params[0]!.get('agentId')).toBeNull()
    expect(params[0]!.get('limit')).toBe('200')
  })

  it('includes owner-only work and marks a full task page as partial', async () => {
    const normal = getJson.getMockImplementation()!
    getJson.mockImplementation((url: string) => {
      if (url.startsWith('/api/project-agent-tasks?')) {
        return Promise.resolve({
          tasks: [
            task('foreign', 'beta', 'Foreign task', 'running'),
            ...Array.from({ length: 199 }, (_, index) => ({
              ...task(`owner-${index}`, 'alpha', `Owner task ${index}`, 'running'),
              ownerAgentId: 'alpha',
              participants: [],
            })),
          ],
        })
      }
      return normal(url)
    })
    const { wrapper } = await setup()
    expect(wrapper.findAll('.agent-current-work-list a')).toHaveLength(6)
    expect(wrapper.find('.agent-profile-partial').exists()).toBe(true)
    expect(wrapper.find('.agent-current-work-section .agent-current-work-list').exists()).toBe(true)
    expect(wrapper.get('.agent-current-work-section').text()).not.toContain('Foreign task')
  })

  it.each(['/agents/space-a/missing', '/agents/space-b/alpha'])('does not show a profile for %s', async path => {
    const { wrapper } = await setup(path)
    expect(wrapper.find('h1').exists()).toBe(false)
    expect(wrapper.find('.agent-resume-header').exists()).toBe(false)
    expect(getJson.mock.calls).toEqual([['/api/project-agents?personalSpaceId=space-a']])
  })

  it('rejects a foreign-space identity even if returned in a roster response', async () => {
    getJson.mockResolvedValue([{ ...person('alpha'), personalSpaceId: 'space-b' }])
    const { wrapper } = await setup()
    expect(wrapper.find('.agent-resume-header').exists()).toBe(false)
    expect(getJson.mock.calls).toHaveLength(1)
  })

  it('ignores late detail responses after navigating to another Agent', async () => {
    const late = deferred<unknown>()
    const normal = getJson.getMockImplementation()!
    let taskCalls = 0
    getJson.mockImplementation((url: string) => url.startsWith('/api/project-agent-tasks?') && taskCalls++ === 0 ? late.promise : normal(url))
    const { router, wrapper } = await setup()
    await router.push('/agents/space-a/beta'); await flushPromises()
    expect(wrapper.get('h1').text()).toBe('Birch')
    late.resolve([task('late', 'alpha', 'Stale Aster result')]); await flushPromises()
    expect(wrapper.get('h1').text()).toBe('Birch')
    expect(wrapper.text()).not.toContain('Stale Aster result')
    expect(wrapper.get('.agent-work-timeline').text()).toContain('Completed evidence')
  })

  it('does not restore an old team when its policy arrives after navigation', async () => {
    const late = deferred<unknown>()
    const normal = getJson.getMockImplementation()!
    let policyCalls = 0
    getJson.mockImplementation((url: string) => {
      if (url.startsWith('/api/project-agent-coordination-policy?') && ++policyCalls === 1) return late.promise
      return normal(url)
    })
    const { router, wrapper } = await setup()
    await router.push('/agents/space-a/beta'); await flushPromises()
    late.resolve({ teamLeadAgentId: 'stale-team-lead', teamMemberAgentIds: [] }); await flushPromises()
    expect(wrapper.get('h1').text()).toBe('Birch')
    expect(wrapper.get('.agent-org-lead a').text()).toBe('Birch')
    expect(wrapper.text()).not.toContain('stale-team-lead')
  })

  it('retains legacy project membership when assignment details are unavailable', async () => {
    const normal = getJson.getMockImplementation()!
    getJson.mockImplementation((url: string) => {
      if (url.startsWith('/api/project-agents?')) return Promise.resolve([{ ...person('alpha'), personalProjectId: 'project-a' }])
      if (url.startsWith('/api/project-agent-assignments?')) return Promise.reject(new Error('Temporary failure'))
      return normal(url)
    })
    const { wrapper } = await setup()
    expect(wrapper.text()).toContain('Synthetic active project')
  })

  it('keeps settings expanded and shows saved values after saving the profile', async () => {
    const { wrapper } = await setup()
    await wrapper.get('.agent-profile-actions button').trigger('click'); await flushPromises()
    await wrapper.get('.agent-simple-settings textarea').setValue('Explain verification evidence.')
    await wrapper.get('.agent-simple-settings').trigger('submit'); await flushPromises()
    expect(putJson).toHaveBeenCalledTimes(1)
    expect(wrapper.find('.agent-simple-settings').exists()).toBe(true)
    expect(wrapper.get('.agent-profile-actions button').attributes('aria-expanded')).toBe('true')
    expect(wrapper.get('.agent-expectation').text()).toContain('Explain verification evidence.')
  })
})
