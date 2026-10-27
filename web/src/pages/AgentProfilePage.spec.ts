import { agentAvatarUrl } from '@/features/agent-profile/agent-avatar'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
import { useConsoleStore } from '@/stores/console'
import { employeeTemplates } from '@/features/employees/catalog'
import type { ProjectAgentRecord } from '@/types'
import { pageTitle } from '@/layouts/page-title'
import { SYNTHETIC_OCCUPATIONS } from '@/test-support/occupation-fixtures'
import AgentProfilePage from './AgentProfilePage.vue'

const { getJson, postJson, putJson } = vi.hoisted(() => ({ getJson: vi.fn(), postJson: vi.fn(), putJson: vi.fn() }))
vi.mock('@/api/client', () => ({ getJson, postJson, putJson, patchJson: vi.fn() }))
vi.mock('@/features/project-agents/task-updates', () => ({ subscribeTaskUpdates: () => () => {} }))
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
const teamPerson = (agentId: string, name: string) => ({ agentId, name, employeeNumber: null, occupationEmoji: null, responsibility: '', peerRole: false })
const teamView = (leadId: string, leadName: string, members: Array<[string, string]>) => ({ personalProjectId: 'project-a', status: 'ready', lead: teamPerson(leadId, leadName), unavailableLead: null,
  members: members.map(([id, name]) => ({ ...teamPerson(id, name), reportsToAgentId: leadId })), collaborators: [], peers: [], unavailableMemberIds: [] })
