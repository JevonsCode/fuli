import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'
import type { ConsoleState } from '@/types'
const { getJson, patchJson, postJson } = vi.hoisted(() => ({ getJson: vi.fn(), patchJson: vi.fn(), postJson: vi.fn() }))
vi.mock('@/api/client', () => ({ getJson, patchJson, postJson }))
import EmployeeWorkbenchPage from './EmployeeWorkbenchPage.vue'
import { useConsoleStore } from '@/stores/console'
import { refreshEmployeeCatalog } from '@/features/employees/catalog'
import EmployeeTaskBoard from '@/features/employees/EmployeeTaskBoard.vue'
import EmployeeRecruitDialog from '@/features/employees/EmployeeRecruitDialog.vue'
import EmployeeTaskDialog from '@/features/employees/EmployeeTaskDialog.vue'
import BolePeoplePanel from '@/features/employees/BolePeoplePanel.vue'
import { projectBoardFilterKey } from '@/features/employees/project-board-filter'

const mounted: Array<{ unmount: () => void }> = []
function defaultConsoleState(): ConsoleState {
  return {
    mode: 'connected', activePersonalSpaceId: 'space-a',
    personalSpaces: [{ id: 'space-a', name: '我' }],
    personalProjects: [{ project_id: 'project-a', personal_space_id: 'space-a', profile: { name: '验收项目', sources: [], boundaries: [] } }],
    projects: [], subscriptions: [],
  }
}
beforeEach(async () => {
  setActivePinia(createPinia())
  const store = useConsoleStore()
  store.state = defaultConsoleState()
  store.runtimeStatus = 'ready'
  localStorage.clear()
  await refreshEmployeeCatalog('')
  getJson.mockReset()
  patchJson.mockReset()
  postJson.mockReset()
  postJson.mockImplementation(async (_url: string, body: { personalProjectId: string }) => ({
    project: { id: body.personalProjectId, name: body.personalProjectId },
    items: [], total: 0, truncated: false,
  }))
  getJson.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/employee-templates?')) return { templates: [{
      id: 'jefa', name: 'Jefa', role: '项目经理', runtime: { apiVersion: 1 }, runtimeStatus: 'ready',
      capabilities: ['项目管理'], permissions: ['board.read', 'board.write'], agentId: 'employee.jefa', agentStatus: 'active', assignmentsVersion: 'version-1',
      assignments: [{ personalProjectId: 'project-a', status: 'active' }],
    }] }
    if (!url.includes('personalProjectId=project-a')) throw new Error(JSON.stringify({ code: 'assignment_required' }))
    return { templateId: 'jefa', name: 'Jefa', project: { id: 'project-a', name: '验收项目' }, runtimeStatus: 'ready', workbenchUrl: '/employee-workspaces/jefa/project-a/' }
  })
})
afterEach(() => { for (const wrapper of mounted.splice(0)) wrapper.unmount() })

