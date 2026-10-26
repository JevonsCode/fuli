import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'

const getJson = vi.hoisted(() => vi.fn())
const patchJson = vi.hoisted(() => vi.fn())
const postJson = vi.hoisted(() => vi.fn())
const deleteJson = vi.hoisted(() => vi.fn())

vi.mock('@/api/client', () => ({ getJson, patchJson, postJson, deleteJson, putJson: vi.fn() }))

import { useConsoleStore } from '@/stores/console'
import { t } from '@/i18n'
import { UiSelectStub } from '@/test-support/UiSelectStub'
import { orchestrationAgents as agents, orchestrationResponse, orchestrationState } from '@/test-support/orchestration-fixtures'
import ProjectAgentDialog from '@/features/projects/ProjectAgentDialog.vue'
import ProjectAgentsPage from './ProjectAgentsPage.vue'
import { refreshEmployeeCatalog } from '@/features/employees/catalog'

const mounted: Array<{ unmount: () => void }> = []
const dialog = () => document.querySelector('[data-agent-peek-dialog]') as HTMLElement | null

describe('ProjectAgentsPage (编排 collection)', () => {
  beforeEach(async () => {
    await refreshEmployeeCatalog('')
    getJson.mockReset()
    patchJson.mockReset()
    postJson.mockReset()
    deleteJson.mockReset()
    getJson.mockImplementation(orchestrationResponse)
  })
  afterEach(() => mounted.splice(0).forEach((wrapper) => wrapper.unmount()))

  it('shows one card per Agent, merging its project rows, with no detail beside the list', async () => {
    const { wrapper } = await mountPage()
    await flushPromises()

    expect(getJson).toHaveBeenCalledWith('/api/project-agents?personalSpaceId=personal-1')
    const cards = wrapper.findAll('.project-agent-card')
    expect(cards).toHaveLength(1)
    expect(cards[0]!.get('[data-agent-manage-link]').attributes('href')).toBe('/project-agents/manage/personal-1/shared-agent')
    expect(cards[0]!.get('[data-agent-type]').text()).toBe('长期')
    // Only a membership other than available is called out, as in the directory.
    expect(cards[0]!.find('[data-agent-status]').exists()).toBe(false)
    expect(cards[0]!.get('.project-agent-row-projects').text()).toContain('活动项目')
    expect(cards[0]!.get('.project-agent-row-projects').text()).toContain('设计项目')
    expect(cards[0]!.get('.project-agent-row-work').text()).toContain('无运行记录')
    // The management workspace is the Agent's own page now: nothing here reads it.
    expect(wrapper.find('[data-detail-section]').exists()).toBe(false)
    expect(getJson.mock.calls.some(([url]) => String(url).includes('agentId='))).toBe(false)
    expect(wrapper.get('.project-agents-header-meta').text()).toContain('2 个分配')
    // Every Agent is built in: the page offers no hiring step.
    expect(wrapper.findAll('button').map((button) => button.text())).not.toContain('聘请 Agent')
    expect(wrapper.text()).not.toContain('聘请')
  })

  it('explains how to start the first task while no project exists', async () => {
    const { wrapper, store } = await mountPage()
    store.state = { ...store.state!, personalProjects: [] }
    await flushPromises()
    const firstTask = wrapper.get('.project-agent-first-task')
    expect(firstTask.text()).toContain('开始第一个任务')
    expect(firstTask.text()).toContain('安排负责的 Agent')
    store.state = { ...store.state!, personalProjects: orchestrationState().personalProjects }
    await nextTick()
    expect(wrapper.find('.project-agent-first-task').exists()).toBe(false)
  })

  it('starts with loading during console bootstrap, never a false empty roster', async () => {
    let finishBootstrap!: (value: unknown) => void
    let finishRoster!: (value: unknown) => void
    getJson.mockImplementation((url: string) => {
      if (url === '/api/state') return new Promise(resolve => { finishBootstrap = resolve })
      if (url.includes('/api/project-agents?')) return new Promise(resolve => { finishRoster = resolve })
      return orchestrationResponse(url)
    })
    const { wrapper, store, initialState } = await mountPage(true)
    expect(wrapper.get('.growth-loading--page').attributes('role')).toBe('status')
    expect(wrapper.find('.project-agents-state strong').exists()).toBe(false)
    expect(wrapper.find('.project-agents-header-meta').exists()).toBe(false)
    finishBootstrap(initialState)
    await flushPromises()
    expect(store.runtimeStatus).toBe('ready')
    expect(wrapper.get('.growth-loading--page').attributes('role')).toBe('status')
    finishRoster(agents)
    await flushPromises()
    expect(wrapper.findAll('.project-agent-card')).toHaveLength(1)
  })

  it('shows bootstrap failure and retries initialization instead of claiming no Agents', async () => {
    getJson.mockImplementation((url: string) => url === '/api/state'
      ? Promise.reject(new Error('initialization unavailable')) : orchestrationResponse(url))
    const { wrapper, initialState } = await mountPage(true)
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('initialization unavailable')
    expect(wrapper.find('.project-agents-state strong').exists()).toBe(false)
    getJson.mockImplementation((url: string) => url === '/api/state'
      ? Promise.resolve(initialState) : orchestrationResponse(url))
    await wrapper.get('[role="alert"] button').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('.project-agent-card')).toHaveLength(1)
  })

  it('ignores a pending roster after the personal space is removed', async () => {
    let finishRoster!: (value: unknown) => void
    getJson.mockImplementation((url: string) => url.includes('/api/project-agents?')
      ? new Promise(resolve => { finishRoster = resolve }) : orchestrationResponse(url))
    const { wrapper, store } = await mountPage()
    store.state = { ...store.state!, personalSpaces: [], activePersonalSpaceId: null }
    await nextTick()
    const calls = getJson.mock.calls.length
    finishRoster(agents)
    await flushPromises()
    expect(wrapper.findAll('.project-agent-card')).toHaveLength(0)
    expect(getJson.mock.calls).toHaveLength(calls)
  })

  it('shows request errors and retries the roster load', async () => {
    getJson.mockRejectedValueOnce(new Error('provider unavailable'))
    const { wrapper } = await mountPage()
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('provider unavailable')
    getJson.mockResolvedValueOnce(agents)
    await wrapper.get('[role="alert"] button').trigger('click')
    await flushPromises()
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(wrapper.findAll('.project-agent-card')).toHaveLength(1)
  })

  it('filters by project, status and search, keeping every filter in the URL', async () => {
    const { wrapper, router } = await mountPage()
    await flushPromises()

    const filter = wrapper.get('.project-agents-project-filter')
    await filter.get('.project-scope-trigger').trigger('click')
    await filter.get('input[value="project-a"]').setValue(false)
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/project-agents/manage?project=project-b')
    expect(wrapper.findAll('.project-agent-card')).toHaveLength(1)
    expect(wrapper.get('.project-agent-automation-policy').text()).toContain('设计项目')

    await filter.get('.project-scope-all input').setValue(true)
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({})
    expect(wrapper.find('.project-agent-automation-policy').exists()).toBe(false)
    await filter.get('.project-scope-footer button').trigger('click')
    await wrapper.get('.project-agents-status-filter button:nth-child(2)').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({ status: 'active' })
    expect(wrapper.findAll('.project-agent-card')).toHaveLength(1)

    await wrapper.get('.project-agents-status-filter button:nth-child(3)').trigger('click')
    await flushPromises()
    expect(wrapper.get('.project-agents-state strong').text()).toBe('没有匹配的 Agent')

    await wrapper.get('.project-agents-status-filter button:first-child').trigger('click')
    await wrapper.get('input[type="search"]').setValue('可用性')
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({ q: '可用性' })
    expect(wrapper.findAll('.project-agent-card')).toHaveLength(1)
    await wrapper.get('input[type="search"]').setValue('不存在的职责')
    await flushPromises()
    expect(wrapper.findAll('.project-agent-card')).toHaveLength(0)
  })

  it('opens with the filters a link (or Back) carries', async () => {
    const { wrapper } = await mountPage(false, '/project-agents/manage?project=project-b&status=inactive&q=%E5%8F%AF%E7%94%A8%E6%80%A7')
    await flushPromises()
    expect((wrapper.get('input[type="search"]').element as HTMLInputElement).value).toBe('可用性')
    expect(wrapper.get('.project-agents-status-filter [aria-pressed="true"]').text()).toBe('停用')
    expect(wrapper.get('.project-scope-trigger').text()).toContain('设计项目')
    // The merged Agent is active, so an inactive filter has nothing to show.
    expect(wrapper.findAll('.project-agent-card')).toHaveLength(0)
  })

  it('supports all, multiple project filters, and inversion without writing assignments', async () => {
    const { wrapper, store } = await mountPage()
    store.state = { ...store.state!, personalProjects: [...store.state!.personalProjects!, { project_id: 'project-c', personal_space_id: 'personal-1', profile: { name: '第三个项目', sources: [], boundaries: [] } }] }
    await flushPromises()
    const filter = wrapper.get('.project-agents-project-filter')
    await filter.get('.project-scope-trigger').trigger('click')
    await filter.get('input[value="project-c"]').setValue(false)
    await flushPromises()
    expect(filter.get('.project-scope-trigger').text()).toContain('已选 2 个项目')
    expect(wrapper.findAll('.project-agent-card')).toHaveLength(1)
    expect(wrapper.find('.project-agent-automation-policy').exists()).toBe(false)
    await filter.get('.project-scope-bulk button').trigger('click')
    await flushPromises()
    expect(filter.get('.project-scope-trigger').text()).toContain('第三个项目')
    expect(wrapper.findAll('.project-agent-card')).toHaveLength(0)
    await filter.get('.project-scope-all input').setValue(true)
    await flushPromises()
    expect(wrapper.findAll('.project-agent-card')).toHaveLength(1)
    expect(postJson).not.toHaveBeenCalled()
    expect(patchJson).not.toHaveBeenCalled()
  })

  it('does not count ended assignments as current projects', async () => {
    const endedAgent = structuredClone(agents[0]!)
    endedAgent.assignments![0]!.status = 'ended'
    getJson.mockImplementation((url: string) => url.includes('/api/project-agents?')
      ? Promise.resolve([endedAgent]) : orchestrationResponse(url))
    const { wrapper } = await mountPage()
    await flushPromises()
    expect(wrapper.get('.project-agent-row-projects').text()).toContain('尚未分配项目')
    expect(wrapper.get('.project-agents-header-meta').text()).toContain('0 个分配')
    const filter = wrapper.get('.project-agents-project-filter')
    await filter.get('.project-scope-trigger').trigger('click')
    await filter.get('input[value="project-b"]').setValue(false)
    await flushPromises()
    expect(wrapper.findAll('.project-agent-card')).toHaveLength(0)
  })

  it('shows an initial real run from the space task list on the card, linked to that task', async () => {
    getJson.mockImplementation((url: string) => {
      if (url.includes('/api/project-agents?')) return Promise.resolve(agents)
      if (url.includes('/api/project-agent-tasks?')) return Promise.resolve({ tasks: [{
        task_id: 'task-running', title: '正在整理活动复盘', personal_project_id: 'project-a', status: 'running', run_id: 'run-running',
        participants: [{ agent_id: 'shared-agent', role: 'lead', status: 'running' }],
      }] })
      return Promise.resolve([])
    })
    const { wrapper } = await mountPage()
    await flushPromises()
    const work = wrapper.get('.project-agent-row-work')
    expect(work.text()).toContain('正在整理活动复盘')
    expect(work.text()).toContain('运行中')
    expect(work.get('a').attributes('href')).toBe('/project-agents/manage/personal-1/shared-agent?task=task-running')
  })

  it('keeps blocked work visible on the card', async () => {
    getJson.mockImplementation((url: string) => {
      if (url.includes('/api/project-agents?')) return Promise.resolve(agents)
      if (url.includes('/api/project-agent-tasks?')) return Promise.resolve({ tasks: [{
        task_id: 'task-blocked', title: '等待已锁定执行器', personal_project_id: 'project-a', status: 'blocked',
        participants: [{ agent_id: 'shared-agent', role: 'lead', status: 'blocked' }],
      }] })
      return Promise.resolve([])
    })
    const { wrapper } = await mountPage()
    await flushPromises()
    expect(wrapper.get('.project-agent-row-work').text()).toContain('等待已锁定执行器')
  })

  it('shows the occupation emoji as the card portrait', async () => {
    getJson.mockImplementation((url: string) => url.includes('/api/project-agents?')
      ? Promise.resolve([{ ...agents[0], profile: { ...agents[0]!.profile, occupationEmoji: '🎛️' } }])
      : orchestrationResponse(url))
    const { wrapper } = await mountPage()
    await flushPromises()
    const card = wrapper.get('.project-agent-card')
    expect(card.get('[role="img"]').text()).toBe('🎛️')
    expect(card.text()).toContain('活动 Agent')
    expect(card.text()).toContain('负责活动方案与复盘。')
  })

  it('groups same-named projects on a card instead of repeating the name', async () => {
    const agent = structuredClone(agents[0]!)
    agent.assignments = ['conv-1', 'conv-2', 'conv-3'].map(projectId => ({
      ...agent.assignments![0]!, assignmentId: `assignment-${projectId}`, personalProjectId: projectId,
    }))
    getJson.mockImplementation((url: string) => url.includes('/api/project-agents?')
      ? Promise.resolve([agent]) : orchestrationResponse(url))
    const { wrapper, store } = await mountPage()
    store.state = { ...store.state!, personalProjects: [...store.state!.personalProjects!, ...['conv-1', 'conv-2', 'conv-3'].map(projectId => ({
      project_id: projectId, personal_space_id: 'personal-1', profile: { name: '会话项目', sources: [], boundaries: [] },
    }))] }
    await flushPromises()
    const chips = wrapper.get('.project-agent-row-projects').findAll('[data-slot="badge"]')
    expect(chips.map(chip => chip.text())).toEqual(['会话项目 ×3'])
  })

  it.each([
    ['an Agent and its task', '/project-agents/manage?agent=shared-agent&project=project-a&task=task-a#task-task-a',
      '/project-agents/manage/personal-1/shared-agent?project=project-a&task=task-a#task-task-a'],
    ['an Agent alone', '/project-agents/manage?agent=shared-agent', '/project-agents/manage/personal-1/shared-agent'],
  ])('opens the Agent page for an older link naming %s', async (_case, link, page) => {
    const { router } = await mountPage(false, link)
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe(page)
  })

  it('opens the page of the Agent doing a linked task when the link names no Agent', async () => {
    getJson.mockImplementation((url: string) => url.includes('/api/project-agent-tasks?')
      ? Promise.resolve({ tasks: [{ task_id: 'task-open', title: '打开的任务', personal_project_id: 'project-a', status: 'running',
        participants: [{ agent_id: 'shared-agent', role: 'lead', status: 'running' }] }] })
      : orchestrationResponse(url))
    const { router } = await mountPage(false, '/project-agents/manage?project=project-a&task=task-open')
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/project-agents/manage/personal-1/shared-agent?project=project-a&task=task-open')
  })

  it.each([
    ['completed', { status: 'completed' }],
    ['failed', { status: 'failed' }],
    ['cancelled', { status: 'cancelled' }],
    ['outside the open-work list', { status: 'running' }],
  ])('opens the Agent page for a task-only link to a %s task, read on its own', async (_case, fields) => {
    getJson.mockImplementation((url: string) => {
      if (url.startsWith('/api/project-agent-tasks/old-task?')) return Promise.resolve({
        task_id: 'old-task', title: '已结束的任务', personal_space_id: 'personal-1', personal_project_id: 'project-a',
        owner_agent_id: 'shared-agent', participants: [{ agent_id: 'shared-agent', role: 'lead', status: fields.status }], ...fields,
      })
      return orchestrationResponse(url)
    })
    const { router } = await mountPage(false, '/project-agents/manage?task=old-task')
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/project-agents/manage/personal-1/shared-agent?task=old-task')
    expect(getJson).toHaveBeenCalledWith('/api/project-agent-tasks/old-task?personalSpaceId=personal-1')
  })

  it.each([
    ['does not exist', () => Promise.reject(new Error('not found'))],
    ['belongs to another space', () => Promise.resolve({ task_id: 'old-task', title: '别处的任务', personal_space_id: 'personal-2',
      status: 'completed', owner_agent_id: 'shared-agent', participants: [] })],
    ['names no Agent of this space', () => Promise.resolve({ task_id: 'old-task', title: '外来任务', personal_space_id: 'personal-1',
      status: 'completed', owner_agent_id: 'stranger', participants: [{ agent_id: 'stranger', role: 'lead', status: 'completed' }] })],
  ])('stays on the collection and says so when a linked task %s', async (_case, answer) => {
    getJson.mockImplementation((url: string) => url.startsWith('/api/project-agent-tasks/old-task?')
      ? answer() : orchestrationResponse(url))
    const { wrapper, router } = await mountPage(false, '/project-agents/manage?task=old-task')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/project-agents/manage')
    expect(wrapper.get('[data-task-link-unavailable]').text()).toBe(t('projectAgents.taskLinkUnavailable'))
    expect(wrapper.findAll('.project-agent-card')).toHaveLength(1)
  })

  it('creating an Agent opens its page', async () => {
    const { wrapper, router } = await mountPage()
    await flushPromises()
    wrapper.getComponent(ProjectAgentDialog).vm.$emit('saved', { ...agents[0], agentId: 'new-agent', profile: { ...agents[0]!.profile, name: '新 Agent' } })
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/project-agents/manage/personal-1/new-agent')
  })
})

