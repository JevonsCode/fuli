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
import { ApiError } from '@/api/client'
import AgentProfilePage from './AgentProfilePage.vue'
import { closeCombobox, openCombobox, optionLabels } from '@/test-support/option-pickers'

const { getJson, postJson, putJson } = vi.hoisted(() => ({ getJson: vi.fn(), postJson: vi.fn(), putJson: vi.fn() }))
vi.mock('@/api/client', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/api/client')>()), getJson, postJson, putJson, patchJson: vi.fn() }))
vi.mock('@/features/project-agents/task-updates', () => ({ subscribeTaskUpdates: () => () => {} }))
const mounted: Array<{ unmount: () => void }> = []
const person = (id: string): ProjectAgentRecord => ({ agentId: id, personalSpaceId: 'space-a',
  createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
  profile: { name: id === 'alpha' ? 'Aster' : id === 'beta' ? 'Birch' : 'Cedar', responsibility: `Synthetic ${id} role`, capabilities: ['review'], initialPreferences: [], status: 'active' },
})
const builtIn = (id: string) => { const agent = person(`employee.${id}`); return { ...agent, profile: { ...agent.profile, capabilities: [`fuli.employee:${id}`] } } }
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
    if (parsed.pathname === '/api/agent-workflows') return { workflows: [] }
    if (parsed.pathname === '/api/executors') return []
    if (parsed.pathname === '/api/occupations') return SYNTHETIC_OCCUPATIONS
    if (parsed.pathname === '/api/employee-templates') return { templates: [] }
    if (parsed.pathname === `/api/project-agents/${id}/memory`) return { revision: 0, current: null, history: [], workLog: [] }
    const sheets = /^\/api\/project-agents\/([^/]+)\/workbenches$/.exec(parsed.pathname)
    if (sheets) return { agentId: decodeURIComponent(sheets[1]!), partial: false, workbenches: [] }
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
async function openSettings(wrapper: Awaited<ReturnType<typeof setup>>['wrapper']) {
  await wrapper.get('[data-profile-settings]').trigger('click')
  await flushPromises()
}
describe('Agent profile integration', () => {
  it('shows an unset occupation and saves an explicit role with tags apart from the profile', async () => {
    putJson.mockImplementation(async (url: string, payload: { role: string | null; tags: string[] }) => {
      expect(url).toBe('/api/project-agents/alpha/occupation')
      return { ...person('alpha'), occupation: { role: payload.role, tags: payload.tags, updatedAt: '2026-10-17T05:00:00Z' } }
    })
    const { wrapper } = await setup()
    expect(wrapper.get('[data-profile-occupation]').text()).toContain('还没有设置职业')
    await openSettings(wrapper)
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
  })

  it('shows each task as the shared team card: the FLA’s own share first, bars only from a recorded plan', async () => {
    const normal = getJson.getMockImplementation()!
    const share = (agentId: string, role: string, progress: { completed: number; total: number } | null) =>
      ({ agentId, role, status: 'running', assignment: `Synthetic share of ${agentId}`, progress })
    getJson.mockImplementation((url: string) => url.startsWith('/api/project-agents/alpha/workbenches?')
      ? Promise.resolve({ agentId: 'alpha', partial: false, workbenches: [{
        taskId: 'sheet-1', personalProjectId: 'project-a', title: 'Synthetic shared task', objective: 'Ship the synthetic thing', status: 'running',
        leadAgentId: 'beta', role: 'collaborator', updatedAt: null, blocker: null, progress: { completed: 1, total: 3 }, steps: [], unassignedSteps: 1,
        shares: [share('beta', 'lead', { completed: 1, total: 2 }), share('alpha', 'collaborator', null)],
      }] }) : normal(url))
    const { wrapper } = await setup()
    // The slot's widget is loaded on demand; wait for it and its read.
    await vi.dynamicImportSettled()
    await flushPromises()
    // The overview's slot holds the FLA's sheets by default, each the same 团队卡片 as the home page.
    const sheet = wrapper.get('[data-widget="fla-sheets"] [data-team-card="sheet-1"]')
    expect(sheet.text()).toContain('Synthetic shared task')
    expect(sheet.text()).toContain('Synthetic active project')
    // The first card is open, so this FLA's own list is in view.
    expect(sheet.get('[aria-expanded]').attributes('aria-expanded')).toBe('true')
    // Not the lead: its own share comes first, and without a plan count it shows only its status.
    expect(sheet.findAll('[data-team-share]').map(item => item.attributes('data-team-share'))).toEqual(['alpha', 'beta'])
    expect(sheet.get('[data-team-share="alpha"]').find('[role="progressbar"]').exists()).toBe(false)
    expect(sheet.get('[data-team-share="beta"] [role="progressbar"]').attributes('aria-valuenow')).toBe('1')
    expect(sheet.get('[data-team-share="beta"]').text()).toContain('负责人')
    expect(sheet.text()).toContain('还有 1 步没人负责')
  })
  it('loads a fixed role workbench on a direct profile visit without a cached catalog', async () => {
    const normal = getJson.getMockImplementation()!
    getJson.mockImplementation((url: string) => {
      if (isAgentRead(url)) return agentRead(url, [builtIn('tonborg')])
      if (url.startsWith('/api/employee-templates?')) return Promise.resolve({ templates: [{
        id: 'tonborg', name: 'Tonborg', agentId: 'employee.tonborg', agentStatus: 'active',
        workbench: { kind: 'native', view: 'judgment' },
      }] })
      return normal(url)
    })
    const { wrapper } = await setup('/agents/space-a/employee.tonborg')
    await vi.dynamicImportSettled(); await flushPromises()
    expect(wrapper.get('[role="tab"][aria-selected="true"]').attributes('data-profile-tab')).toBe('workbench')
    await vi.waitFor(() => expect(getJson).toHaveBeenCalledWith('/api/employee-templates?personalSpaceId=space-a', expect.objectContaining({ schema: expect.anything() })))
  })

  // Jevons 11-04: one page per FLA, three tabs. What 编排's page held is split between 工作经历 and 设置.
  it('keeps only what a person reads as tabs, and links out to no second page', async () => {
    const normal = getJson.getMockImplementation()!
    getJson.mockImplementation((url: string) => isAgentRead(url)
      ? agentRead(url, [{ ...person('alpha'), memoryScope: 'reviewed_agent' }]) : normal(url))
    const { wrapper } = await setup()
    expect(wrapper.findAll('[role="tab"]').map(tab => tab.attributes('data-profile-tab'))).toEqual(['overview', 'history'])
    await openTab(wrapper, 'history')
    await vi.dynamicImportSettled(); await flushPromises()
    await vi.waitFor(() => expect(wrapper.find('[data-profile-panel="history"] .project-agent-manage').exists()).toBe(true))
    expect(wrapper.find('a[href^="/project-agents/manage/"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('问 AR')
  })

  it('puts preferences, memory and the management sections in 设置', async () => {
    const normal = getJson.getMockImplementation()!
    getJson.mockImplementation((url: string) => isAgentRead(url)
      ? agentRead(url, [{ ...person('alpha'), memoryScope: 'reviewed_agent' }]) : normal(url))
    const { router, wrapper } = await setup()
    await openSettings(wrapper)
    await vi.dynamicImportSettled(); await flushPromises()
    expect(router.currentRoute.value.query.tab).toBe('settings')
    expect(wrapper.get('[data-agent-preferences]').text()).toContain('偏好')
    expect(wrapper.get('#agent-memory-settings-heading').text()).toBe('记忆设置')
    await vi.waitFor(() => expect(wrapper.find('[data-profile-panel="settings"] .project-agent-manage').exists()).toBe(true))
    await openSettings(wrapper)
    expect(router.currentRoute.value.query.tab).toBeUndefined()
  })

  it('settles a link that uses an Agent\'s earlier id on its current one', async () => {
    const normal = getJson.getMockImplementation()!
    getJson.mockImplementation((url: string) => isAgentRead(url) ? Promise.resolve(person('alpha')) : normal(url))
    const { router } = await setup('/agents/space-a/legacy-alpha?tab=history')
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/agents/space-a/alpha?tab=history')
  })

  it('opens 工作经历 on a link that names a task', async () => {
    const { router, wrapper } = await setup('/agents/space-a/alpha?task=done')
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({ task: 'done', tab: 'history' })
    expect(wrapper.get('[role="tab"][aria-selected="true"]').attributes('data-profile-tab')).toBe('history')
  })

  it('keeps conversation retention under 记忆设置', async () => {
    const normal = getJson.getMockImplementation()!
    getJson.mockImplementation((url: string) => {
      if (isAgentRead(url)) return agentRead(url, [{ ...person('alpha'), memoryScope: 'reviewed_agent' }, person('beta'), person('gamma')])
      return normal(url)
    })
    const { wrapper } = await setup()
    await openSettings(wrapper)
    expect(wrapper.get('[data-profile-panel="settings"]').attributes('hidden')).toBeUndefined()
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
    await openSettings(wrapper)
    const details = wrapper.get('.agent-conversations')
    ;(details.element as HTMLDetailsElement).open = true
    await details.trigger('toggle')
    await flushPromises()
    expect(postJson).toHaveBeenCalledWith('/api/agent-conversations/query', { personalSpaceId: 'space-a', personalProjectId: 'project-a', agentId: 'alpha', mode: 'list', limit: 20 })
    expect(getJson).toHaveBeenCalledWith('/api/project-agents/alpha/memory?personalSpaceId=space-a&personalProjectId=project-a')
    expect(details.get('[data-working-memory]').text()).toContain('当前范围还没有经过检查点保存的工作记忆')
    await openCombobox(details)
    expect(optionLabels(details)).toEqual(['全局', 'Synthetic active project'])
    await closeCombobox(details)
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
    await openSettings(wrapper)
    const details = wrapper.get('.agent-conversations')
    ;(details.element as HTMLDetailsElement).open = true
    await details.trigger('toggle')
    await flushPromises()
    expect(postJson).toHaveBeenCalledWith('/api/agent-conversations/query', { personalSpaceId: 'space-a', personalProjectId: null, agentId: 'alpha', mode: 'list', limit: 20 })
    pending.resolve([assignment('alpha', 'ended')])
    await flushPromises()
    // Every conversation query stays global (other reads on the page, such as a project's board, are not this test's concern).
    const queries = postJson.mock.calls.filter(([url]) => url === '/api/agent-conversations/query')
    expect(queries.length).toBeGreaterThan(0)
    expect(queries.every(([, body]) => body.personalProjectId === null)).toBe(true)
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
    expect(tabs().map((tab) => tab.attributes('tabindex'))).toEqual(['-1', '-1'])
    const selected = () => wrapper.get('[role="tab"][aria-selected="true"]').attributes('data-profile-tab')
    expect(selected()).toBe('overview')

    const first = tabs()[0]!
    ;(first.element as HTMLButtonElement).focus()
    await first.trigger('keydown', { key: 'ArrowRight' })
    await flushPromises()
    expect(selected()).toBe('history')
    expect(document.activeElement).toBe(wrapper.get('[data-profile-tab="history"]').element)
    // The open tab is part of the URL, so a refresh or a shared link lands on it.
    expect(router.currentRoute.value.query.tab).toBe('history')

    await wrapper.get('[data-profile-tab="history"]').trigger('keydown', { key: 'Home' })
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
    // The task sheets come first, then the projects.
    const sheets = overview.get('[data-task-sheets]').element
    expect(sheets.compareDocumentPosition(overview.get('.agent-projects-section').element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(overview.findAll('.agent-current-project-list > .agent-project-item')).toHaveLength(4)
    expect(overview.find('.agent-project-overflow').exists()).toBe(true)
    expect(overview.findAll('.agent-project-overflow .agent-project-item')).toHaveLength(3)
    expect(overview.findAll('.agent-project-link').map((link) => link.attributes('href'))[0]).toBe('/personal/space-a/projects/project-a/overview')
    expect(overview.findAll('.agent-project-responsibility')).toHaveLength(0)
  })

  it('reads its own work for its resume, and no team once per project', async () => {
    const { wrapper } = await setup()
    // The header carries the page's one H1, the Agent's real name, where it can be renamed;
    // the shell keeps only the tab title (rec#11 D-89).
    expect(pageTitle.value).toMatchObject({ text: 'Aster', inPage: true })
    expect(wrapper.get('.agent-portrait img').attributes('src')).toBe(agentAvatarUrl('alpha'))
    expect(wrapper.findAll('h1').map(heading => heading.text())).toEqual(['Aster'])
    expect(wrapper.find('[data-agent-name-edit]').exists()).toBe(true)
    expect(wrapper.get('[data-agent-look-trigger]').attributes('aria-label')).toBe('更换 Aster 的头像')
    expect(wrapper.get('.agent-portrait').attributes('style')).toMatch(/--agent-identity: var\(--identity-[0-7]\)/)
    expect(wrapper.text()).toContain('Synthetic active project')
    expect(wrapper.text()).toContain('Synthetic previous project')
    expect(getJson.mock.calls.some(([url]) => String(url).startsWith('/api/project-team'))).toBe(false)
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
    expect(getJson.mock.calls.some(([url]) => String(url).startsWith('/api/project-agent-tasks?') && String(url).includes('agentId=alpha'))).toBe(true)
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
    expect(wrapper.find('.agent-profile-partial').exists()).toBe(true)
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
    await wrapper.get('.agent-profile-actions button[aria-expanded]').trigger('click'); await flushPromises()
    await wrapper.get('.agent-simple-settings textarea').setValue('Explain verification evidence.')
    await wrapper.get('.agent-simple-settings').trigger('submit'); await flushPromises()
    expect(putJson).toHaveBeenCalledTimes(1)
    expect(wrapper.find('.agent-simple-settings').exists()).toBe(true)
    expect(wrapper.get('.agent-profile-actions button[aria-expanded]').attributes('aria-expanded')).toBe('true')
    expect((wrapper.get('.agent-simple-settings textarea').element as HTMLTextAreaElement).value).toBe('Explain verification evidence.')
  })
})

// Jevons 11-04: only a built-in role has a Workbench; any FLA's workflows are a tab.
const workflowVersion = (version: number, name: string) => ({ workflowId: 'wf-1', version, name, purpose: 'Synthetic repeated check',
  steps: [{ title: 'Read the synthetic issue' }, { title: 'Run the focused tests' }], source: 'candidate:c-1', createdBy: 'agent', createdAt: '2026-10-30T00:00:00Z' })
const proposed = { workflowId: 'wf-1', status: 'proposed', personalProjectId: 'project-a', versionCount: 1, active: null,
  pending: workflowVersion(1, 'Synthetic check flow'), recentRuns: [], createdAt: '2026-10-30T00:00:00Z', updatedAt: '2026-10-30T00:00:00Z' }

describe('Agent workbench', () => {
  function answer(routes: { tasks?: unknown[]; workflows?: unknown[] }) {
    const normal = getJson.getMockImplementation()!
    getJson.mockImplementation((url: string) => {
      if (routes.tasks && url.startsWith('/api/project-agent-tasks?')) return Promise.resolve(routes.tasks)
      if (routes.workflows && url.startsWith('/api/agent-workflows?')) return Promise.resolve({ workflows: routes.workflows })
      return normal(url)
    })
  }
  async function settle() { await vi.dynamicImportSettled(); await flushPromises() }
  const workflowReads = () => getJson.mock.calls.filter(([url]) => String(url).startsWith('/api/agent-workflows?')).length

  it('gives an Agent with tasks no board: the board is Jefa\'s own', async () => {
    answer({ tasks: [task('t-run', 'alpha', 'Synthetic running work', 'running')] })
    const { wrapper } = await setup()
    await settle()
    expect(wrapper.find('[data-profile-tab="workbench"]').exists()).toBe(false)
    expect(wrapper.get('[role="tab"][aria-selected="true"]').attributes('data-profile-tab')).toBe('overview')
  })

  it('opens an Agent with no work on its overview', async () => {
    answer({ tasks: [task('t-cancel', 'alpha', 'Synthetic cancelled work', 'cancelled')], workflows: [] })
    const { wrapper } = await setup()
    await settle()
    expect(wrapper.find('[data-profile-tab="workbench"]').exists()).toBe(false)
    expect(wrapper.get('[role="tab"][aria-selected="true"]').attributes('data-profile-tab')).toBe('overview')
  })

  it('shows a proposed workflow and sends the person\'s answer for the version shown', async () => {
    answer({ tasks: [], workflows: [proposed] })
    postJson.mockImplementation(async () => ({ status: 'confirmed' }))
    const { wrapper } = await setup()
    await settle()
    expect(wrapper.find('[data-profile-tab="workbench"]').exists()).toBe(false)
    expect(wrapper.get('[role="tab"][aria-selected="true"]').attributes('data-profile-tab')).toBe('workflows')
    expect(wrapper.find('[data-workbench-board]').exists()).toBe(false)
    const card = wrapper.get('[data-workflow="wf-1"]')
    expect(card.text()).toContain('Synthetic check flow')
    expect(card.text()).toContain('待你确认')
    expect(card.findAll('[data-workflow-steps="pending"] li').map((step) => step.text())).toEqual(['Read the synthetic issue', 'Run the focused tests'])
    const reads = workflowReads()
    await card.get('[data-workflow-action="confirm"]').trigger('click'); await flushPromises()
    expect(postJson).toHaveBeenCalledWith('/api/agent-workflows/wf-1/decision', { decision: 'confirm', version: 1 })
    expect(workflowReads()).toBe(reads + 1)
  })

  it('reads the workflow again when it changed since it was shown', async () => {
    answer({ tasks: [], workflows: [proposed] })
    postJson.mockRejectedValue(new ApiError('Conflict', 409, JSON.stringify({ code: 'version_conflict' })))
    const { wrapper } = await setup()
    await settle()
    const reads = workflowReads()
    await wrapper.get('[data-workflow-action="reject"]').trigger('click'); await flushPromises()
    expect(postJson).toHaveBeenCalledWith('/api/agent-workflows/wf-1/decision', { decision: 'reject', version: 1 })
    expect(wrapper.get('[data-workflow-notice]').text()).toContain('新版本')
    expect(workflowReads()).toBe(reads + 1)
  })

  it('opens a built-in role on its own workbench, the first tab, and links out to no other page', async () => {
    const normal = getJson.getMockImplementation()!
    getJson.mockImplementation((url: string) => {
      if (isAgentRead(url)) return agentRead(url, [builtIn('tonborg')])
      if (url.startsWith('/api/employee-templates?')) return Promise.resolve({ templates: [{
        id: 'tonborg', name: 'Tonborg', agentId: 'employee.tonborg', agentStatus: 'active', workbench: { kind: 'native', view: 'judgment' },
      }] })
      return normal(url)
    })
    const { wrapper } = await setup('/agents/space-a/employee.tonborg')
    await settle()
    expect(wrapper.findAll('[role="tab"]')[0]!.attributes('data-profile-tab')).toBe('workbench')
    expect(wrapper.get('[role="tab"][aria-selected="true"]').attributes('data-profile-tab')).toBe('workbench')
    expect(wrapper.find('a[href="/employees/tonborg"]').exists()).toBe(false)
  })
})