async function setup(path: string) {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/employees/:templateId', component: EmployeeWorkbenchPage }] })
  await router.push(path)
  const wrapper = mount(EmployeeWorkbenchPage, { global: { plugins: [router] } })
  mounted.push(wrapper)
  await flushPromises()
  return wrapper
}
describe('employee workbench', () => {
  it('waits for console bootstrap, then loads the catalog and board in order', async () => {
    const store = useConsoleStore()
    store.state = null
    store.runtimeStatus = 'idle'
    let finishBootstrap!: (value: ConsoleState) => void
    const original = getJson.getMockImplementation()!
    getJson.mockImplementation((url: string) => url === '/api/state'
      ? new Promise(resolve => { finishBootstrap = resolve }) : original(url))

    const wrapper = await setup('/employees/jefa')
    expect(wrapper.find('.growth-loading[role="status"]').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('这位专属 Agent 暂不可用')

    void store.refresh()
    finishBootstrap(defaultConsoleState())
    await flushPromises()

    expect(store.runtimeStatus).toBe('ready')
    expect(wrapper.findComponent(EmployeeTaskBoard).exists()).toBe(true)
    expect(getJson.mock.calls.some(([url]) => String(url).startsWith('/api/employee-templates?'))).toBe(true)
  })

  it('shows bootstrap failure with retry instead of claiming the Agent is unavailable', async () => {
    const store = useConsoleStore()
    store.state = null
    store.runtimeStatus = 'idle'
    const original = getJson.getMockImplementation()!
    getJson.mockImplementation((url: string) => url === '/api/state'
      ? Promise.reject(new Error('bootstrap unavailable')) : original(url))

    const wrapper = await setup('/employees/jefa')
    void store.refresh()
    await flushPromises()

    expect(store.runtimeStatus).toBe('error')
    expect(wrapper.get('[role="alert"]').text()).toContain('bootstrap unavailable')
    expect(wrapper.text()).not.toContain('这位专属 Agent 暂不可用')

    getJson.mockImplementation((url: string) => url === '/api/state'
      ? Promise.resolve(defaultConsoleState()) : original(url))
    await wrapper.get('[role="alert"] button').trigger('click')
    await flushPromises()
    expect(wrapper.findComponent(EmployeeTaskBoard).exists()).toBe(true)
  })

  it('reloads when the managed project IDs change, but not for an identical catalog refresh', async () => {
    const wrapper = await setup('/employees/jefa')
    const boardCalls = () => postJson.mock.calls.filter(([, body]) => body.tool === 'read_board')
    const initialCalls = boardCalls().length
    const original = getJson.getMockImplementation()!

    await refreshEmployeeCatalog('space-a')
    await flushPromises()
    expect(boardCalls()).toHaveLength(initialCalls)

    getJson.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/employee-templates?')) return { templates: [{
        id: 'jefa', name: 'Jefa', role: '项目经理', runtime: { apiVersion: 1 }, runtimeStatus: 'ready',
        capabilities: ['项目管理'], permissions: ['board.read', 'board.write'], agentId: 'employee.jefa', agentStatus: 'active', assignmentsVersion: 'version-2',
        assignments: [], managedProjects: [{ id: 'project-b', name: '新负责项目' }],
      }] }
      return original(url)
    })
    await refreshEmployeeCatalog('space-a')
    await flushPromises()

    expect(boardCalls()).toHaveLength(initialCalls + 1)
    expect(boardCalls().at(-1)?.[1]).toMatchObject({ personalProjectId: 'project-b' })
  })

  it('restores saved filters through the real board and only clears them on reset', async () => {
    const first = await setup('/employees/jefa?project=project-a')
    await first.get('.employee-all-projects-filter .project-scope-trigger').trigger('click')
    await first.get('.employee-all-projects-filter input[value="project-a"]').setValue(false)
    await flushPromises()
    first.unmount()
    const reopened = await setup('/employees/jefa?project=all')
    expect(reopened.getComponent(EmployeeTaskBoard).props('visibleProjectIds')).toEqual([])
    expect(reopened.get('.project-scope-trigger').text()).toContain('已选 0 / 共 1 个项目')
    expect(JSON.parse(localStorage.getItem(projectBoardFilterKey('space-a'))!).projectIds).toEqual([])
    await reopened.get('.project-scope-trigger').trigger('click')
    await reopened.get('.project-scope-reset').trigger('click')
    await flushPromises()
    expect(reopened.getComponent(EmployeeTaskBoard).props('visibleProjectIds')).toEqual(['project-a'])
    expect(reopened.vm.$route.query.project).toBe('all')
    expect(localStorage.getItem(projectBoardFilterKey('space-a'))).toBeNull()
  })
  it('uses effective all-project membership without inventing a Provider assignment', async () => {
    const original = getJson.getMockImplementation()!
    getJson.mockImplementation(async (url: string) => {
      const result = await original(url)
      if (url.startsWith('/api/employee-templates?')) {
        result.templates[0].assignments = []
        result.templates[0].managedProjects = [{ id: 'project-a', name: '自动纳入的新项目' }]
      }
      return result
    })
    const wrapper = await setup('/employees/jefa')
    expect(wrapper.find('iframe').exists()).toBe(false)
    expect(wrapper.get('.employee-all-projects-heading h2').text()).toBe('任务看板')
    expect(wrapper.get('.employee-all-projects-filter .project-scope-trigger').text()).toContain('已选 1 / 共 1 个项目')
    expect(wrapper.vm.$route.query.project).toBe('all')
  })
  it('keeps a single-project Jefa view on the native all-project board', async () => {
    const wrapper = await setup('/employees/jefa?project=project-a')
    expect(wrapper.findComponent(EmployeeTaskBoard).exists()).toBe(true)
    expect(wrapper.find('iframe').exists()).toBe(false)
    expect(wrapper.getComponent(EmployeeTaskBoard).props('visibleProjectIds')).toEqual(['project-a'])
    expect(wrapper.vm.$route.query.project).toBe('project-a')
    expect(wrapper.get('h1').text()).toBe('Jefa 项目经理')
    expect(wrapper.text()).not.toContain('员工工作台')
    expect(postJson.mock.calls.some(([, body]) => body.tool === 'read_board' && body.personalProjectId === 'project-a')).toBe(true)
  })
  it('aggregates every managed project and opens a task in its exact project', async () => {
    const original = getJson.getMockImplementation()!
    getJson.mockImplementation(async (url: string) => {
      if (url.includes('personalProjectId=project-b')) return {
        templateId: 'jefa', name: 'Jefa', project: { id: 'project-b', name: '第二项目' },
        runtimeStatus: 'ready', workbenchUrl: '/employee-workspaces/jefa/project-b/',
      }
      const result = await original(url)
      if (url.startsWith('/api/employee-templates?')) result.templates[0].managedProjects = [
        { id: 'project-a', name: '验收项目' },
        { id: 'project-b', name: '第二项目' },
      ]
      return result
    })
    postJson.mockImplementation(async (_url: string, body: { personalProjectId: string; tool: string; arguments?: { workItemId?: string } }) => {
      const title = body.personalProjectId === 'project-a' ? '整理验收' : '准备发布'
      if (body.tool === 'get_task') return {
        item: {
          id: body.arguments?.workItemId,
          projectId: body.personalProjectId,
          title,
          summary: `${title}说明`,
          status: 'planned',
          updatedAt: '2026-09-03T00:00:00.000Z',
          tags: ['agent'],
        },
      }
      return {
        project: { id: body.personalProjectId, name: body.personalProjectId },
        items: [{
          id: `task-${body.personalProjectId}`, projectId: body.personalProjectId,
          title, status: 'planned', updatedAt: '2026-09-03T00:00:00.000Z', tags: ['agent'],
        }],
        total: 1,
        truncated: false,
      }
    })
    const wrapper = await setup('/employees/jefa?project=project-a&project=project-b')
    expect(wrapper.find('iframe').exists()).toBe(false)
    expect(wrapper.get('.employee-all-projects-heading h2').text()).toBe('任务看板')
    expect(wrapper.vm.$route.query.project).toEqual(['project-a', 'project-b'])
    const boardCalls = () => postJson.mock.calls.filter(([, body]) => body.tool === 'read_board')
    expect(boardCalls()).toHaveLength(2)
    expect(boardCalls().map(([, body]) => body.personalProjectId)).toEqual(['project-a', 'project-b'])
    await wrapper.get('[aria-label="在 第二项目 中查看任务：准备发布"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('iframe').exists()).toBe(false)
    expect(wrapper.getComponent(EmployeeTaskDialog).props('open')).toBe(true)
    expect(wrapper.getComponent(EmployeeTaskDialog).props('item')).toMatchObject({ id: 'task-project-b', projectId: 'project-b' })
    expect(postJson).toHaveBeenLastCalledWith('/api/employee-templates/jefa/call', {
      personalSpaceId: 'space-a',
      personalProjectId: 'project-b',
      tool: 'get_task',
      arguments: { workItemId: 'task-project-b' },
    })
  })
  it('hides unchecked projects and supports inversion without changing the managed scope', async () => {
    const original = getJson.getMockImplementation()!
    getJson.mockImplementation(async (url: string) => {
      const result = await original(url)
      if (url.startsWith('/api/employee-templates?')) result.templates[0].managedProjects = [
        { id: 'project-a', name: '验收项目' },
        { id: 'project-b', name: '第二项目' },
      ]
      return result
    })
    postJson.mockImplementation(async (_url: string, body: { personalProjectId: string }) => ({
      project: { id: body.personalProjectId, name: body.personalProjectId },
      items: [{
        id: `task-${body.personalProjectId}`, projectId: body.personalProjectId,
        title: body.personalProjectId === 'project-a' ? '整理验收' : '准备发布', status: 'planned',
      }],
      total: 1,
      truncated: false,
    }))
    const wrapper = await setup('/employees/jefa?project=__all__')
    expect(wrapper.vm.$route.query.project).toBe('all')
    await wrapper.get('.employee-all-projects-filter .project-scope-trigger').trigger('click')
    await wrapper.get('.employee-all-projects-filter input[value="project-b"]').setValue(false)
    expect(wrapper.text()).toContain('整理验收')
    expect(wrapper.text()).not.toContain('准备发布')
    await wrapper.get('.employee-all-projects-filter .project-scope-bulk button').trigger('click')
    expect(wrapper.text()).not.toContain('整理验收')
    expect(wrapper.text()).toContain('准备发布')
    await wrapper.get('.employee-all-projects-filter .project-scope-all input').setValue(true)
    await wrapper.get('.employee-all-projects-filter .project-scope-all input').setValue(false)
    expect(wrapper.text()).toContain('没有显示任何项目')
    await flushPromises()
    expect(wrapper.vm.$route.query.empty).toBe('1')
    await wrapper.get('.employee-all-projects-empty button').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('整理验收')
    expect(wrapper.text()).toContain('准备发布')
    expect(postJson.mock.calls.filter(([, body]) => body.tool === 'read_board')).toHaveLength(2)
    expect(wrapper.vm.$route.query.project).toBe('all')
  })
  it('moves a task on the aggregate board through its owning project', async () => {
    const original = getJson.getMockImplementation()!
    getJson.mockImplementation(async (url: string) => {
      const result = await original(url)
      if (url.startsWith('/api/employee-templates?')) result.templates[0].managedProjects = [
        { id: 'project-a', name: '验收项目' },
        { id: 'project-b', name: '第二项目' },
      ]
      return result
    })
    postJson.mockImplementation(async (_url: string, body: { personalProjectId: string; tool: string; arguments?: { updates?: Array<{ status: string }> } }) => {
      if (body.tool === 'update_tasks') return {
        updatedWorkItems: [{
          id: 'task-project-b', projectId: 'project-b', title: '准备发布', status: body.arguments?.updates?.[0]?.status,
          updatedAt: '2026-09-03T01:00:00.000Z',
        }],
      }
      return {
        project: { id: body.personalProjectId, name: body.personalProjectId },
        items: [{
          id: `task-${body.personalProjectId}`, projectId: body.personalProjectId,
          title: body.personalProjectId === 'project-a' ? '整理验收' : '准备发布', status: 'planned',
          updatedAt: '2026-09-03T00:00:00.000Z',
        }],
        total: 1,
        truncated: false,
      }
    })
    const wrapper = await setup('/employees/jefa')
    const board = wrapper.getComponent(EmployeeTaskBoard)
    const item = board.props('boards').find((entry) => entry.project.id === 'project-b')!.items[0]
    board.vm.$emit('move-task', item, 'active')
    await flushPromises()
    expect(postJson).toHaveBeenLastCalledWith('/api/employee-templates/jefa/call', {
      personalSpaceId: 'space-a',
      personalProjectId: 'project-b',
      tool: 'update_tasks',
      arguments: {
        requestId: expect.stringMatching(/^aggregate-board-move-/),
        updates: [{
          id: 'task-project-b',
          status: 'active',
          expectedUpdatedAt: '2026-09-03T00:00:00.000Z',
        }],
      },
    })
    expect(board.props('boards').find((entry) => entry.project.id === 'project-b')!.items[0].status).toBe('active')
  })
  it('uses Jefa human confirmation when a task is moved to done', async () => {
    postJson.mockImplementation(async (_url: string, body: { personalProjectId: string }) => ({
      project: { id: body.personalProjectId, name: body.personalProjectId },
      items: [{
        id: 'task-project-a', projectId: 'project-a', title: '确认发布', status: 'review',
        updatedAt: '2026-09-03T00:00:00.000Z',
      }],
      total: 1,
      truncated: false,
    }))
    patchJson.mockResolvedValue({ workItem: {
      id: 'task-project-a', projectId: 'project-a', title: '确认发布', status: 'done',
      updatedAt: '2026-09-03T01:00:00.000Z',
    } })
    const wrapper = await setup('/employees/jefa')
    const board = wrapper.getComponent(EmployeeTaskBoard)
    const item = board.props('boards')[0].items[0]

    board.vm.$emit('move-task', item, 'done')
    await flushPromises()

    expect(patchJson).toHaveBeenCalledWith(
      '/employee-workspaces/jefa/project-a/api/work-items/task-project-a/status',
      { status: 'done' },
    )
    expect(postJson).toHaveBeenCalledTimes(1)
    expect(board.props('boards')[0].items[0].status).toBe('done')
  })
  it('does not silently switch an unauthorized deep link to another project', async () => {
    const wrapper = await setup('/employees/jefa?project=project-b')
    expect(wrapper.find('iframe').exists()).toBe(false)
    expect(wrapper.find('[role="alert"]').exists()).toBe(true)
    expect(postJson.mock.calls.some(([, body]) => body.tool === 'read_board')).toBe(false)
    expect(getJson.mock.calls.some(([url]) => String(url).includes('personalProjectId=project-a'))).toBe(false)
  })
  it('keeps a generic employee on the exact same-origin iframe route', async () => {
    getJson.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/employee-templates?')) return { templates: [{
        id: 'reviewer', name: 'Reviewer', role: '审阅员', runtime: { apiVersion: 1 }, runtimeStatus: 'ready',
        capabilities: ['审阅'], permissions: ['board.read'], agentId: 'employee.reviewer', agentStatus: 'active', assignmentsVersion: 'version-reviewer',
        assignments: [{ personalProjectId: 'project-a', status: 'active' }],
      }] }
      if (url.includes('/workspace?')) return { templateId: 'reviewer', name: 'Reviewer', role: '审阅员', project: { id: 'project-a', name: '验收项目' }, runtimeStatus: 'ready', workbenchUrl: '/employee-workspaces/reviewer/project-a/' }
      throw new Error(`unexpected URL: ${url}`)
    })
    const wrapper = await setup('/employees/reviewer?project=project-a')
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await wrapper.vm.$nextTick()
      await flushPromises()
    }
    expect(getJson.mock.calls.some(([url]) => String(url).includes('/workspace?'))).toBe(true)
    expect(wrapper.get('iframe').attributes('src')).toBe('/employee-workspaces/reviewer/project-a/')
    expect(wrapper.get('iframe').attributes('title')).toBe('Reviewer · 验收项目')
  })
  it('rejects a workbench descriptor pointing to an external page', async () => {
    getJson.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/employee-templates?')) return { templates: [{
        id: 'reviewer', name: 'Reviewer', role: '审阅员', runtime: { apiVersion: 1 }, runtimeStatus: 'ready',
        capabilities: ['审阅'], permissions: ['board.read'], agentId: 'employee.reviewer', agentStatus: 'active', assignmentsVersion: 'version-reviewer',
        assignments: [{ personalProjectId: 'project-a', status: 'active' }],
      }] }
      if (url.includes('/workspace?')) return { templateId: 'reviewer', name: 'Reviewer', role: '审阅员', project: { id: 'project-a', name: '验收项目' }, runtimeStatus: 'ready', workbenchUrl: 'https://untrusted.example/' }
      throw new Error(`unexpected URL: ${url}`)
    })
    const wrapper = await setup('/employees/reviewer?project=project-a')
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await wrapper.vm.$nextTick()
      await flushPromises()
    }
    expect(getJson.mock.calls.some(([url]) => String(url).includes('/workspace?'))).toBe(true)
    expect(wrapper.find('iframe').exists()).toBe(false)
    expect(wrapper.find('[role="alert"]').exists()).toBe(true)
  })
  it('keeps Jefa project filtering on the native board while retaining the responsibility editor', async () => {
    const wrapper = await setup('/employees/jefa?project=project-a')
    expect(wrapper.find('[role="combobox"]').exists()).toBe(false)
    expect(wrapper.findComponent(EmployeeTaskBoard).exists()).toBe(true)
    expect(wrapper.find('iframe').exists()).toBe(false)
    const boardCallsBefore = postJson.mock.calls.filter(([, body]) => body.tool === 'read_board').length
    await wrapper.get('.employee-workbench-actions button.employee-manage-projects').trigger('click')
    await flushPromises()
    const dialog = wrapper.getComponent(EmployeeRecruitDialog)
    expect(dialog.props('templateId')).toBe('jefa')
    expect(dialog.find('.project-scope-trigger').exists()).toBe(false)
    expect((dialog.get('input[value="project-a"]').element as HTMLInputElement).checked).toBe(true)
    expect(postJson.mock.calls.filter(([, body]) => body.tool === 'read_board')).toHaveLength(boardCallsBefore)
    expect(wrapper.findComponent(EmployeeTaskBoard).exists()).toBe(true)
  })

  it('shows a recoverable catalog error instead of asking to assign an already assigned Agent', async () => {
    const original = getJson.getMockImplementation()!
    getJson.mockImplementation(async () => { throw new Error('目录暂时不可用') })
    const wrapper = await setup('/employees/jefa')
    expect(wrapper.get('[role="alert"]').text()).toContain('目录暂时不可用')
    expect(wrapper.text()).not.toContain('先选择要负责的项目')
    getJson.mockImplementation(original)
    await wrapper.get('[role="alert"] button').trigger('click')
    await flushPromises()
    expect(wrapper.find('iframe').exists()).toBe(false)
    expect(wrapper.get('.employee-all-projects-heading h2').text()).toBe('任务看板')
  })

  it('offers assignment as an explicit next step for a hired Agent with no allowed projects', async () => {
    const original = getJson.getMockImplementation()!
    getJson.mockImplementation(async (url: string) => {
      const result = await original(url)
      if (url.startsWith('/api/employee-templates?')) result.templates[0].managedProjects = []
      return result
    })
    const wrapper = await setup('/employees/jefa')
    expect(wrapper.find('iframe').exists()).toBe(false)
    expect(wrapper.get('.employee-workbench-state h2').text()).toBe('先选择要负责的项目')
    await wrapper.get('.employee-workbench-state button').trigger('click')
    expect(wrapper.getComponent(EmployeeRecruitDialog).props('open')).toBe(true)
  })

  it('does not invent project assignments for an unknown Agent', async () => {
    const wrapper = await setup('/employees/unknown')
    expect(wrapper.find('iframe').exists()).toBe(false)
    expect(wrapper.text()).toContain('这位专属 Agent 暂不可用')
    expect(wrapper.get('.employee-workbench-state a').attributes('href')).toBe('/project-agents')
  })

  it('opens Bole as a native people panel without requiring a project or runtime iframe', async () => {
    getJson.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/employee-templates?')) return { templates: [{
        id: 'bole', name: 'Bole', role: 'HR', workbench: { kind: 'native', view: 'people' }, runtime: null,
        runtimeStatus: 'not_required', capabilities: ['人员配置'], permissions: ['agents.read'],
        agentId: 'employee.bole', agentStatus: 'active', assignmentsVersion: 'version-bole', assignments: [],
      }] }
      if (url.startsWith('/api/project-agents?')) return { agents: [] }
      if (url.startsWith('/api/project-agent-tasks?')) return { tasks: [] }
      if (url.startsWith('/api/project-agent-recruitments?')) return { recruitments: [] }
      throw new Error(`unexpected URL: ${url}`)
    })

    const wrapper = await setup('/employees/bole?project=project-a')

    expect(wrapper.getComponent(BolePeoplePanel).props('personalSpaceId')).toBe('space-a')
    expect(wrapper.find('iframe').exists()).toBe(false)
    expect(wrapper.findComponent(EmployeeRecruitDialog).exists()).toBe(false)
    expect(wrapper.find('.employee-manage-projects').exists()).toBe(false)
    expect(wrapper.vm.$route.query.project).toBeUndefined()
    expect(getJson.mock.calls.some(([url]) => String(url).includes('/workspace?'))).toBe(false)
  })

  it('keeps the first catalog request in a loading state instead of showing an unavailable Agent', async () => {
    let resolveCatalog!: (value: unknown) => void
    const pendingCatalog = new Promise((resolve) => { resolveCatalog = resolve })
    getJson.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/employee-templates?')) return pendingCatalog
      if (url.startsWith('/api/project-agents?')) return { agents: [] }
      if (url.startsWith('/api/project-agent-tasks?')) return { tasks: [] }
      if (url.startsWith('/api/project-agent-recruitments?')) return { recruitments: [] }
      throw new Error(`unexpected URL: ${url}`)
    })

    const wrapper = await setup('/employees/bole')
    expect(wrapper.find('.growth-loading[role="status"]').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('这位专属 Agent 暂不可用')

    resolveCatalog({ templates: [{
      id: 'bole', name: 'Bole', role: 'HR', workbench: { kind: 'native', view: 'people' }, runtime: null,
      runtimeStatus: 'not_required', capabilities: ['人员配置'], permissions: ['agents.read'],
      agentId: 'employee.bole', agentStatus: 'active', assignmentsVersion: 'version-bole', assignments: [],
    }] })
    await flushPromises()
    expect(wrapper.findComponent(BolePeoplePanel).exists()).toBe(true)
  })
})