// Pages read one Agent at a time: answer from a synthetic roster, 404 for anyone else.
const isAgentRead = (url: string) => url.startsWith('/api/project-agents/') && new URL(url, 'http://fixture').pathname.split('/').length === 4
function agentRead(url: string, roster: unknown[]) {
  const id = decodeURIComponent(new URL(url, 'http://fixture').pathname.split('/')[3] ?? '')
  const found = (roster as Array<{ agentId: string }>).find(agent => agent.agentId === id)
  return found ? Promise.resolve(found) : Promise.reject(Object.assign(new Error('project Agent not found'), { status: 404 }))
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
beforeEach(() => {
  setActivePinia(createPinia())
  const store = useConsoleStore()
  store.state = { mode: 'connected', activePersonalSpaceId: 'space-a', personalSpaces: [{ id: 'space-a', name: 'Synthetic space' }],
    personalProjects: ['project-a', 'project-old'].map(id => ({ project_id: id, personal_space_id: 'space-a', profile: { name: id === 'project-a' ? 'Synthetic active project' : 'Synthetic previous project' } })), projects: [], subscriptions: [] }
  store.runtimeStatus = 'ready'
  getJson.mockReset(); postJson.mockReset(); putJson.mockReset()
  employeeTemplates.value = []
  getJson.mockImplementation(async (url: string) => {
    const parsed = new URL(url, 'http://fixture')
    const id = parsed.searchParams.get('agentId') ?? 'alpha'
    if (isAgentRead(url)) return agentRead(url, [person('alpha'), person('beta'), person('gamma')])
    if (parsed.pathname === '/api/project-agent-assignments') return [assignment(id), assignment(id, 'ended', 'project-old')]
    if (parsed.pathname === '/api/project-agent-tasks') return [task('done', id, 'Completed evidence'), task('queued', id, 'Only scheduled', 'queued')]
    if (parsed.pathname === '/api/project-team') return teamView('beta', 'Birch', [['alpha', 'Aster'], ['gamma', 'Cedar']])
    if (parsed.pathname === '/api/executors') return []
    if (parsed.pathname === '/api/occupations') return SYNTHETIC_OCCUPATIONS
    if (parsed.pathname === '/api/employee-templates') return { templates: [] }
    if (parsed.pathname === `/api/project-agents/${id}/memory`) return { revision: 0, current: null, history: [], workLog: [] }
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
// Tabs (shadcn-vue Tabs on reka-ui) select on mouse down; the open tab is kept in the URL.
async function openTab(wrapper: Awaited<ReturnType<typeof setup>>['wrapper'], tab: string) {
  await wrapper.get(`[data-profile-tab="${tab}"]`).trigger('mousedown')
  await flushPromises()
}
describe('Agent profile integration', () => {
  it('shows an unset occupation and saves an explicit role with tags apart from the profile', async () => {
    putJson.mockImplementation(async (url: string, payload: { role: string | null; tags: string[] }) => {
      expect(url).toBe('/api/project-agents/alpha/occupation')
      return { ...person('alpha'), occupation: { role: payload.role, tags: payload.tags, updatedAt: '2026-10-17T05:00:00Z' } }
    })
    const { wrapper } = await setup()
    expect(wrapper.get('[data-profile-occupation]').text()).toBe('还没有设置职业')
    const settings = wrapper.findAll('button').find(button => button.attributes('aria-expanded') !== undefined && button.text().includes('设置'))!
    await settings.trigger('click')
    const editor = wrapper.get('[data-occupation-editor]')
    await editor.get('[data-occupation-tag="testing"]').trigger('click')
    await editor.get('[data-occupation-tag="design"]').trigger('click')
    await editor.trigger('submit')
    await flushPromises()
    expect(putJson).toHaveBeenCalledWith('/api/project-agents/alpha/occupation', { personalSpaceId: 'space-a', role: null, tags: ['testing', 'design'] })
    expect(wrapper.findAll('[data-profile-occupation] [data-occupation]').map(chip => chip.text())).toEqual(['测试', '设计'])
    // The free-text responsibility stays as it was.
    expect(wrapper.text()).toContain('Synthetic alpha role')
  })

  it('shows why an archived Agent left beside its kept work history', async () => {
    const departed = { ...person('alpha'), profile: { ...person('alpha').profile, status: 'archived' as const },
      archivedAt: '2026-10-20T08:00:00Z', archiveReason: 'Reported work as done without running the tests.' }
    const base = getJson.getMockImplementation()!
    getJson.mockImplementation(async (url: string) => isAgentRead(url) ? agentRead(url, [departed]) : base(url))
    const { wrapper } = await setup()
    const departure = wrapper.get('[data-profile-departure]')
    expect(departure.text()).toContain('为什么离开')
    expect(departure.text()).toContain('Reported work as done without running the tests.')
    expect(wrapper.text()).toContain('Completed evidence')
  })

  it('shows an explicitly reported plan within the current work card', async () => {
    const normal = getJson.getMockImplementation()!
    getJson.mockImplementation((url: string) => url.startsWith('/api/project-agent-tasks?')
      ? Promise.resolve([{ ...task('active-plan', 'alpha', 'Synthetic planned task', 'running'), events: [{
        event_id: 'plan', task_id: 'active-plan', status: 'running', summary: 'Synthetic plan', created_at: '2026-10-13T01:00:00Z',
        execution_plan: { steps: [{ id: 'check', title: '核对执行结果', status: 'in_progress' }] },
      }] }]) : normal(url))
    const { wrapper } = await setup()
    expect(wrapper.get('.agent-current-work-list [data-execution-plan]').text()).toContain('核对执行结果')
    expect(wrapper.get('.agent-current-work-list [data-execution-plan]').text()).toContain('进行中')
  })
  it('loads a fixed role workbench on a direct profile visit without a cached catalog', async () => {
    const normal = getJson.getMockImplementation()!
    getJson.mockImplementation((url: string) => {
      if (isAgentRead(url)) return agentRead(url, [person('employee.tonborg')])
      if (url.startsWith('/api/employee-templates?')) return Promise.resolve({ templates: [{
        id: 'tonborg', name: 'Tonborg', agentId: 'employee.tonborg', agentStatus: 'active',
        workbench: { kind: 'native', view: 'judgment' },
      }] })
      return normal(url)
    })
    const { wrapper } = await setup('/agents/space-a/employee.tonborg')
    expect(getJson).toHaveBeenCalledWith('/api/employee-templates?personalSpaceId=space-a')
    expect(wrapper.find('a[href="/employees/tonborg"]').exists()).toBe(true)
  })

  it('offers each profile link once and never a manual Ask AR detour', async () => {
    const normal = getJson.getMockImplementation()!
    getJson.mockImplementation((url: string) => {
      if (isAgentRead(url)) return agentRead(url, [person('employee.bole')])
      if (url.startsWith('/api/employee-templates?')) return Promise.resolve({ templates: [{
        id: 'bole', name: 'Bole', agentId: 'employee.bole', agentStatus: 'active',
        workbench: { kind: 'native', view: 'people' },
      }] })
      return normal(url)
    })
    const { wrapper } = await setup('/agents/space-a/employee.bole')
    expect(wrapper.findAll('a[href="/employees/bole"]')).toHaveLength(1)
    expect(wrapper.findAll('a[href^="/employees/bole?"]')).toHaveLength(0)
    expect(wrapper.findAll('.agent-management-card a')).toHaveLength(1)
    expect(wrapper.get('[data-open-management]').text()).toBe('打开 Agent 管理')
    wrapper.unmount()
    getJson.mockImplementation(normal)
    const other = await setup()
    expect(other.wrapper.findAll('a[href^="/employees/bole?"]')).toHaveLength(0)
    expect(other.wrapper.text()).not.toContain('问 AR')
  })

  it('exposes conversation retention under an accessible secondary tab', async () => {
    const normal = getJson.getMockImplementation()!
    getJson.mockImplementation((url: string) => {
      if (isAgentRead(url)) return agentRead(url, [{ ...person('alpha'), memoryScope: 'reviewed_agent' }, person('beta'), person('gamma')])
      return normal(url)
    })
    const { wrapper } = await setup()
    const tab = wrapper.get('[data-profile-tab="conversations"]')
    expect(tab.attributes('role')).toBe('tab')
    expect(tab.attributes('aria-selected')).toBe('false')
    await openTab(wrapper, 'conversations')
    expect(tab.attributes('aria-selected')).toBe('true')
    expect(wrapper.get('[data-profile-panel="conversations"]').attributes('hidden')).toBeUndefined()
    expect(wrapper.find('.agent-conversations').exists()).toBe(true)
    const details = wrapper.get('.agent-conversations')
    ;(details.element as HTMLDetailsElement).open = true
    await details.trigger('toggle')
    await flushPromises()
    expect(postJson).toHaveBeenCalledWith('/api/agent-conversations/query', { personalSpaceId: 'space-a', personalProjectId: 'project-a', agentId: 'alpha', mode: 'list', limit: 20 })
  })

  it('queries conversations and memory only in the viewed Agent active projects', async () => {
    const store = useConsoleStore()
    store.state!.personalProjects!.unshift({ project_id: 'unrelated', personal_space_id: 'space-a', profile: { name: 'Unrelated conversation project' } })
    const normal = getJson.getMockImplementation()!
    getJson.mockImplementation((url: string) => {
      if (isAgentRead(url)) return agentRead(url, [{ ...person('alpha'), memoryScope: 'reviewed_agent' }])
      return normal(url)
    })
    postJson.mockImplementation(async (_url, body) => {
      if (body.personalProjectId !== 'project-a') throw new Error('project Agent not found')
      return body.mode === 'policy'
        ? { compact_after_kb: 64, context_budget: 4000, enabled: true }
        : { conversations: [] }
    })
    const { wrapper } = await setup()
    await openTab(wrapper, 'conversations')
    const details = wrapper.get('.agent-conversations')
    ;(details.element as HTMLDetailsElement).open = true
    await details.trigger('toggle')
    await flushPromises()
    expect(postJson).toHaveBeenCalledWith('/api/agent-conversations/query', { personalSpaceId: 'space-a', personalProjectId: 'project-a', agentId: 'alpha', mode: 'list', limit: 20 })
    expect(getJson).toHaveBeenCalledWith('/api/project-agents/alpha/memory?personalSpaceId=space-a&personalProjectId=project-a')
    expect(details.get('[data-working-memory]').text()).toContain('当前范围还没有经过检查点保存的工作记忆')
    await details.get('[role="combobox"]').trigger('click')
    expect(details.findAll('[role="option"]').map(option => option.text())).toEqual(['全局', 'Synthetic active project'])
    const settings = details.get('[data-memory-settings]')
    ;(settings.element as HTMLDetailsElement).open = true
    await settings.trigger('toggle')
    await flushPromises()
    expect(postJson).toHaveBeenLastCalledWith('/api/agent-conversations/query', { personalSpaceId: 'space-a', personalProjectId: 'project-a', agentId: 'alpha', mode: 'policy' })
    expect(details.find('[role="alert"]').exists()).toBe(false)
    expect(settings.find('form').exists()).toBe(true)
  })

  it('uses global context while assignments load or when none are active', async () => {
    const pending = deferred<unknown>()
    const normal = getJson.getMockImplementation()!
    getJson.mockImplementation((url: string) => {
      if (isAgentRead(url)) return agentRead(url, [{ ...person('alpha'), memoryScope: 'reviewed_agent' }])
      if (url.startsWith('/api/project-agent-assignments?')) return pending.promise
      return normal(url)
    })
    const { wrapper } = await setup()
    await openTab(wrapper, 'conversations')
    const details = wrapper.get('.agent-conversations')
    ;(details.element as HTMLDetailsElement).open = true
    await details.trigger('toggle')
    await flushPromises()
    expect(postJson).toHaveBeenCalledWith('/api/agent-conversations/query', { personalSpaceId: 'space-a', personalProjectId: null, agentId: 'alpha', mode: 'list', limit: 20 })
    pending.resolve([assignment('alpha', 'ended')])
    await flushPromises()
    expect(postJson.mock.calls.every(([, body]) => body.personalProjectId === null)).toBe(true)
    expect(details.find('[role="combobox"]').exists()).toBe(true)
    expect(details.find('[data-memory-settings]').exists()).toBe(true)
  })

  it('supports roving keyboard navigation for profile tabs', async () => {
    const normal = getJson.getMockImplementation()!
    getJson.mockImplementation((url: string) => {
      if (isAgentRead(url)) {
        return agentRead(url, [{ ...person('alpha'), memoryScope: 'reviewed_agent' }, person('beta'), person('gamma')])
      }
      return normal(url)
    })
    const { router, wrapper } = await setup()
    const tabs = () => wrapper.findAll('[role="tab"]')
    // One tab stop: Tab reaches the list, which hands focus to the open tab; arrows move between tabs.
    expect(wrapper.get('[role="tablist"]').attributes('tabindex')).toBe('0')
    expect(tabs().map((tab) => tab.attributes('tabindex'))).toEqual(['-1', '-1', '-1', '-1', '-1', '-1'])
    const selected = () => wrapper.get('[role="tab"][aria-selected="true"]').attributes('data-profile-tab')

    const first = tabs()[0]!
    ;(first.element as HTMLButtonElement).focus()
    await first.trigger('keydown', { key: 'ArrowRight' })
    await flushPromises()
    expect(selected()).toBe('history')
    expect(document.activeElement).toBe(wrapper.get('[data-profile-tab="history"]').element)
    // The open tab is part of the URL, so a refresh or a shared link lands on it.
    expect(router.currentRoute.value.query.tab).toBe('history')

    await wrapper.get('[data-profile-tab="history"]').trigger('keydown', { key: 'End' })
    await flushPromises()
    expect(selected()).toBe('management')
    expect(document.activeElement).toBe(wrapper.get('[data-profile-tab="management"]').element)

    await wrapper.get('[data-profile-tab="management"]').trigger('keydown', { key: 'Home' })
    await flushPromises()
    expect(selected()).toBe('overview')
    expect(document.activeElement).toBe(wrapper.get('[data-profile-tab="overview"]').element)
    expect(router.currentRoute.value.query.tab).toBeUndefined()
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
    const overview = wrapper.get('[data-profile-panel="overview"]')
    expect(overview.findAll('.agent-resume-section').map((section) => section.classes())).toEqual([
      expect.arrayContaining(['agent-current-work-section']),
      expect.arrayContaining(['agent-projects-section']),
    ])
    expect(overview.findAll('.agent-current-project-list > .agent-project-item')).toHaveLength(4)
    expect(overview.find('.agent-project-overflow').exists()).toBe(true)
    expect(overview.findAll('.agent-project-overflow .agent-project-item')).toHaveLength(3)
    expect(overview.findAll('.agent-project-link').map((link) => link.attributes('href'))[0]).toBe('/personal/space-a/projects/project-a/overview')
    expect(overview.findAll('.agent-project-responsibility')).toHaveLength(0)
  })

  it('uses recorded assignments, team policy and actual shared work for its resume', async () => {
    const { wrapper } = await setup()
    // The shell renders the page's one H1 from this title: the Agent's real name.
    expect(pageTitle.value.text).toBe('Aster')
    expect(wrapper.get('.agent-portrait img').attributes('src')).toBe(agentAvatarUrl('alpha'))
    expect(wrapper.find('h1').exists()).toBe(false)
    expect(wrapper.get('.agent-portrait').attributes('style')).toMatch(/--agent-identity: var\(--identity-[0-7]\)/)
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
    expect(params[0]!.get('agentId')).toBe('alpha')
    expect(params[0]!.get('limit')).toBe('200')
  })

  it('loads older Agent work without unrelated space tasks consuming the limit', async () => {
    const normal = getJson.getMockImplementation()!
    getJson.mockImplementation((url: string) => {
      const parsed = new URL(url, 'http://fixture')
      if (parsed.pathname === '/api/project-agent-tasks') {
        return Promise.resolve(parsed.searchParams.get('agentId') === 'alpha'
          ? [task('older', 'alpha', 'Older relevant work', 'running')]
          : Array.from({ length: 200 }, (_, index) => task(`other-${index}`, 'beta', 'Unrelated work')))
      }
      return normal(url)
    })
    const { wrapper } = await setup()
    expect(wrapper.get('.agent-current-work-section').text()).toContain('Older relevant work')
    expect(wrapper.find('.agent-profile-partial').exists()).toBe(false)
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

  it.each([
    ['/agents/space-a/missing', [['/api/project-agents/missing?personalSpaceId=space-a']]],
    ['/agents/space-b/alpha', []],
  ])('does not show a profile for %s', async (path, reads) => {
    const { wrapper } = await setup(path)
    expect(pageTitle.value.text).toBe('')
    expect(wrapper.find('.agent-resume-header').exists()).toBe(false)
    // Only the named Agent is read, and a foreign space is not read at all.
    expect(getJson.mock.calls).toEqual(reads)
  })

  it('rejects a foreign-space identity even if returned in a roster response', async () => {
    getJson.mockResolvedValue({ ...person('alpha'), personalSpaceId: 'space-b' })
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
    expect(pageTitle.value.text).toBe('Birch')
    late.resolve([task('late', 'alpha', 'Stale Aster result')]); await flushPromises()
    expect(pageTitle.value.text).toBe('Birch')
    expect(wrapper.text()).not.toContain('Stale Aster result')
    expect(wrapper.get('.agent-work-timeline').text()).toContain('Completed evidence')
  })

  it('says the configured lead is unavailable instead of claiming no team is set', async () => {
    const normal = getJson.getMockImplementation()!
    getJson.mockImplementation((url: string) => url.startsWith('/api/project-team?')
      ? Promise.resolve({ ...teamView('beta', 'Birch', [['alpha', 'Aster']]), status: 'lead_unavailable', lead: null,
          unavailableLead: { agentId: 'former', name: 'Former Lead' } })
      : normal(url))
    const { wrapper } = await setup()
    const organization = wrapper.get('.agent-organization')
    expect(organization.get('.agent-org-lead-unavailable').text()).toContain('Former Lead')
    expect(organization.text()).not.toContain('待配置项目总负责人')
    expect(organization.findAll('.agent-org-members a').map(link => link.text())).toEqual(['Aster'])
  })

  it('does not restore an old team when its policy arrives after navigation', async () => {
    const late = deferred<unknown>()
    const normal = getJson.getMockImplementation()!
    let policyCalls = 0
    getJson.mockImplementation((url: string) => {
      if (url.startsWith('/api/project-team?') && ++policyCalls === 1) return late.promise
      return normal(url)
    })
    const { router, wrapper } = await setup()
    await router.push('/agents/space-a/beta'); await flushPromises()
    late.resolve(teamView('stale-team-lead', 'stale-team-lead', [])); await flushPromises()
    expect(pageTitle.value.text).toBe('Birch')
    expect(wrapper.get('.agent-org-lead a').text()).toBe('Birch')
    expect(wrapper.text()).not.toContain('stale-team-lead')
  })

  it('retains legacy project membership when assignment details are unavailable', async () => {
    const normal = getJson.getMockImplementation()!
    getJson.mockImplementation((url: string) => {
      if (isAgentRead(url)) return agentRead(url, [{ ...person('alpha'), personalProjectId: 'project-a' }])
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