describe('ProjectAgentsPage quick look (Peek)', () => {
  beforeEach(async () => {
    await refreshEmployeeCatalog('')
    getJson.mockReset()
    getJson.mockImplementation(orchestrationResponse)
  })
  afterEach(() => mounted.splice(0).forEach((wrapper) => wrapper.unmount()))

  it('opens from a card, keeps the Agent in the URL, lifts that card and closes back to the same filters', async () => {
    const { router, wrapper } = await mountPage(false, '/project-agents/manage?status=active')
    await flushPromises()
    await wrapper.get('[data-agent-peek]').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({ status: 'active', item: 'personal-1/shared-agent' })
    expect(dialog()?.textContent).toContain('活动 Agent')
    expect(dialog()?.textContent).toContain('负责活动方案与复盘。')
    expect(dialog()?.textContent).toContain('设计项目')
    expect(dialog()?.querySelector('[data-peek-open-full]')?.textContent).toContain(t('agentProfiles.openFullPage'))
    expect(dialog()?.querySelector('[data-peek-edit]')?.textContent?.trim()).toBe('编辑')
    // 编排's quick change is editing; the directory's pin is not offered here.
    expect(dialog()?.querySelector('[data-peek-pin]')).toBeNull()
    expect(wrapper.get('.project-agent-card').attributes('data-selected')).toBe('true')
    dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/project-agents/manage?status=active')
    expect(dialog()).toBeNull()
    expect(wrapper.get('.project-agent-card').attributes('data-selected')).toBeUndefined()
  })

  it('opens a shared link once the roster is read, and its full page replaces the quick look', async () => {
    const { router } = await mountPage(false, '/project-agents/manage?item=personal-1%2Fshared-agent')
    await flushPromises()
    expect(dialog()?.textContent).toContain('活动 Agent')
    // The roster arrived after the Peek opened; focus still lands on the main action.
    expect(document.activeElement?.hasAttribute('data-peek-open-full')).toBe(true)
    ;(dialog()!.querySelector('[data-peek-open-full]') as HTMLButtonElement).click()
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/project-agents/manage/personal-1/shared-agent')
  })

  it('edits from the quick look only after the quick look has closed', async () => {
    const { router, wrapper } = await mountPage(false, '/project-agents/manage?item=personal-1%2Fshared-agent')
    await flushPromises()
    ;(dialog()!.querySelector('[data-peek-edit]') as HTMLButtonElement).click()
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({})
    expect(dialog()).toBeNull()
    const edit = wrapper.getComponent(ProjectAgentDialog)
    expect(edit.props('open')).toBe(true)
    expect(edit.props('agent')?.agentId).toBe('shared-agent')
  })

  it('never shows an Agent from another space', async () => {
    await mountPage(false, '/project-agents/manage?item=personal-2%2Fshared-agent')
    await flushPromises()
    expect(dialog()?.textContent).toContain(t('agentProfiles.unavailable'))
    expect(dialog()?.textContent).not.toContain('活动 Agent')
  })
})

async function mountPage(bootstrap = false, path = '/project-agents/manage') {
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
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/project-agents/manage', component: ProjectAgentsPage },
    { path: '/project-agents/manage/:spaceId/:agentId', component: { template: '<div data-agent-page>Agent page</div>' } },
    { path: '/employees/:templateId', component: { template: '<div />' } },
    { path: '/inbox', component: { template: '<div />' } },
  ] })
  await router.push(path)
  const wrapper = mount(RouterView, { attachTo: document.body, global: { plugins: [pinia, router], stubs: { UiSelect: UiSelectStub } } })
  mounted.push(wrapper)
  return { store, initialState, router, wrapper }
}
