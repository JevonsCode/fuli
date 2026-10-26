import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { createMemoryHistory, createRouter, createWebHistory, RouterView } from 'vue-router'

const getJson = vi.hoisted(() => vi.fn())
const patchJson = vi.hoisted(() => vi.fn())
const postJson = vi.hoisted(() => vi.fn())
const deleteJson = vi.hoisted(() => vi.fn())
const subscription = vi.hoisted(() => ({ subscribe: vi.fn(() => vi.fn()) }))

vi.mock('@/api/client', () => ({ getJson, patchJson, postJson, deleteJson, putJson: vi.fn() }))
vi.mock('@/features/project-agents/task-updates', () => ({ subscribeTaskUpdates: subscription.subscribe }))

import { useConsoleStore } from '@/stores/console'
import { pageTitle } from '@/layouts/page-title'
import { UiSelectStub } from '@/test-support/UiSelectStub'
import { orchestrationAgents as agents, orchestrationResponse, orchestrationState } from '@/test-support/orchestration-fixtures'
import ProjectAgentDetailPage from './ProjectAgentDetailPage.vue'
import EmployeeScopeDialog from '@/features/employees/EmployeeScopeDialog.vue'
import AgentAssignmentDialog from '@/features/project-agents/AgentAssignmentDialog.vue'
import { refreshEmployeeCatalog } from '@/features/employees/catalog'

const AGENT_PAGE = '/project-agents/manage/personal-1/shared-agent'
const mounted: Array<{ unmount: () => void }> = []

describe('ProjectAgentDetailPage', () => {
  beforeEach(async () => {
    await refreshEmployeeCatalog('')
    getJson.mockReset()
    patchJson.mockReset()
    postJson.mockReset()
    deleteJson.mockReset()
    getJson.mockImplementation(orchestrationResponse)
  })
  afterEach(() => mounted.splice(0).forEach((wrapper) => wrapper.unmount()))

  it('names the page after the Agent and shows its cross-project assignments, read for that Agent only', async () => {
    const { wrapper } = await mountPage()
    await flushPromises()

    expect(getJson).toHaveBeenCalledWith('/api/project-agents?personalSpaceId=personal-1')
    expect(pageTitle.value.text).toBe('活动 Agent')
    expect(wrapper.find('h1').exists()).toBe(false)
    expect(wrapper.get('[data-agent-responsibility]').text()).toBe('负责活动方案与复盘。')
    const projects = wrapper.get('[data-manage-panel="projects"]').text()
    expect(projects).toContain('负责活动方案与复盘。')
    expect(projects).toContain('负责界面结构与可用性审查。')
    expect(projects).toContain('活动项目')
    expect(projects).toContain('设计项目')
    expect(getJson.mock.calls.some(([url]) => String(url).includes('project-agent-context'))).toBe(false)
    expect(getJson.mock.calls.some(([url]) => String(url).includes('agentId=shared-agent'))).toBe(true)
  })

  it('subscribes to a task plan only while its execution details are expanded', async () => {
    subscription.subscribe.mockClear()
    const normal = getJson.getMockImplementation()!
    const task = { taskId: 'plan-task', title: 'Synthetic plan task', status: 'running', personalProjectId: 'project-a',
      participants: [{ agentId: 'shared-agent', role: 'lead', status: 'running' }], events: [{
        eventId: 'plan', taskId: 'plan-task', status: 'running', summary: 'Synthetic plan', createdAt: '2026-10-13T01:00:00Z',
        executionPlan: { steps: [{ id: 'check', title: '核对计划更新', status: 'in_progress' }] },
      }] }
    getJson.mockImplementation((url: string) => url.includes('/api/project-agent-tasks?')
      ? Promise.resolve([task]) : url.includes('/api/project-agent-tasks/plan-task?') ? Promise.resolve(task) : normal(url))
    const { wrapper } = await mountPage()
    await flushPromises()
    const details = wrapper.get('[data-task-details]')
    expect(details.get('[data-execution-plan]').text()).toContain('核对计划更新')
    expect(subscription.subscribe).not.toHaveBeenCalled()
    ;(details.element as HTMLDetailsElement).open = true
    await details.trigger('toggle')
    await flushPromises()
    expect(subscription.subscribe).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ taskId: 'plan-task' }))
    const unsubscribe = subscription.subscribe.mock.results.at(-1)!.value
    ;(details.element as HTMLDetailsElement).open = false
    await details.trigger('toggle')
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('shows temporary task scope and assignment without claiming a worker has started', async () => {
    const originalGet = getJson.getMockImplementation()!
    getJson.mockImplementation((url: string) => url.includes('/api/project-agent-tasks?')
      ? Promise.resolve({ tasks: [{
        task_id: 'task-temporary', title: '第一次协作', status: 'running', personal_project_id: 'temporary-project',
        project_scope: { type: 'temporary', lifetime: 'task', persisted: true },
        participants: [{ agent_id: 'shared-agent', role: 'lead', status: 'running' }], execution_summary: [],
      }] }) : originalGet(url))
    const { wrapper } = await mountPage()
    await flushPromises()
    const diagnostics = wrapper.get('.project-agent-task-diagnostics')
    expect(diagnostics.get('[data-task-project-state]').text()).toContain('独立临时项目')
    expect(diagnostics.get('[data-task-assignment-state]').text()).toContain('已记录任务分配')
    expect(diagnostics.get('[data-task-execution-state]').text()).toContain('尚未收到工作进程报告')
    expect(diagnostics.element.closest('details')).toBeNull()
    expect(wrapper.find('.project-agent-execution-summary-table').exists()).toBe(false)
  })

  it('opens on the work tab and keeps the other sections one tab away, the tab in the URL', async () => {
    const { wrapper, router } = await mountPage()
    await flushPromises()
    expect(wrapper.findAll('[data-manage-tab]').map((tab) => tab.text())).toEqual(['工作', '项目', '活动', '招聘', '执行与路由', '资料'])
    expect(wrapper.get('[data-manage-tab="work"]').attributes('data-state')).toBe('active')
    expect(wrapper.get('[data-manage-panel="work"]').find('[data-detail-section="tasks"]').exists()).toBe(true)
    const execution = wrapper.get('[data-manage-panel="execution"]')
    expect(execution.attributes('hidden')).toBeDefined()
    for (const section of ['executors', 'clients', 'routing', 'learning'])
      expect(execution.find(`[data-detail-section="${section}"]`).exists()).toBe(true)
    // reka-ui Tabs select on mouse down.
    await wrapper.get('[data-manage-tab="execution"]').trigger('mousedown', { button: 0 })
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({ tab: 'execution' })
    expect(wrapper.get('[data-manage-panel="execution"]').attributes('hidden')).toBeUndefined()
    await wrapper.get('[data-manage-tab="work"]').trigger('mousedown', { button: 0 })
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({})
  })

  it('opens the linked task diagnostics so a task deep link reveals its target', async () => {
    getJson.mockImplementation((url: string) => {
      if (url.includes('/api/project-agents?')) return Promise.resolve(agents)
      if (url.includes('/api/project-agent-tasks?')) return Promise.resolve({ tasks: [{
        task_id: 'task-linked', title: '查看已链接任务', personal_project_id: 'project-a', status: 'running',
        participants: [{ agent_id: 'shared-agent', role: 'lead', status: 'running' }], run_id: 'run-linked',
      }] })
      return Promise.resolve([])
    })

    const { wrapper } = await mountPage(false, `${AGENT_PAGE}?task=task-linked`)
    await flushPromises()

    const task = wrapper.get('#task-task-linked')
    expect(task.classes()).toContain('is-linked')
    expect((task.get('[data-task-details]').element as HTMLDetailsElement).open).toBe(true)
  })

  it('re-reads the task list when only the link scope changes for the same Agent, ignoring a stale answer', async () => {
    const pending = new Map<string, (value: unknown) => void>()
    const taskFor = (project: string, taskId: string) => ({ tasks: [{
      task_id: taskId, title: `${project} 的任务`, personal_space_id: 'personal-1', personal_project_id: project, status: 'running',
      participants: [{ agent_id: 'shared-agent', role: 'lead', status: 'running' }],
    }] })
    getJson.mockImplementation((url: string) => {
      if (!url.startsWith('/api/project-agent-tasks?') || !url.includes('limit=')) return orchestrationResponse(url)
      const project = new URL(url, 'http://test.local').searchParams.get('personalProjectId') ?? ''
      if (project === 'project-b') return new Promise((resolve) => pending.set(project, resolve))
      return Promise.resolve(taskFor(project, project === 'project-a' ? 'task-a' : 'task-c'))
    })
    const scopedReads = () => getJson.mock.calls.filter(([url]) => String(url).startsWith('/api/project-agent-tasks?') && String(url).includes('limit=')).length
    const otherReads = () => getJson.mock.calls.filter(([url]) => String(url).includes('agentId=shared-agent')).length
    const { wrapper, router } = await mountPage(false, `${AGENT_PAGE}?project=project-a&task=task-a`)
    await flushPromises()
    expect(wrapper.find('#task-task-a').exists()).toBe(true)
    const assignmentsRead = otherReads()

    await router.push(`${AGENT_PAGE}?project=project-b&task=task-b`)
    await flushPromises()
    expect(pending.has('project-b')).toBe(true)
    await router.push(`${AGENT_PAGE}?project=project-c&task=task-c`)
    await flushPromises()
    expect(wrapper.find('#task-task-c').exists()).toBe(true)
    // B answers last, for a scope the page has left: it is not shown.
    pending.get('project-b')!(taskFor('project-b', 'task-b'))
    await flushPromises()
    expect(wrapper.find('#task-task-b').exists()).toBe(false)
    expect(wrapper.find('#task-task-c').exists()).toBe(true)
    // Only the task list was read again; the Agent's other sources were not.
    expect(otherReads()).toBe(assignmentsRead)

    const reads = scopedReads()
    await wrapper.get('[data-manage-tab="execution"]').trigger('mousedown', { button: 0 })
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({ project: 'project-c', task: 'task-c', tab: 'execution' })
    expect(scopedReads()).toBe(reads)
    expect(otherReads()).toBe(assignmentsRead)
  })

  it('scrolls to the task a new scope names once its card is shown, and never on a tab switch or refresh', async () => {
    const scrolled: Element[] = []
    const original = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = function scrollIntoView(this: Element) { scrolled.push(this) }
    try {
      const task = (id: string, project: string) => ({
        task_id: id, title: `任务 ${id}`, personal_space_id: 'personal-1', personal_project_id: project, status: 'running',
        participants: [{ agent_id: 'shared-agent', role: 'lead', status: 'running' }],
      })
      getJson.mockImplementation((url: string) => {
        if (!url.startsWith('/api/project-agent-tasks?') || !url.includes('limit=')) return orchestrationResponse(url)
        const project = new URL(url, 'http://test.local').searchParams.get('personalProjectId')
        if (project === 'project-b') return Promise.resolve({ tasks: [
          ...Array.from({ length: 12 }, (_, index) => task(`before-${index + 1}`, 'project-b')), task('target', 'project-b'),
        ] })
        return Promise.resolve({ tasks: [task('task-a', 'project-a')] })
      })
      const { wrapper, router } = await mountPage(false, `${AGENT_PAGE}?project=project-a&task=task-a`)
      await flushPromises()
      expect(scrolled.map(element => element.id)).toEqual(['task-task-a'])

      scrolled.length = 0
      await router.push(`${AGENT_PAGE}?project=project-b&task=target&tab=execution`)
      await flushPromises()
      const cards = wrapper.findAll('.project-agent-task-list > *')
      expect(cards).toHaveLength(13)
      expect(cards[12]!.attributes('id')).toBe('task-target')
      expect(scrolled).toEqual([cards[12]!.element])
      expect(wrapper.get('[data-manage-panel="work"]').attributes('hidden')).toBeUndefined()

      await wrapper.get('[data-manage-tab="execution"]').trigger('mousedown', { button: 0 })
      await flushPromises()
      await wrapper.get('[data-manage-tab="work"]').trigger('mousedown', { button: 0 })
      await flushPromises()
      await wrapper.get('[data-detail-refresh]').trigger('click')
      await flushPromises()
      expect(scrolled).toHaveLength(1)
    } finally {
      Element.prototype.scrollIntoView = original
    }
  })

  it('lands a new task link on the work tab, then leaves the tabs to the person', async () => {
    const { wrapper, router } = await mountPage(false, `${AGENT_PAGE}?task=task-target&tab=execution`)
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({ task: 'task-target' })
    expect(wrapper.get('[data-manage-panel="work"]').attributes('hidden')).toBeUndefined()

    await wrapper.get('[data-manage-tab="execution"]').trigger('mousedown', { button: 0 })
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({ task: 'task-target', tab: 'execution' })
    expect(wrapper.get('[data-manage-panel="execution"]').attributes('hidden')).toBeUndefined()

    await router.push(`${AGENT_PAGE}?task=task-next&tab=execution`)
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({ task: 'task-next' })
    expect(wrapper.get('[data-manage-panel="work"]').attributes('hidden')).toBeUndefined()
  })

  it('keeps the H1 on the linked id until the Agent is known, never a section name', async () => {
    getJson.mockImplementation((url: string) => url.includes('/api/project-agents?')
      ? Promise.reject(new Error('provider unavailable')) : orchestrationResponse(url))
    const { wrapper } = await mountPage()
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('provider unavailable')
    expect(pageTitle.value.text).toBe('shared-agent')
  })

  it('shows reported enums through their labels and keeps the profile link in 资料', async () => {
    const agent = { ...structuredClone(agents[0]!), memoryScope: 'task_only' }
    getJson.mockImplementation((url: string) => {
      if (url.includes('/api/project-agents?')) return Promise.resolve([agent])
      if (url.includes('/api/project-agent-recruitments?')) return Promise.resolve({ recruitments: [{
        recruitment_id: 'recruitment-label', personal_space_id: 'personal-1', personal_project_id: 'project-a',
        task_id: 'task-1', coordinator_agent_id: 'coordinator', position_kind: 'durable', work_kind: 'frontend',
        required_capabilities: [], reason_code: 'capacity', reason: '需要长期协作者', status: 'awaiting_confirmation',
        proposed_agent_id: 'shared-agent', revision: 1, created_at: '2026-08-16T00:00:00Z', updated_at: '2026-08-16T00:00:00Z',
      }] })
      return orchestrationResponse(url)
    })
    const { wrapper } = await mountPage()
    await flushPromises()
    const recruitment = wrapper.get('[data-manage-panel="recruitment"]').text()
    expect(recruitment).toContain('长期岗位 · frontend')
    expect(wrapper.get('[data-recruitment-status]').text()).toBe('待确认')
    expect(recruitment).not.toContain('awaiting_confirmation')
    const profile = wrapper.get('[data-manage-panel="profile"]')
    expect(profile.text()).toContain('仅限任务')
    expect(profile.text()).not.toContain('task_only')
    expect(profile.find('[data-agent-profile-link]').attributes('href')).toBe('/agents/personal-1/shared-agent')
    expect(wrapper.get('.project-agent-summary').find('[data-agent-profile-link]').exists()).toBe(false)
  })

  it.each(['target-agent', 'legacy-target'])('opens a task deep-link Agent whose assignment is in another project (%s)', async (routeAgent) => {
    const target = structuredClone(agents[0]!)
    target.agentId = 'target-agent'
    target.legacyAgentIds = ['legacy-target']
    target.profile.name = '目标 Agent'
    target.assignments = [{ ...target.assignments![0]!, assignmentId: 'target-b', agentId: 'target-agent', personalProjectId: 'project-b' }]
    const firstProjectAgent = structuredClone(agents[0]!)
    firstProjectAgent.agentId = 'first-project-agent'
    firstProjectAgent.profile.name = '项目 A 第一位'
    firstProjectAgent.assignments = [{ ...firstProjectAgent.assignments![0]!, assignmentId: 'first-a', agentId: 'first-project-agent', personalProjectId: 'project-a' }]
    getJson.mockImplementation((url: string) => {
      if (url.includes('/api/project-agents?')) return Promise.resolve([firstProjectAgent, target])
      if (url.includes('/api/project-agent-tasks?')) return Promise.resolve({ tasks: [{
        task_id: 'task-cross-project', title: '跨项目任务', personal_project_id: 'project-a', status: 'running',
        lead_agent_id: 'target-agent', participants: [{ agent_id: 'target-agent', role: 'lead', status: 'running' }],
      }] })
      return Promise.resolve([])
    })

    const { wrapper, router } = await mountPage(false, `/project-agents/manage/personal-1/${routeAgent}?project=project-a&task=task-cross-project`)
    await flushPromises()

    expect(pageTitle.value.text).toBe('目标 Agent')
    expect(wrapper.get('#task-task-cross-project').text()).toContain('跨项目任务')
    // An earlier id settles on the Agent's current one, keeping the task scope.
    expect(router.currentRoute.value.fullPath).toBe('/project-agents/manage/personal-1/target-agent?project=project-a&task=task-cross-project')
  })

  it.each(['owner_agent_id', 'lead_agent_id', 'coordinator_agent_id'])('loads a linked %s-only task omitted by the participant-filtered API', async (identity) => {
    const original = getJson.getMockImplementation()!
    getJson.mockImplementation((url: string) => {
      if (url.startsWith('/api/project-agent-tasks?')) return Promise.resolve([])
      if (url.startsWith('/api/project-agent-tasks/ownership-only?')) return Promise.resolve({
        task_id: 'ownership-only', title: '负责人任务', personal_space_id: 'personal-1',
        personal_project_id: 'project-a', status: 'running', participants: [], [identity]: 'shared-agent',
      })
      return original(url)
    })
    const { wrapper } = await mountPage(false, `${AGENT_PAGE}?project=project-a&task=ownership-only`)
    await flushPromises()
    expect(wrapper.get('#task-ownership-only').text()).toContain('负责人任务')
    const scopedRequest = getJson.mock.calls.map(([url]) => new URL(String(url), 'http://test.local'))
      .find(url => url.pathname === '/api/project-agent-tasks' && url.searchParams.has('personalProjectId'))!
    expect(scopedRequest.searchParams.has('agentId')).toBe(false)
    expect(scopedRequest.searchParams.get('limit')).toBe('200')
  })

  it('filters space-wide tasks by Agent and marks a partial response without claiming it is empty', async () => {
    const original = getJson.getMockImplementation()!
    getJson.mockImplementation((url: string) => {
      if (url.startsWith('/api/project-agent-tasks?')) return Promise.resolve({ has_more: true, tasks: [{
        task_id: 'foreign', title: '其他 Agent 的任务', personal_space_id: 'personal-1',
        personal_project_id: 'project-a', status: 'running', owner_agent_id: 'someone-else', participants: [],
      }] })
      return original(url)
    })
    const { wrapper } = await mountPage()
    await flushPromises()
    expect(wrapper.find('#task-foreign').exists()).toBe(false)
    expect(wrapper.find('[data-task-partial]').exists()).toBe(true)
  })

  it('starts with loading during console bootstrap, never a false unavailable Agent', async () => {
    let finishBootstrap!: (value: unknown) => void
    let finishRoster!: (value: unknown) => void
    const original = getJson.getMockImplementation()!
    getJson.mockImplementation((url: string) => {
      if (url === '/api/state') return new Promise(resolve => { finishBootstrap = resolve })
      if (url.includes('/api/project-agents?')) return new Promise(resolve => { finishRoster = resolve })
      return original(url)
    })
    const { wrapper, store, initialState } = await mountPage(true)
    await flushPromises()
    expect(wrapper.get('.growth-loading--page').attributes('role')).toBe('status')
    expect(wrapper.text()).not.toContain('这个 Agent 不在当前个人空间中')
    finishBootstrap(initialState)
    await flushPromises()
    expect(store.runtimeStatus).toBe('ready')
    expect(wrapper.get('.growth-loading--page').text()).toContain('正在读取项目 Agent 列表')
    finishRoster(agents)
    await flushPromises()
    expect(pageTitle.value.text).toBe('活动 Agent')
    expect(wrapper.find('[data-detail-section="tasks"]').exists()).toBe(true)
  })

  it('shows bootstrap failure and retries initialization instead of claiming the Agent is gone', async () => {
    const original = getJson.getMockImplementation()!
    getJson.mockImplementation((url: string) => url === '/api/state'
      ? Promise.reject(new Error('initialization unavailable')) : original(url))
    const { wrapper, initialState } = await mountPage(true)
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('initialization unavailable')
    getJson.mockImplementation((url: string) => url === '/api/state'
      ? Promise.resolve(initialState) : original(url))
    await wrapper.get('[role="alert"] button').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-detail-section="tasks"]').exists()).toBe(true)
  })

  it('ignores a pending roster after the personal space is removed', async () => {
    let finishRoster!: (value: unknown) => void
    const original = getJson.getMockImplementation()!
    getJson.mockImplementation((url: string) => url.includes('/api/project-agents?')
      ? new Promise(resolve => { finishRoster = resolve }) : original(url))
    const { wrapper, store } = await mountPage()
    await flushPromises()
    store.state = { ...store.state!, personalSpaces: [], activePersonalSpaceId: null }
    await nextTick()
    const calls = getJson.mock.calls.length
    finishRoster(agents)
    await flushPromises()
    expect(wrapper.find('[data-detail-section="tasks"]').exists()).toBe(false)
    expect(getJson.mock.calls).toHaveLength(calls)
  })

  it('never shows or reads details for an Agent of another space, and says so', async () => {
    const { wrapper } = await mountPage(false, '/project-agents/manage/personal-2/shared-agent')
    await flushPromises()
    expect(wrapper.text()).toContain('这个 Agent 不在当前个人空间中')
    expect(getJson.mock.calls.some(([url]) => String(url).includes('agentId=shared-agent'))).toBe(false)
  })

  it('goes Back to the collection it was opened from, so its filters come back', async () => {
    const { wrapper, router } = await mountPage(false, '/project-agents/manage?status=active', createWebHistory())
    await flushPromises()
    await router.push(AGENT_PAGE)
    await flushPromises()
    const returned = new Promise((resolve) => router.afterEach(resolve))
    await wrapper.get('.agent-profile-back').trigger('click')
    await returned
    expect(router.currentRoute.value.fullPath).toBe('/project-agents/manage?status=active')
  })

  it('shows request errors and retries the roster load', async () => {
    getJson.mockRejectedValueOnce(new Error('provider unavailable'))
    const { wrapper } = await mountPage()
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain('provider unavailable')
    getJson.mockResolvedValueOnce(agents)
    await wrapper.get('[role="alert"] button').trigger('click')
    await flushPromises()

    expect(wrapper.find('.project-agents-state[role="alert"]').exists()).toBe(false)
    expect(pageTitle.value.text).toBe('活动 Agent')
  })

  it.each([true, false])('scopes employee conversations to actual assignments (assigned=%s)', async (assigned) => {
    const employee = structuredClone(agents[0]!)
    employee.agentId = 'employee.concierge'
    employee.personalProjectId = null
    employee.memoryScope = 'reviewed_agent'
    employee.profile.capabilities = ['fuli.employee:concierge']
    employee.assignments = assigned
      ? [{ ...employee.assignments![0]!, agentId: employee.agentId }]
      : []
    const template = {
      id: 'concierge', version: '1.0.0', name: 'Synthetic concierge', role: 'Manager', description: 'Synthetic test employee',
      capabilities: [], permissions: [], runtime: null, runtimeStatus: 'not_required',
      agentId: employee.agentId, agentStatus: 'active', assignments: employee.assignments, assignmentsVersion: 'version-0', identityConflict: false,
      management: { mode: 'all', projectIds: [], excludedProjectIds: [], titleMode: 'off', titleStyle: 'text' },
      managedProjects: [{ id: 'project-b', name: 'Project B' }, { id: 'project-a', name: 'Project A' }],
    }
    const original = getJson.getMockImplementation()!
    getJson.mockImplementation((url: string) => {
      if (url.includes('/api/project-agents?')) return Promise.resolve([employee])
      if (url.includes('/api/project-agent-assignments?')) return Promise.resolve({ assignments: employee.assignments })
      if (url.includes('/api/employee-templates?')) return Promise.resolve({ templates: [template] })
      return original(url)
    })
    postJson.mockResolvedValue({ conversations: [] })
    const { wrapper } = await mountPage(false, '/project-agents/manage/personal-1/employee.concierge')
    await flushPromises()
    const conversations = wrapper.get('.agent-conversations')
    ;(conversations.element as HTMLDetailsElement).open = true
    await conversations.trigger('toggle')
    await flushPromises()
    if (assigned) {
      // The panel reads on display, so the final read follows the assigned projects once they load.
      expect(postJson).toHaveBeenLastCalledWith('/api/agent-conversations/query', {
        personalSpaceId: 'personal-1', personalProjectId: 'project-a', agentId: employee.agentId, mode: 'list', limit: 20,
      })
      expect(conversations.findAll('option').map(option => option.attributes('value')).filter(Boolean)).toEqual(['project-a'])
    } else {
      expect(postJson).toHaveBeenCalledExactlyOnceWith('/api/agent-conversations/query', {
        personalSpaceId: 'personal-1', personalProjectId: null, agentId: employee.agentId, mode: 'list', limit: 20,
      })
      expect(conversations.find('select').exists()).toBe(true)
      expect(conversations.find('[data-memory-settings]').exists()).toBe(true)
    }
    // Workbench management still covers all projects; conversation access does not create assignments.
    expect(wrapper.findAll('.employee-assigned-projects a')).toHaveLength(2)
  })

  it('opens the inline multi-project editor directly for employee roles, including future templates', async () => {
    const employee = structuredClone(agents[0]!)
    employee.agentId = 'employee.concierge'
    employee.personalProjectId = null
    employee.profile.name = 'Concierge（合成测试）'
    employee.profile.capabilities = ['fuli.employee:concierge', '项目管理']
    employee.assignments = []
    const template = {
      id: 'concierge', version: '1.0.0', name: 'Concierge（合成测试）', role: '项目经理', description: '合成员工测试',
      capabilities: ['项目管理'], permissions: ['board.read'], runtime: null, runtimeStatus: 'not_required',
      agentId: employee.agentId, agentStatus: 'active', assignments: [], assignmentsVersion: 'version-0', identityConflict: false,
    }
    const original = getJson.getMockImplementation()!
    getJson.mockImplementation((url: string) => {
      if (url.includes('/api/project-agents?')) return Promise.resolve([employee])
      if (url.includes('/api/project-agent-assignments?')) return Promise.resolve({ assignments: [] })
      if (url.includes('/api/employee-templates?')) return Promise.resolve({ templates: [template] })
      return original(url)
    })
    const { wrapper } = await mountPage(false, '/project-agents/manage/personal-1/employee.concierge')
    await flushPromises()
    await wrapper.get('.employee-project-overview button').trigger('click')
    await flushPromises()
    const dialog = wrapper.getComponent(EmployeeScopeDialog)
    expect(dialog.props('templateId')).toBe('concierge')
    expect(dialog.props('open')).toBe(true)
    expect(dialog.get('h2').text()).toContain('Concierge')
    expect(dialog.findAll('.project-scope-list input[type="checkbox"]')).toHaveLength(2)
    expect(dialog.find('.project-scope-trigger').exists()).toBe(false)
    expect(wrapper.getComponent(AgentAssignmentDialog).props('open')).toBe(false)
    await dialog.get('.project-scope-all input').setValue(true)
    await dialog.get('input[value="project-b"]').setValue(false)
    expect(dialog.get('.project-scope-count').text()).toContain('1 / 共 2')
    expect(postJson).not.toHaveBeenCalled()
    await dialog.get('.ui-dialog__header button').trigger('click')
    await wrapper.get('[data-detail-section="assignments"]').findAll('button')
      .find((button) => button.text() === '分配项目')!.trigger('click')
    await flushPromises()
    expect(wrapper.getComponent(EmployeeScopeDialog).props('open')).toBe(true)
    expect(wrapper.getComponent(EmployeeScopeDialog).props('templateId')).toBe('concierge')
    expect(wrapper.getComponent(AgentAssignmentDialog).props('open')).toBe(false)
    expect(postJson).not.toHaveBeenCalled()
  })

  it('does not show ended assignments as current projects or synthesize an empty reported assignment', async () => {
    const endedAgent = structuredClone(agents[0]!)
    endedAgent.assignments![0]!.status = 'ended'
    const original = getJson.getMockImplementation()!
    getJson.mockImplementation((url: string) => {
      if (url.includes('/api/project-agents?')) return Promise.resolve([endedAgent])
      if (url.includes('/api/project-agent-assignments?')) return Promise.resolve({ assignments: endedAgent.assignments })
      return original(url)
    })
    const { wrapper } = await mountPage()
    await flushPromises()
    // No current assignment: the profile counts none.
    expect(wrapper.get('[data-manage-panel="profile"] dd').text()).toBe('0')
    expect(wrapper.get('[data-detail-section="assignments"]').text()).toContain('活动项目')
    expect(wrapper.get('[data-detail-section="assignments"]').text()).not.toContain('→ 当前分配')
    endedAgent.assignments = []
    await wrapper.findAll('button').find((button) => button.text() === '刷新真实数据')!.trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-detail-section="assignments"]').text()).not.toContain('当前分配')
  })

  it('shows only reported execution data and loads task/activity evidence on demand', async () => {
    const { wrapper } = await mountPage()
    await flushPromises()

    expect(wrapper.get('.project-agent-detail').text()).toContain('flexible')
    expect(wrapper.get('.project-agent-detail').text()).toContain('没有真实学习依据')

    getJson.mockImplementation((url: string) => {
      if (url.includes('/project-agent-tasks?')) {
        return Promise.resolve({ tasks: [{
          task_id: 'task-1',
          title: '活动复盘',
          personal_project_id: 'project-a',
          status: 'completed',
          run_id: 'run-1',
          participants: [{ agent_id: 'shared-agent', role: 'lead', status: 'completed' }],
          events: [{
            event_id: 'event-1', task_id: 'task-1', agent_id: 'shared-agent', status: 'completed',
            summary: '已完成', source_application: 'codex', actual_model_provider: 'openai', actual_model: 'model-x',
            created_at: '2026-08-17T03:00:00Z',
          }],
        }] })
      }
      if (url.includes('/project-agent-activity?')) {
        return Promise.resolve({ agent_id: 'shared-agent', personal_space_id: 'personal-1', days: [{
          date: '2026-08-17', completed: 1, failed: 0, cancelled: 0, total: 1,
          tasks: [{ task_id: 'task-1', title: '活动复盘', status: 'completed', summary: '已完成', occurred_at: '2026-08-17T03:00:00Z', personal_project_id: 'project-a' }],
        }] })
      }
      if (url.includes('/executors?')) return Promise.resolve({ executors: [{ executor_id: 'executor-1', provider: 'openai', model: 'model-x', client: 'codex', allowed: true, actual_use: { count: 1, last_used_at: '2026-08-17T03:00:00Z' } }] })
      if (url.includes('/executor-routing-rules?')) return Promise.resolve({ rules: [] })
      return Promise.resolve({ learning_evidence: {} })
    })
    await wrapper.get('[data-detail-refresh]').trigger('click')
    await flushPromises()

    expect(wrapper.get('.project-agent-task-card').text()).toContain('openai')
    expect(wrapper.get('.project-agent-task-card').text()).toContain('model-x')
    expect(wrapper.get('.project-agent-task-card').text()).toContain('Codex')
    expect(wrapper.find('.project-agent-heatmap').exists()).toBe(true)
    await wrapper.get('.project-agent-heat-cell').trigger('click')
    expect(wrapper.get('.project-agent-day-detail').text()).toContain('活动复盘')
    expect(wrapper.get('.project-agent-client-list').text()).toContain('实际调用 1 次')
  })

  it('renders real per-worker execution summaries with worker fallback fields', async () => {
    const task = {
      task_id: 'task-summary',
      title: '整理执行结果',
      personal_project_id: 'project-a',
      status: 'running',
      participants: [{ agent_id: 'shared-agent', role: 'lead', status: 'running' }],
      execution_summary: [
        {
          worker_id: 'worker-1', worker_label: '真实子 Agent', worker_occupation_emoji: '🧭',
          agent_id: 'shared-agent', participant_role: 'collaborator', executor: '本地执行器', executor_id: 'executor-1',
          source_application: 'codex', actual_model_provider: 'openai', actual_model: 'model-x',
          source_session_id: '01234567-89ab-cdef-0123-456789abcdef',
          source_session_url: 'codex://threads/01234567-89ab-cdef-0123-456789abcdef',
          tools_used: ['pytest', 'rg'],
          token_usage: {
            source: 'dingdong', total_tokens: 1234, input_tokens: 1200,
            output_tokens: 34, cached_input_tokens: 500,
          },
          work_summary: '完成结构审查', status: 'completed',
        },
        {
          agent_id: 'shared-agent', agent_name: '活动 Agent', occupation_emoji: '🎛️',
          participant_role: 'lead', work_summary: '等待收尾', status: 'failed',
          source_session_id: 'unsafe-session', source_session_url: 'javascript:alert(1)',
        },
      ],
    }
    getJson.mockImplementation((url: string) => {
      if (url.includes('/api/project-agents?')) return Promise.resolve(agents)
      if (url.includes('/api/project-agent-tasks?')) return Promise.resolve({ tasks: [task] })
      if (url.includes('/api/project-agent-activity?')) return Promise.resolve({ agent_id: 'shared-agent', personal_space_id: 'personal-1', days: [] })
      if (url.includes('/api/project-agent-assignments?')) return Promise.resolve({ assignments: [] })
      if (url.includes('/api/project-agent-recruitments?')) return Promise.resolve({ recruitments: [] })
      if (url.includes('/api/project-agent-recruitment-policy?')) return Promise.resolve({ personal_space_id: 'personal-1', confirmation_mode: 'automatic' })
      if (url.includes('/api/executors?')) return Promise.resolve({ executors: [] })
      if (url.includes('/api/executor-routing-rules?')) return Promise.resolve({ rules: [] })
      if (url.includes('/api/project-agent-routing-learning?')) return Promise.resolve([])
      return Promise.resolve([])
    })
    const { wrapper } = await mountPage()
    await flushPromises()

    const summary = wrapper.get('.project-agent-execution-summary')
    expect(summary.text()).toContain('真实子 Agent')
    expect(summary.text()).toContain('🧭')
    expect(summary.text()).toContain('executor-1')
    expect(summary.text()).toContain('Codex')
    expect(summary.text()).toContain('model-x')
    expect(summary.text()).toContain('完成结构审查')
    expect(summary.text()).toContain('1,234 Token')
    expect(summary.text()).toContain('DingDong')
    expect(summary.text()).toContain('01234567-89ab-cdef-0123-456789abcdef')
    expect(summary.text()).toContain('pytest')
    expect(summary.text()).toContain('rg')
    expect(summary.text()).toContain('已完成')
    expect(summary.text()).toContain('失败')
    expect(summary.get('.project-agent-execution-summary-table').element.tagName).toBe('TABLE')
    expect(summary.get('.project-agent-execution-summary-table-wrap').attributes()).toMatchObject({
      role: 'region', tabindex: '0',
    })
    expect(summary.get('caption').classes()).toContain('ui-sr-only')
    expect(summary.findAll('thead th').every((cell) => cell.attributes('scope') === 'col')).toBe(true)
    expect(summary.findAll('tbody th').every((cell) => cell.attributes('scope') === 'row')).toBe(true)
    expect(summary.findAll('.project-agent-execution-summary-row')).toHaveLength(2)
    expect(summary.findAll('.project-agent-execution-summary-row').every((row) => row.element.tagName === 'TR')).toBe(true)
    const sessionLink = summary.get('a[href^="codex://threads/"]')
    expect(sessionLink.attributes('href')).toBe(
      'codex://threads/01234567-89ab-cdef-0123-456789abcdef',
    )
    expect(sessionLink.attributes()).toMatchObject({ target: '_blank', rel: 'noreferrer' })
    expect(summary.find('a[href^="javascript:"]').exists()).toBe(false)
    expect(summary.findAll('.project-agent-execution-summary-row')[0].text()).toContain('协作者')
    expect(summary.findAll('.project-agent-execution-summary-row')[1].text()).toContain('负责人')
    expect(summary.findAll('.project-agent-execution-summary-row')[1].text()).not.toContain('实际模型')
  })

  it.each([null, 'https://example.invalid/sessions/worker-session', 'javascript:alert(1)'])(
    'keeps worker and reporting links distinct with worker URL %s', async (sessionUrl) => {
      const originalGet = getJson.getMockImplementation()!
      getJson.mockImplementation((url: string) => {
        if (!url.includes('/api/project-agent-tasks?')) return originalGet(url)
        return Promise.resolve({ tasks: [{
          task_id: 'task-runtime', owner_agent_id: 'shared-agent', title: '独立执行器验证', personal_project_id: 'project-a',
          status: 'blocked', participants: [], execution_summary: [{
            agent_id: 'shared-agent', worker_id: 'worker-a', participant_role: 'lead',
            source_application: 'codex', source_session_id: 'reporter-session',
            source_session_url: 'https://example.invalid/sessions/reporter-session',
            worker_runtime: { application: 'claude_code', session_id: 'worker-session', session_url: sessionUrl },
            tools_used: [],
            status: 'failed', work_summary: '认证失败，未执行项目测试。',
          }],
        }] })
      })
      const { wrapper } = await mountPage()
      await flushPromises()
      const row = wrapper.get('.project-agent-execution-summary-row')
      expect(row.text()).toContain('执行器会话 · Claude Code')
      expect(row.text()).toContain('上报会话 · Codex')
      expect(row.text()).toContain('worker-session')
      expect(row.text()).toContain('未使用工具')
      const reporterLink = row.get('a[href="https://example.invalid/sessions/reporter-session"]')
      expect(reporterLink.text()).toBe('reporter-session')
      if (sessionUrl?.startsWith('https:')) {
        expect(row.get(`a[href="${sessionUrl}"]`).text()).toBe('worker-session')
      } else {
        expect(row.findAll('a')).toHaveLength(1)
        expect(row.findAll('small').some((item) => item.text() === 'worker-session')).toBe(true)
      }
      expect(row.find('a[href^="javascript:"]').exists()).toBe(false)
      expect(row.text()).not.toContain('0 Token')
    },
  )

  it('shows a reported empty execution summary without treating an unreported field as empty', async () => {
    const task = {
      task_id: 'task-empty-summary', owner_agent_id: 'shared-agent', title: '等待执行者', personal_project_id: 'project-a', status: 'running', participants: [], execution_summary: [],
    }
    getJson.mockImplementation((url: string) => {
      if (url.includes('/api/project-agents?')) return Promise.resolve(agents)
      if (url.includes('/api/project-agent-tasks?')) return Promise.resolve({ tasks: [task] })
      if (url.includes('/api/project-agent-activity?')) return Promise.resolve({ agent_id: 'shared-agent', personal_space_id: 'personal-1', days: [] })
      if (url.includes('/api/project-agent-assignments?')) return Promise.resolve({ assignments: [] })
      if (url.includes('/api/project-agent-recruitments?')) return Promise.resolve({ recruitments: [] })
      if (url.includes('/api/project-agent-recruitment-policy?')) return Promise.resolve({ personal_space_id: 'personal-1', confirmation_mode: 'automatic' })
      if (url.includes('/api/executors?')) return Promise.resolve({ executors: [] })
      if (url.includes('/api/executor-routing-rules?')) return Promise.resolve({ rules: [] })
      if (url.includes('/api/project-agent-routing-learning?')) return Promise.resolve([])
      return Promise.resolve([])
    })
    const { wrapper } = await mountPage()
    await flushPromises()

    expect(wrapper.get('.project-agent-execution-summary').text()).toContain('没有真实参与执行者')

    getJson.mockImplementation((url: string) => {
      if (url.includes('/api/project-agents?')) return Promise.resolve(agents)
      if (url.includes('/api/project-agent-tasks?')) return Promise.resolve({ tasks: [{ ...task, execution_summary: undefined }] })
      if (url.includes('/api/project-agent-activity?')) return Promise.resolve({ agent_id: 'shared-agent', personal_space_id: 'personal-1', days: [] })
      if (url.includes('/api/project-agent-assignments?')) return Promise.resolve({ assignments: [] })
      if (url.includes('/api/project-agent-recruitments?')) return Promise.resolve({ recruitments: [] })
      if (url.includes('/api/project-agent-recruitment-policy?')) return Promise.resolve({ personal_space_id: 'personal-1', confirmation_mode: 'automatic' })
      if (url.includes('/api/executors?')) return Promise.resolve({ executors: [] })
      if (url.includes('/api/executor-routing-rules?')) return Promise.resolve({ rules: [] })
      if (url.includes('/api/project-agent-routing-learning?')) return Promise.resolve([])
      return Promise.resolve([])
    })
    await wrapper.get('[data-detail-refresh]').trigger('click')
    await flushPromises()
    expect(wrapper.find('.project-agent-execution-summary').exists()).toBe(false)
  })

  it('renders a dash when worker token usage is unavailable', async () => {
    const originalGet = getJson.getMockImplementation()!
    getJson.mockImplementation((url: string) => {
      if (!url.includes('/api/project-agent-tasks?')) return originalGet(url)
      return Promise.resolve({ tasks: [{
        task_id: 'task-token-missing', owner_agent_id: 'shared-agent',
        title: '等待用量', personal_project_id: 'project-a', status: 'completed',
        participants: [], execution_summary: [{
          agent_id: 'shared-agent', worker_id: 'worker-a', participant_role: 'lead',
          source_application: 'codex', source_session_id: 'worker-session',
          status: 'completed', work_summary: '已完成',
        }],
      }] })
    })
    const { wrapper } = await mountPage()
    await flushPromises()

    const row = wrapper.get('.project-agent-execution-summary-row')
    expect(row.findAll('td')[4].text()).toBe('-')
  })

  it('shows worker event evidence separately when execution summary is absent', async () => {
    const task = {
      task_id: 'task-worker-event', owner_agent_id: 'shared-agent', title: '验证工作进程', personal_project_id: 'project-a', status: 'completed', participants: [],
      events: [{
        event_id: 'event-worker', task_id: 'task-worker-event', status: 'completed',
        summary: '完成独立验证', worker_id: 'worker-event-1', worker_label: '验证工作进程',
        worker_occupation_emoji: '🔌', worker_status: 'completed', source_application: 'codex',
        actual_model_provider: 'openai', actual_model: 'model-event', created_at: '2026-08-17T04:00:00Z',
      }],
    }
    getJson.mockImplementation((url: string) => {
      if (url.includes('/api/project-agents?')) return Promise.resolve(agents)
      if (url.includes('/api/project-agent-tasks?')) return Promise.resolve({ tasks: [task] })
      if (url.includes('/api/project-agent-activity?')) return Promise.resolve({ agent_id: 'shared-agent', personal_space_id: 'personal-1', days: [] })
      if (url.includes('/api/project-agent-assignments?')) return Promise.resolve({ assignments: [] })
      if (url.includes('/api/project-agent-recruitments?')) return Promise.resolve({ recruitments: [] })
      if (url.includes('/api/executors?')) return Promise.resolve({ executors: [] })
      if (url.includes('/api/executor-routing-rules?')) return Promise.resolve({ rules: [] })
      if (url.includes('/api/project-agent-routing-learning?')) return Promise.resolve([])
      return Promise.resolve([])
    })
    const { wrapper } = await mountPage()
    await flushPromises()

    const evidence = wrapper.get('.project-agent-worker-event-evidence')
    expect(evidence.text()).toContain('验证工作进程')
    expect(evidence.text()).toContain('worker-event-1')
    expect(evidence.text()).toContain('完成独立验证')
    expect(evidence.text()).toContain('model-event')
    expect(wrapper.find('.project-agent-execution-summary').exists()).toBe(false)
  })

  it('renders the reported staffing decision without treating configured Agents as workers', async () => {
    const task = {
      task_id: 'task-routing-decision', owner_agent_id: 'shared-agent', title: '拆分验证任务', personal_project_id: 'project-a', status: 'running', participants: [],
      routing_decision: {
        decision_id: 'decision-1', coordinator_agent_id: 'coordinator-1', complexity: 'high',
        complexity_basis: ['多个独立工作流'], outcome: 'parallel_reuse', reason: '已有能力覆盖',
        match_basis: ['capability', 'assignment'], candidate_agent_ids: ['worker-a', 'worker-b'],
        parallel_plan: {
          enabled: true, independent_verification: true, conflict_free_scopes: true,
          reason: '工作范围互斥', workstream_boundaries: ['结构审查', '行为验证'],
        },
      },
    }
    getJson.mockImplementation((url: string) => {
      if (url.includes('/api/project-agents?')) return Promise.resolve(agents)
      if (url.includes('/api/project-agent-tasks?')) return Promise.resolve({ tasks: [task] })
      if (url.includes('/api/project-agent-activity?')) return Promise.resolve({ agent_id: 'shared-agent', personal_space_id: 'personal-1', days: [] })
      if (url.includes('/api/project-agent-assignments?')) return Promise.resolve({ assignments: [] })
      if (url.includes('/api/project-agent-recruitments?')) return Promise.resolve({ recruitments: [] })
      if (url.includes('/api/executors?')) return Promise.resolve({ executors: [] })
      if (url.includes('/api/executor-routing-rules?')) return Promise.resolve({ rules: [] })
      if (url.includes('/api/project-agent-routing-learning?')) return Promise.resolve([])
      return Promise.resolve([])
    })
    const { wrapper } = await mountPage()
    await flushPromises()

    const decision = wrapper.get('.project-agent-routing-decision')
    expect(decision.text()).toContain('已报告排班决定')
    expect(decision.text()).toContain('coordinator-1')
    expect(decision.text()).toContain('high')
    expect(decision.text()).toContain('worker-a')
    expect(decision.text()).toContain('工作范围互斥')
    expect(decision.text()).toContain('结构审查')
    expect(wrapper.find('.project-agent-execution-summary').exists()).toBe(false)
    // Staffing evidence stays reachable but sits behind the nested technical disclosure.
    const tech = decision.element.closest<HTMLDetailsElement>('[data-task-tech]')
    expect(tech?.open).toBe(false)
    expect(tech?.textContent).toContain('task-routing-decision')
  })

  it('keeps the public year heatmap scroller inside its layout boundary', async () => {
    const activityUrls: string[] = []
    getJson.mockImplementation((url: string) => {
      if (url.includes('/api/project-agents?')) return Promise.resolve(agents)
      if (url.includes('/api/project-agent-tasks?')) return Promise.resolve({ tasks: [] })
      if (url.includes('/api/project-agent-activity?')) {
        activityUrls.push(url)
        return Promise.resolve({
          agent_id: 'shared-agent', personal_space_id: 'personal-1',
          from_date: '2026-08-15', to_date: '2026-08-17',
          days: [{ date: '2026-08-15', completed: 1, failed: 0, cancelled: 0, total: 1, tasks: [] }],
        })
      }
      return Promise.resolve([])
    })
    const { wrapper } = await mountPage()
    await flushPromises()

    expect(activityUrls).toHaveLength(1)
    expect(activityUrls[0]).toMatch(/fromDate=\d{4}-\d{2}-\d{2}/)
    expect(activityUrls[0]).toMatch(/toDate=\d{4}-\d{2}-\d{2}/)
    const heatmapViewport = wrapper.get('.project-agent-heatmap-viewport')
    const heatmap = heatmapViewport.get('.project-agent-heatmap')
    const cells = wrapper.findAll('.project-agent-heat-cell')

    // Calendar order: oldest first, weeks padded to Monday..Sunday without fake days
    // (Saturday 8/15 and Sunday 8/16 close one week, Monday 8/17 opens the next).
    expect(cells).toHaveLength(3)
    expect(cells[0].attributes('aria-label')).toContain('8月15日')
    expect(cells[2].attributes('aria-label')).toContain('8月17日')
    expect(wrapper.findAll('.project-agent-heat-pad')).toHaveLength(11)
    expect(wrapper.get('[data-activity-total]').text()).toBe('过去一年 1 次贡献')
    expect(wrapper.get('.project-agent-calendar-months').text()).toBe('8月')
    expect(wrapper.get('.project-agent-calendar-legend').text()).toContain('少')
    expect(cells[1].attributes('aria-label')).toContain('0')
    expect(cells[0].element.tagName).toBe('BUTTON')
    expect(cells[0].attributes('aria-pressed')).toBe('false')
    await cells[0].trigger('click')
    expect(cells[0].attributes('aria-pressed')).toBe('true')
    expect(heatmap.attributes('role')).toBe('list')
    expect(heatmap.element.parentElement).toBe(heatmapViewport.element)
  })

  it('matches recruitment history by recruited Agent and displays its source fields', async () => {
    getJson.mockImplementation((url: string) => {
      if (url.includes('/api/project-agents?')) return Promise.resolve([{
        ...agents[0],
        profile: { ...agents[0].profile, testSource: 'e2e-roster', cleanupEligible: true },
        recruitmentId: 'recruitment-1',
      }])
      if (url.includes('/api/project-agent-tasks?')) return Promise.resolve({ tasks: [] })
      if (url.includes('/api/project-agent-recruitments?')) return Promise.resolve({ recruitments: [{
        recruitment_id: 'recruitment-1', personal_space_id: 'personal-1', personal_project_id: 'project-a',
        task_id: 'task-1', coordinator_agent_id: 'coordinator', hr_agent_id: 'hr-agent',
        position_kind: 'temporary', work_kind: 'one-off', required_capabilities: [], reason_code: 'capacity',
        reason: '一次性终点明确', status: 'fulfilled', confirmation_mode: 'automatic', proposed_agent_id: 'shared-agent',
        recruited_agent_id: 'shared-agent', trigger_source_application: 'codex', test_source: 'e2e-roster',
        cleanup_eligible: true, revision: 1, created_at: '2026-08-16T00:00:00Z', updated_at: '2026-08-16T00:00:00Z', fulfilled_at: '2026-08-16T01:00:00Z',
      }] })
      if (url.includes('/api/project-agent-recruitment-policy?')) return Promise.resolve({ personal_space_id: 'personal-1', confirmation_mode: 'automatic' })
      return Promise.resolve([])
    })
    const { wrapper, router } = await mountPage()
    await flushPromises()
    expect(wrapper.get('[data-agent-identity]').text()).toContain('测试角色')
    await wrapper.get('[data-detail-refresh]').trigger('click')
    await flushPromises()

    const detail = wrapper.get('.project-agent-detail').text()
    expect(detail).toContain('hr-agent')
    expect(detail).toContain('一次性终点明确')
    expect(detail).toContain('e2e-roster')
    expect(detail).toContain('Codex')
    await wrapper.get('[data-agent-cleanup]').trigger('click')
    await flushPromises()
    expect(deleteJson).toHaveBeenCalledWith(expect.stringContaining('/api/project-agents/shared-agent?personalSpaceId=personal-1'))
    // The removed test role has no page left; 编排 takes its place.
    expect(router.currentRoute.value.path).toBe('/project-agents/manage')
  })

  it('keeps space recruitment policy out of personnel detail while approving a pending real event', async () => {
    const recruitment = {
      recruitment_id: 'recruitment-pending', personal_space_id: 'personal-1', personal_project_id: 'project-a',
      task_id: 'task-pending', coordinator_agent_id: 'coordinator', hr_agent_id: 'hr-agent',
      position_kind: 'temporary', work_kind: 'one-off', required_capabilities: [], reason_code: 'no_match',
      reason: '需要一次性工作', status: 'awaiting_confirmation', confirmation_mode: 'require_confirmation',
      proposed_agent_id: 'shared-agent', recruited_agent_id: null, revision: 2,
      created_at: '2026-08-16T00:00:00Z', updated_at: '2026-08-16T00:00:00Z',
    }
    getJson.mockImplementation((url: string) => {
      if (url.includes('/api/project-agents?')) return Promise.resolve(agents)
      if (url.includes('/api/project-agent-tasks?')) return Promise.resolve({ tasks: [] })
      if (url.includes('/api/project-agent-recruitments?')) return Promise.resolve({ recruitments: [recruitment] })
      if (url.includes('/api/project-agent-recruitment-policy?')) return Promise.resolve({ personal_space_id: 'personal-1', confirmation_mode: 'automatic' })
      return Promise.resolve([])
    })
    postJson.mockResolvedValue({})
    const { wrapper } = await mountPage()
    await flushPromises()
    await wrapper.get('[data-detail-refresh]').trigger('click')
    await flushPromises()

    expect(wrapper.find('.project-agent-policy-control').exists()).toBe(false)
    // A decision waiting on the person shows on its tab.
    expect(wrapper.get('[data-manage-tab="recruitment"]').text()).toBe('招聘 1')
    expect(patchJson).not.toHaveBeenCalledWith('/api/project-agent-recruitment-policy', expect.anything())
    await wrapper.get('[data-recruitment-approve]').trigger('click')
    await flushPromises()
    expect(postJson).toHaveBeenCalledWith('/api/project-agent-recruitments/decision', expect.objectContaining({
      recruitmentId: 'recruitment-pending', expectedRevision: 2, decision: 'approve',
    }))
  })

  it('shows strategy-scoped learning evidence and uses the permission revision', async () => {
    getJson.mockImplementation((url: string) => {
      if (url.includes('/api/project-agents?')) return Promise.resolve(agents)
      if (url.includes('/api/project-agent-tasks?')) return Promise.resolve({ tasks: [] })
      if (url.includes('/api/executors?')) return Promise.resolve({ executors: [{
        executor_id: 'executor-1', display_name: '真实执行器', registration_status: 'registered',
        permission_status: 'pending', permission_revision: 2, revision: 7,
        available_models: [{ provider: 'host', model: 'reported-model', available: true }],
      }] })
      if (url.includes('/api/project-agent-routing-learning?')) return Promise.resolve([{
        personal_project_id: 'project-a', work_kind: 'review', agent_id: 'shared-agent',
        executor_id: 'executor-1', model_strategy: { mode: 'deep', reasoning_effort: 'max', capability_hints: [] },
        model_strategy_key: 'strategy-key-1', sample_count: 4, recent_count: 2,
        success_count: 3, rework_count: 1, failure_count: 0, rating_count: 1,
        weighted_success: 2.5, weighted_failure: 0.5, decay_half_life_days: 30,
        as_of: '2026-08-17T03:00:00Z', neutral_due_to_insufficient_evidence: false,
        evidence_contributions: [{
          evidence_id: 'evidence-1', evidence_kind: 'test_passed', signal: 'success',
          value: 1, decay_weight: 0.9, occurred_at: '2026-08-17T02:00:00Z', reference_ids: ['test-1'],
        }],
      }])
      return Promise.resolve([])
    })
    patchJson.mockResolvedValue({})
    postJson.mockResolvedValue({})
    const { wrapper } = await mountPage()
    await flushPromises()
    await wrapper.get('[data-detail-refresh]').trigger('click')
    await flushPromises()

    const learning = wrapper.get('.project-agent-learning-card')
    expect(learning.text()).toContain('4')
    expect(learning.text()).toContain('deep · max')
    expect(learning.text()).toContain('test_passed')
    await wrapper.get('.project-agent-evidence-list button').trigger('click')
    await flushPromises()
    expect(patchJson).toHaveBeenCalledWith('/api/project-agent-learning/evidence-1', expect.objectContaining({
      action: 'ignore', modelStrategyKey: 'strategy-key-1',
    }))

    await wrapper.get('[data-executor-authorize]').trigger('click')
    await flushPromises()
    expect(postJson).toHaveBeenCalledWith('/api/executors/authorization', expect.objectContaining({
      executorId: 'executor-1', expectedRevision: 2, status: 'authorized',
    }))
  })

  it('automatically loads real detail data for the Agent on the page and the next one opened', async () => {
    const secondAgent = {
      ...agents[0],
      agentId: 'second-agent',
      profile: { ...agents[0].profile, name: '最后 Agent' },
      assignments: [],
    }
    getJson.mockImplementation((url: string) => {
      if (url.includes('/api/project-agents?')) return Promise.resolve([...agents, secondAgent])
      if (url.includes('/api/project-agent-tasks?')) return Promise.resolve({ tasks: [] })
      if (url.includes('/api/project-agent-assignments?')) return Promise.resolve({ assignments: [] })
      if (url.includes('/api/project-agent-activity?')) {
        const agentId = new URL(url, 'http://local.test').searchParams.get('agentId')
        return Promise.resolve({ agent_id: agentId, personal_space_id: 'personal-1', days: [] })
      }
      if (url.includes('/api/project-agent-recruitments?')) return Promise.resolve({ recruitments: [] })
      if (url.includes('/api/project-agent-recruitment-policy?')) return Promise.resolve({ personal_space_id: 'personal-1', confirmation_mode: 'automatic' })
      if (url.includes('/api/executors?')) return Promise.resolve({ executors: [] })
      if (url.includes('/api/executor-routing-rules?')) return Promise.resolve({ rules: [] })
      if (url.includes('/api/project-agent-routing-learning?')) return Promise.resolve([])
      return Promise.resolve([])
    })

    const { wrapper, router } = await mountPage()
    await flushPromises()

    expect(getJson.mock.calls.some(([url]) => String(url).includes('/api/project-agent-activity?') && String(url).includes('agentId=shared-agent'))).toBe(true)
    expect(wrapper.get('[data-detail-section="activity"]').text()).toContain('没有已验证的完成、失败或取消历史')

    await router.push('/project-agents/manage/personal-1/second-agent')
    await flushPromises()
    expect(pageTitle.value.text).toBe('最后 Agent')
    expect(getJson.mock.calls.some(([url]) => String(url).includes('/api/project-agent-activity?') && String(url).includes('agentId=second-agent'))).toBe(true)
  })

  it('keeps each detail section in loading or error state until that source reports', async () => {
    let resolveActivity!: (value: unknown) => void
    const activity = new Promise((resolve) => { resolveActivity = resolve })
    getJson.mockImplementation((url: string) => {
      if (url.includes('/api/project-agents?')) return Promise.resolve(agents)
      if (url.includes('/api/project-agent-tasks?')) return Promise.resolve({ tasks: [] })
      if (url.includes('/api/project-agent-assignments?')) return Promise.resolve({ assignments: [] })
      if (url.includes('/api/project-agent-activity?')) return activity
      if (url.includes('/api/project-agent-recruitments?')) return Promise.resolve({ recruitments: [] })
      if (url.includes('/api/project-agent-recruitment-policy?')) return Promise.resolve({ personal_space_id: 'personal-1', confirmation_mode: 'automatic' })
      if (url.includes('/api/executors?')) return Promise.resolve({ executors: [] })
      if (url.includes('/api/executor-routing-rules?')) return Promise.resolve({ rules: [] })
      if (url.includes('/api/project-agent-routing-learning?')) return Promise.resolve([])
      return Promise.resolve([])
    })

    const { wrapper } = await mountPage()
    await flushPromises()

    const loadingActivity = wrapper.get('[data-detail-section="activity"]')
    expect(loadingActivity.get('[role="status"]').text()).toContain('正在读取')
    expect(loadingActivity.text()).not.toContain('没有已验证的完成、失败或取消历史')

    resolveActivity({ agent_id: 'shared-agent', personal_space_id: 'personal-1', days: [] })
    await flushPromises()
    expect(wrapper.get('[data-detail-section="activity"]').text()).toContain('没有已验证的完成、失败或取消历史')
  })

  it('shows a partial detail failure instead of a false empty state', async () => {
    getJson.mockImplementation((url: string) => {
      if (url.includes('/api/project-agents?')) return Promise.resolve(agents)
      if (url.includes('/api/project-agent-tasks?')) return Promise.resolve({ tasks: [] })
      if (url.includes('/api/project-agent-assignments?')) return Promise.resolve({ assignments: [] })
      if (url.includes('/api/project-agent-activity?')) return Promise.reject(new Error('activity unavailable'))
      if (url.includes('/api/project-agent-recruitments?')) return Promise.resolve({ recruitments: [] })
      if (url.includes('/api/project-agent-recruitment-policy?')) return Promise.resolve({ personal_space_id: 'personal-1', confirmation_mode: 'automatic' })
      if (url.includes('/api/executors?')) return Promise.resolve({ executors: [] })
      if (url.includes('/api/executor-routing-rules?')) return Promise.resolve({ rules: [] })
      if (url.includes('/api/project-agent-routing-learning?')) return Promise.resolve([])
      return Promise.resolve([])
    })

    const { wrapper } = await mountPage()
    await flushPromises()

    const activitySection = wrapper.get('[data-detail-section="activity"]')
    expect(activitySection.get('[role="alert"]').text()).toContain('activity unavailable')
    expect(activitySection.text()).not.toContain('没有已验证的完成、失败或取消历史')
    expect(wrapper.get('[data-detail-section="tasks"]').text()).toContain('尚无任务历史')
  })
})

// The browser history keeps the entry a page was opened from (memory history does not).
async function mountPage(bootstrap = false, path = AGENT_PAGE, history = createMemoryHistory()) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const store = useConsoleStore()
  store.runtimeStatus = 'ready'
  store.state = orchestrationState()
  const initialState = store.state
  if (bootstrap) {
    store.state = null
    store.runtimeStatus = 'idle'
  }
  const router = createRouter({ history, routes: [
    { path: '/project-agents/manage', component: { template: '<div data-collection>编排</div>' } },
    { path: '/project-agents/manage/:spaceId/:agentId', component: ProjectAgentDetailPage },
    { path: '/agents/:spaceId/:agentId', component: { template: '<div />' } },
    { path: '/employees/:templateId', component: { template: '<div />' } },
    { path: '/inbox', component: { template: '<div />' } },
  ] })
  await router.push(path)
  const wrapper = mount(RouterView, { global: { plugins: [pinia, router], stubs: { UiSelect: UiSelectStub } } })
  mounted.push(wrapper)
  return { store, initialState, router, wrapper }
}
