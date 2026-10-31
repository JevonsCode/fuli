import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConsoleState } from '@/types'
const { getJson, patchJson, postJson } = vi.hoisted(() => ({ getJson: vi.fn(), patchJson: vi.fn(), postJson: vi.fn() }))
vi.mock('@/api/client', async (importOriginal) => ({ ...await importOriginal<typeof import('@/api/client')>(), getJson, patchJson, postJson }))
import { ApiError } from '@/api/client'
import { defaultConsoleState, mountEmployeeWorkbench as setup, resetEmployeeWorkbench, unmountEmployeeWorkbenches } from '@/test-support/employee-workbench'
import { useConsoleStore } from '@/stores/console'
import { refreshEmployeeCatalog } from '@/features/employees/catalog'
import EmployeeTaskBoard from '@/features/employees/EmployeeTaskBoard.vue'
import EmployeeScopeDialog from '@/features/employees/EmployeeScopeDialog.vue'
import EmployeeTaskDialog from '@/features/employees/EmployeeTaskDialog.vue'
import BolePeoplePanel from '@/features/employees/BolePeoplePanel.vue'
import JudgmentWorkbench from '@/features/judgment/JudgmentWorkbench.vue'
import UnassignedConversationsPanel from '@/features/agent-profile/UnassignedConversationsPanel.vue'
import { projectBoardFilterKey } from '@/features/employees/project-board-filter'
import { pageTitle } from '@/layouts/page-title'
import { employeeMessages } from '@/i18n/messages/employees'
import { isChosen, openCombobox, selectionAction, setOption } from '@/test-support/option-pickers'

beforeEach(() => resetEmployeeWorkbench({ getJson, patchJson, postJson }))
afterEach(() => { unmountEmployeeWorkbenches(); vi.useRealTimers() })

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
    await openCombobox(first.get('.employee-all-projects-filter'))
    await setOption(first.get('.employee-all-projects-filter'), 'project-a', false)
    await flushPromises()
    first.unmount()
    const reopened = await setup('/employees/jefa?project=all')
    expect(reopened.getComponent(EmployeeTaskBoard).props('visibleProjectIds')).toEqual([])
    expect(reopened.get('.employee-all-projects-filter').text()).toContain('已选 0 / 共 1 个项目')
    expect(JSON.parse(localStorage.getItem(projectBoardFilterKey('space-a'))!).projectIds).toEqual([])
    await openCombobox(reopened)
    document.querySelector<HTMLElement>('[data-project-filter-reset]')!.click()
    await flushPromises()
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
    expect(wrapper.get('.employee-all-projects-filter').text()).toContain('已选 1 / 共 1 个项目')
    expect(wrapper.vm.$route.query.project).toBe('all')
  })
  it('keeps a single-project Jefa view on the native all-project board', async () => {
    const wrapper = await setup('/employees/jefa?project=project-a')
    expect(wrapper.findComponent(EmployeeTaskBoard).exists()).toBe(true)
    expect(wrapper.find('iframe').exists()).toBe(false)
    expect(wrapper.getComponent(EmployeeTaskBoard).props('visibleProjectIds')).toEqual(['project-a'])
    expect(wrapper.vm.$route.query.project).toBe('project-a')
    // The name is the shell's one H1; the page adds only the role.
    expect(pageTitle.value.text).toBe('Jefa')
    expect(wrapper.find('h1').exists()).toBe(false)
    expect(wrapper.get('[data-employee-role]').text()).toBe('项目经理')
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
    await openCombobox(wrapper.get('.employee-all-projects-filter'))
    await setOption(wrapper.get('.employee-all-projects-filter'), 'project-b', false)
    expect(wrapper.text()).toContain('整理验收')
    expect(wrapper.text()).not.toContain('准备发布')
    await selectionAction(wrapper, 'invert')
    expect(wrapper.text()).not.toContain('整理验收')
    expect(wrapper.text()).toContain('准备发布')
    await selectionAction(wrapper, 'all')
    await selectionAction(wrapper, 'clear')
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
    board.vm.$emit('move-task', item, { status: 'active' })
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

    board.vm.$emit('move-task', item, { status: 'done' })
    await flushPromises()

    expect(patchJson).toHaveBeenCalledWith(
      '/employee-workspaces/jefa/project-a/api/work-items/task-project-a/status',
      { status: 'done' },
    )
    expect(postJson).toHaveBeenCalledTimes(1)
    expect(board.props('boards')[0].items[0].status).toBe('done')
  })
  it('keeps the canonical task until the server answers a move, and unchanged when it refuses', async () => {
    postJson.mockImplementation(async (_url: string, body: { personalProjectId: string }) => ({
      project: { id: body.personalProjectId, name: body.personalProjectId },
      items: [{
        id: 'task-project-a', projectId: 'project-a', title: '确认发布', status: 'review',
        updatedAt: '2026-09-03T00:00:00.000Z',
      }],
      total: 1,
      truncated: false,
    }))
    let refuse!: (cause: Error) => void
    patchJson.mockImplementation(() => new Promise((_resolve, reject) => { refuse = reject }))
    const wrapper = await setup('/employees/jefa')
    const board = wrapper.getComponent(EmployeeTaskBoard)
    const item = board.props('boards')[0].items[0]

    board.vm.$emit('move-task', item, { status: 'done' })
    await flushPromises()
    expect(board.props('movingItemKeys')).toEqual(['project-a:task-project-a'])
    expect(board.props('boards')[0].items[0]).toEqual(item)

    refuse(new Error('版本冲突'))
    await flushPromises()
    expect(board.props('movingItemKeys')).toEqual([])
    expect(board.props('boards')[0].items[0]).toEqual(item)
    expect(board.props('actionError')).toContain('版本冲突')
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
  it('says plainly that a custom workspace is not installed, without a terminal command', async () => {
    getJson.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/employee-templates?')) return { templates: [{
        id: 'reviewer', name: 'Reviewer', role: '审阅员', runtime: { apiVersion: 1 }, runtimeStatus: 'install_required',
        capabilities: ['审阅'], permissions: ['board.read'], agentId: 'employee.reviewer', agentStatus: 'active', assignmentsVersion: 'version-reviewer',
        assignments: [{ personalProjectId: 'project-a', status: 'active' }],
      }] }
      if (url.includes('/workspace?')) return { templateId: 'reviewer', name: 'Reviewer', role: '审阅员', project: { id: 'project-a', name: '验收项目' }, runtimeStatus: 'install_required', workbenchUrl: '/employee-workspaces/reviewer/project-a/' }
      throw new Error(`unexpected URL: ${url}`)
    })
    const wrapper = await setup('/employees/reviewer?project=project-a')
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await wrapper.vm.$nextTick()
      await flushPromises()
    }
    expect(wrapper.find('iframe').exists()).toBe(false)
    expect(wrapper.get('.employee-workbench-state').text()).toBe('这个 Agent 的工作台没有安装，目前只能作为 Agent 身份使用。')
  })
  it('never sends the person to a terminal from an employee page, in either language', () => {
    for (const messages of Object.values(employeeMessages)) {
      expect(JSON.stringify(messages)).not.toMatch(/\bfl\s|\bfuli\s+[a-z]|\bnpm\s|\bnode\s|<目录>|<directory>|终端|terminal/i)
    }
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
    // The board's own project filter is the only project picker on the page.
    expect(wrapper.findAll('[role="combobox"]').map((field) => field.element.closest('.employee-all-projects-filter'))).not.toContain(null)
    expect(wrapper.findComponent(EmployeeTaskBoard).exists()).toBe(true)
    expect(wrapper.find('iframe').exists()).toBe(false)
    const boardCallsBefore = postJson.mock.calls.filter(([, body]) => body.tool === 'read_board').length
    await wrapper.get('.employee-workbench-actions button.employee-manage-projects').trigger('click')
    await flushPromises()
    const dialog = wrapper.getComponent(EmployeeScopeDialog)
    expect(dialog.props('templateId')).toBe('jefa')
    expect(dialog.find('input[role="combobox"]').exists()).toBe(false)
    expect(isChosen(dialog, 'project-a')).toBe(true)
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
    expect(wrapper.getComponent(EmployeeScopeDialog).props('open')).toBe(true)
  })

  it('does not invent project assignments for an unknown Agent', async () => {
    const wrapper = await setup('/employees/unknown')
    expect(wrapper.find('iframe').exists()).toBe(false)
    expect(wrapper.text()).toContain('这位专属 Agent 暂不可用')
    expect(wrapper.get('.employee-workbench-back').attributes('href')).toBe('/project-agents')
  })

  it('opens Bole as a native people panel without requiring a project or runtime iframe', async () => {
    getJson.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/employee-templates?')) return { templates: [{
        id: 'bole', name: 'Bole', role: 'AR', workbench: { kind: 'native', view: 'people' }, runtime: null,
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
    expect(wrapper.findComponent(EmployeeScopeDialog).exists()).toBe(false)
    expect(wrapper.find('.employee-manage-projects').exists()).toBe(false)
    expect(wrapper.vm.$route.query.project).toBeUndefined()
    expect(getJson.mock.calls.some(([url]) => String(url).includes('/workspace?'))).toBe(false)
    expect(wrapper.get('.employee-workbench-actions .bole-refresh').text()).toBe('刷新')
    expect(wrapper.find('.employee-workbench-identity .employee-native-link').exists()).toBe(true)
    expect(wrapper.findAll('[role="tab"]').map(tab => tab.text())).toEqual(['团队成员 0', '工作记录 0'])
    expect(wrapper.findAll('h2')).toHaveLength(0)
  })

  it('opens Astro on the unclaimed conversations it receives, not on the Bole people panel', async () => {
    getJson.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/employee-templates?')) return { templates: [{
        id: 'assistant', name: 'Astro', role: '全局助手', workbench: { kind: 'native', view: 'unclaimed' }, runtime: null,
        runtimeStatus: 'not_required', capabilities: ['全局对话'], permissions: [],
        agentId: 'employee.assistant', agentStatus: 'active', assignmentsVersion: 'version-assistant', assignments: [],
      }] }
      throw new Error(`unexpected URL: ${url}`)
    })

    const wrapper = await setup('/employees/assistant')

    expect(wrapper.getComponent(UnassignedConversationsPanel).props('spaceId')).toBe('space-a')
    expect(wrapper.findComponent(BolePeoplePanel).exists()).toBe(false)
    expect(wrapper.find('iframe').exists()).toBe(false)
  })

  it('opens Tonborg as the native judgment workbench and keeps profile navigation available', async () => {
    getJson.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/employee-templates?')) return { templates: [{
        id: 'tonborg', name: 'Tonborg', role: '决策员', workbench: { kind: 'native', view: 'judgment' }, runtime: null,
        runtimeStatus: 'not_required', capabilities: ['判断'], permissions: ['judgment.review'],
        agentId: 'employee.tonborg', agentStatus: 'active', assignmentsVersion: 'version-tonborg', assignments: [],
      }] }
      if (url.startsWith('/api/judgment/records?')) return { records: [] }
      throw new Error(`unexpected URL: ${url}`)
    })

    const wrapper = await setup('/employees/tonborg?project=project-a')

    expect(pageTitle.value.text).toBe('Tonborg')
    expect(wrapper.get('[data-employee-role]').text()).toBe('决策员')
    expect(wrapper.get('.employee-workbench-mark img').attributes('src')).toContain('tonborg-avatar.webp')
    expect(wrapper.findComponent(JudgmentWorkbench).props('personalSpaceId')).toBe('space-a')
    expect(wrapper.find('iframe').exists()).toBe(false)
    expect(wrapper.findComponent(EmployeeScopeDialog).exists()).toBe(false)
    expect(wrapper.get('.employee-native-link').attributes('href')).toBe('/agents/space-a/employee.tonborg')
    // 主页 sits beside the role like Jefa's share icon; Tonborg's actions join the same toolbar row.
    expect(wrapper.find('.employee-workbench-identity .employee-native-link').exists()).toBe(true)
    expect(wrapper.find('.employee-workbench-toolbar .employee-workbench-actions [data-action="review"]').exists()).toBe(false)
    expect(wrapper.get('.employee-workbench-actions').text()).toContain('刷新')
    expect(wrapper.find('[data-judgment-empty] [data-action="review"]').exists()).toBe(true)
    expect(wrapper.findAll('h2')).toHaveLength(0)
    expect(wrapper.vm.$route.query.project).toBeUndefined()
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
      id: 'bole', name: 'Bole', role: 'AR', workbench: { kind: 'native', view: 'people' }, runtime: null,
      runtimeStatus: 'not_required', capabilities: ['人员配置'], permissions: ['agents.read'],
      agentId: 'employee.bole', agentStatus: 'active', assignmentsVersion: 'version-bole', assignments: [],
    }] })
    await flushPromises()
    expect(wrapper.findComponent(BolePeoplePanel).exists()).toBe(true)
  })
})

describe('Jefa bounded progressive reads', () => {
  function twoProjects() {
    const original = getJson.getMockImplementation()!
    getJson.mockImplementation(async (url: string) => {
      const result = await original(url)
      if (url.startsWith('/api/employee-templates?')) {
        result.templates[0].managedProjects = [{ id: 'project-a', name: '项目 A' }, { id: 'project-b', name: '项目 B' }]
      }
      return result
    })
  }
  it('shows a successful project while another board is pending', async () => {
    twoProjects()
    postJson.mockImplementation((_url: string, body: { personalProjectId: string }) => body.personalProjectId === 'project-b'
      ? new Promise(() => {}) : Promise.resolve({ items: [{ id: 'a1', projectId: 'project-a', title: '已成功的任务', status: 'planned' }], total: 1, truncated: false }))
    const wrapper = await setup('/employees/jefa')
    expect(wrapper.text()).toContain('已成功的任务')
    expect(wrapper.text()).toContain('1 个仍在读取')
  })
  it('ends a hung board after one 30s budget and ignores a late response', async () => {
    vi.useFakeTimers()
    let resolveBoard!: (value: unknown) => void
    postJson.mockImplementation(() => new Promise(resolve => { resolveBoard = resolve }))
    const wrapper = await setup('/employees/jefa')
    await vi.advanceTimersByTimeAsync(8000)
    expect(wrapper.text()).toContain('读取时间较长')
    await vi.advanceTimersByTimeAsync(22000)
    expect(wrapper.find('.growth-loading').exists()).toBe(false)
    expect(wrapper.get('[role="alert"]').text()).toContain('任务看板读取超时')
    resolveBoard({ items: [], total: 0, truncated: false })
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('任务看板读取超时')
  })
  it('keeps partial tasks and reports a hung project as unavailable at timeout', async () => {
    vi.useFakeTimers(); twoProjects()
    postJson.mockImplementation((_url: string, body: { personalProjectId: string }) => body.personalProjectId === 'project-b'
      ? new Promise(() => {}) : Promise.resolve({ items: [{ id: 'a1', projectId: 'project-a', title: '保留任务', status: 'planned' }], total: 1, truncated: false }))
    const wrapper = await setup('/employees/jefa')
    await vi.advanceTimersByTimeAsync(30000)
    expect(wrapper.text()).toContain('保留任务')
    expect(wrapper.text()).toContain('部分项目暂不可用')
    expect(wrapper.find('.growth-loading').exists()).toBe(false)
  })
  it('counts the catalog answer as progress, then times out a hung board one idle budget later', async () => {
    vi.useFakeTimers()
    const original = getJson.getMockImplementation()!
    getJson.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/employee-templates?')) await new Promise(resolve => setTimeout(resolve, 20000))
      return original(url)
    })
    postJson.mockImplementation(() => new Promise(() => {}))
    const wrapper = await setup('/employees/jefa')
    await vi.advanceTimersByTimeAsync(20000)
    await vi.advanceTimersByTimeAsync(10000)
    expect(wrapper.find('.growth-loading').exists()).toBe(true)
    await vi.advanceTimersByTimeAsync(20000)
    expect(wrapper.find('.growth-loading').exists()).toBe(false)
    expect(wrapper.get('[role="alert"]').text()).toContain('任务看板读取超时')
  })
  it('does not time out a slow catalog followed by a slower board', async () => {
    vi.useFakeTimers()
    const original = getJson.getMockImplementation()!
    getJson.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/employee-templates?')) await new Promise(resolve => setTimeout(resolve, 25000))
      return original(url)
    })
    postJson.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve({ items: [{ id: 'a1', projectId: 'project-a', title: '慢速读取的任务', status: 'planned' }], total: 1, truncated: false }), 8000)))
    const wrapper = await setup('/employees/jefa')
    await vi.advanceTimersByTimeAsync(34000)
    expect(wrapper.text()).toContain('慢速读取的任务')
    expect(wrapper.find('.growth-loading').exists()).toBe(false)
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  })
  it('times out a hanging catalog and aborts its request without accepting late catalog data', async () => {
    vi.useFakeTimers()
    let resolveCatalog!: (value: unknown) => void
    let catalogSignal: AbortSignal | undefined
    getJson.mockImplementation((_url: string, init?: { signal: AbortSignal }) => {
      catalogSignal = init?.signal
      return new Promise(resolve => { resolveCatalog = resolve })
    })
    const wrapper = await setup('/employees/jefa')
    await vi.advanceTimersByTimeAsync(8000)
    expect(wrapper.text()).toContain('正在读取 Jefa 的负责项目')
    await vi.advanceTimersByTimeAsync(22000)
    expect(catalogSignal?.aborted).toBe(true)
    expect(wrapper.get('[role="alert"]').text()).toContain('任务看板读取超时')
    resolveCatalog({ templates: [] }); await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('任务看板读取超时')
  })
  it('keeps truncated content when a complete snapshot hangs, using the original read deadline', async () => {
    vi.useFakeTimers()
    postJson.mockResolvedValue({ items: [{ id: 'a1', projectId: 'project-a', title: '截断任务', status: 'planned' }], total: 200, truncated: true })
    const original = getJson.getMockImplementation()!
    getJson.mockImplementation((url: string) => url.endsWith('/api/snapshot') ? new Promise(() => {}) : original(url))
    const wrapper = await setup('/employees/jefa')
    expect(wrapper.text()).toContain('截断任务')
    expect(wrapper.text()).toContain('正在读取完整任务列表')
    await vi.advanceTimersByTimeAsync(30000)
    expect(wrapper.text()).toContain('截断任务')
    expect(wrapper.findComponent(EmployeeTaskBoard).props('boards')[0].truncated).toBe(true)
    expect(wrapper.find('.growth-loading').exists()).toBe(false)
  })
  it('does not call incomplete or failed reads an empty successful board', async () => {
    twoProjects()
    postJson.mockImplementation((_url: string, body: { personalProjectId: string }) => body.personalProjectId === 'project-b'
      ? Promise.reject(new ApiError('unavailable', 503)) : Promise.resolve({ items: [], total: 0, truncated: false }))
    const wrapper = await setup('/employees/jefa')
    expect(wrapper.text()).toContain('部分项目暂不可用')
    expect(wrapper.text()).not.toContain('所有项目都很清爽')
    expect(wrapper.text()).toContain('任务读取尚未完整')
  })
  it('retains successful content, search and filter across one manual retry and ignores repeated retries', async () => {
    twoProjects()
    let round = 0
    postJson.mockImplementation((_url: string, body: { personalProjectId: string }) => {
      if (body.personalProjectId === 'project-b') return Promise.reject(new ApiError('unavailable', 503))
      return round ? new Promise(() => {}) : Promise.resolve({ items: [{ id: 'a1', projectId: 'project-a', title: '上次任务', status: 'planned' }], total: 1, truncated: false })
    })
    const wrapper = await setup('/employees/jefa')
    await wrapper.get('input[type="search"]').setValue('上次任务')
    const before = postJson.mock.calls.length
    round++
    const reload = wrapper.get('.jefa-read-actions button')
    await reload.trigger('click'); await reload.trigger('click'); await flushPromises()
    expect(postJson.mock.calls.length).toBe(before + 2)
    expect(wrapper.get('input[type="search"]').element).toHaveProperty('value', '上次任务')
    expect(wrapper.text()).toContain('上次任务')
    expect(wrapper.findComponent(EmployeeTaskBoard).props('canMoveTasks')).toBe(false)
    expect(wrapper.text()).not.toContain('更新失败')
  })
  it('removes revoked data after a manual refresh and permits details but no writes for old data', async () => {
    twoProjects()
    postJson.mockImplementation((_url: string, body: { personalProjectId: string }) => body.personalProjectId === 'project-b'
      ? Promise.reject(new ApiError('unavailable', 503)) : Promise.resolve({ items: [{ id: 'a1', projectId: 'project-a', title: '将撤权的任务', status: 'planned' }], total: 1, truncated: false }))
    const wrapper = await setup('/employees/jefa')
    postJson.mockRejectedValue(new ApiError('forbidden', 403))
    await wrapper.get('.jefa-read-actions button').trigger('click'); await flushPromises()
    expect(wrapper.text()).not.toContain('将撤权的任务')
    // The catalog still lists the projects, so the board keeps its filter but shows no revoked data.
    expect(wrapper.getComponent(EmployeeTaskBoard).props('boards')).toEqual([])
    expect(wrapper.get('[role="alert"]').text()).toContain('任务看板读取失败')
  })
  it('invalidates pending board work on unmount and changing personal space', async () => {
    let oldResponse!: (value: unknown) => void
    const signals: AbortSignal[] = []
    postJson.mockImplementation((_url: string, _body: unknown, init: { signal: AbortSignal }) => {
      signals.push(init.signal)
      return new Promise(resolve => { oldResponse = resolve })
    })
    const wrapper = await setup('/employees/jefa')
    const first = oldResponse
    const store = useConsoleStore()
    store.state = { ...defaultConsoleState(), activePersonalSpaceId: 'space-b', personalSpaces: [{ id: 'space-b', name: '另一个合成空间' }] }
    await flushPromises()
    first({ items: [{ id: 'old', projectId: 'project-a', title: '旧空间任务', status: 'planned' }], total: 1, truncated: false })
    await flushPromises()
    expect(signals[0]?.aborted).toBe(true)
    expect(wrapper.text()).not.toContain('旧空间任务')
    wrapper.unmount()
    expect(signals.at(-1)?.aborted).toBe(true)
  })

  it('loads another employee after navigating away from the Jefa-specific reader', async () => {
    const original = getJson.getMockImplementation()!
    getJson.mockImplementation(async (url: string) => {
      const result = await original(url)
      if (url.startsWith('/api/employee-templates?')) result.templates.push({ id: 'bole', name: 'Bole', role: 'AR', workbench: { kind: 'native', view: 'people' }, runtimeStatus: 'not_required', assignments: [], permissions: [] })
      return result
    })
    const wrapper = await setup('/employees/jefa')
    await wrapper.vm.$router.push('/employees/bole'); await flushPromises()
    expect(wrapper.findComponent(BolePeoplePanel).exists()).toBe(true)
  })

  it('does not silently restart after a timed-out initial console read finishes late', async () => {
    vi.useFakeTimers()
    const store = useConsoleStore(); store.state = null; store.runtimeStatus = 'loading'
    const wrapper = await setup('/employees/jefa')
    await vi.advanceTimersByTimeAsync(30000)
    store.state = defaultConsoleState(); store.runtimeStatus = 'ready'; await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('任务看板读取超时')
    expect(postJson).not.toHaveBeenCalled()
    await wrapper.get('.jefa-read-actions button').trigger('click'); await flushPromises()
    expect(wrapper.findComponent(EmployeeTaskBoard).exists()).toBe(true)
  })

  it('closes an open task detail after that project is revoked, without re-enabling its save action', async () => {
    twoProjects()
    postJson.mockImplementation((_url: string, body: { personalProjectId: string; tool: string }) => body.tool === 'get_task'
      ? Promise.resolve({ item: { id: 'a1', projectId: 'project-a', title: '已打开的任务', summary: '已加载私密详情', status: 'planned', updatedAt: '2026-10-18T17:00:00Z' } })
      : body.personalProjectId === 'project-b' ? Promise.reject(new ApiError('unavailable', 503))
        : Promise.resolve({ items: [{ id: 'a1', projectId: 'project-a', title: '已打开的任务', status: 'planned' }], total: 1, truncated: false }))
    const wrapper = await setup('/employees/jefa')
    wrapper.findComponent(EmployeeTaskBoard).vm.$emit('select-task', { id: 'a1', projectId: 'project-a', title: '已打开的任务', status: 'planned' })
    await flushPromises()
    const dialog = wrapper.findComponent(EmployeeTaskDialog)
    expect(dialog.props('open')).toBe(true)
    expect(dialog.props('canWrite')).toBe(true)
    expect(dialog.get('textarea').element).toHaveProperty('value', '已加载私密详情')
    expect(dialog.get('button[type="submit"]').attributes('disabled')).toBeUndefined()
    postJson.mockRejectedValue(new ApiError('forbidden', 403))
    await wrapper.get('.jefa-read-actions button').trigger('click'); await flushPromises()
    expect(wrapper.findComponent(EmployeeTaskDialog).props('open')).toBe(false)
    expect(wrapper.findComponent(EmployeeTaskDialog).props('item')).toBeNull()
    expect(wrapper.text()).not.toContain('已加载私密详情')
    expect(postJson.mock.calls.some(([, body]) => ['update_tasks', 'create_tasks'].includes(body.tool))).toBe(false)
  })

  it('drops a project removed by an authoritative catalog even if the following reload fails', async () => {
    postJson.mockResolvedValue({ items: [{ id: 'a1', projectId: 'project-a', title: '目录已撤销任务', status: 'planned' }], total: 1, truncated: false })
    const wrapper = await setup('/employees/jefa')
    const original = getJson.getMockImplementation()!
    let reads = 0
    getJson.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/employee-templates?') && ++reads > 1) throw new ApiError('offline', 503)
      const result = await original(url)
      if (url.startsWith('/api/employee-templates?')) { result.templates[0].assignmentsVersion = 'removed-a'; result.templates[0].managedProjects = [{ id: 'project-b', name: '项目 B' }] }
      return result
    })
    await refreshEmployeeCatalog('space-a'); await flushPromises()
    expect(wrapper.text()).not.toContain('目录已撤销任务')
    // The last authoritative catalog keeps the board and its filter, without the removed project.
    expect(wrapper.getComponent(EmployeeTaskBoard).props('boards')).toEqual([])
    expect(wrapper.getComponent(EmployeeTaskBoard).props('projects')).toEqual([{ id: 'project-b', name: '项目 B' }])
  })

  it('shows an explicit permission failure instead of a blank ready workbench', async () => {
    const original = getJson.getMockImplementation()!
    getJson.mockImplementation(async (url: string) => {
      const result = await original(url)
      if (url.startsWith('/api/employee-templates?')) result.templates[0].permissions = []
      return result
    })
    const wrapper = await setup('/employees/jefa')
    expect(wrapper.find('[role="alert"]').exists()).toBe(true)
    expect(postJson).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('请检查负责范围')
  })

  it('shows a confirmed empty result only after successful project reads', async () => {
    const wrapper = await setup('/employees/jefa')
    expect(wrapper.text()).toContain('当前范围暂无任务')
    expect(wrapper.text()).not.toContain('任务读取尚未完整')
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  })
  it('keeps search with no matches distinct from a successful empty board', async () => {
    postJson.mockResolvedValue({ items: [{ id: 'a1', projectId: 'project-a', title: '实际有任务', status: 'planned' }], total: 1, truncated: false })
    const wrapper = await setup('/employees/jefa')
    await wrapper.get('input[type="search"]').setValue('no-such-task')
    expect(wrapper.text()).toContain('没有匹配的任务')
    expect(wrapper.text()).not.toContain('当前范围暂无任务')
  })

  it('discards a private task response arriving after its project was revoked', async () => {
    twoProjects()
    let detail!: (value: unknown) => void
    postJson.mockImplementation((_url: string, body: { personalProjectId: string; tool: string }) => body.tool === 'get_task'
      ? new Promise(resolve => { detail = resolve })
      : body.personalProjectId === 'project-b' ? Promise.reject(new ApiError('unavailable', 503))
        : Promise.resolve({ items: [{ id: 'a1', projectId: 'project-a', title: '任务 A', status: 'planned' }], total: 1, truncated: false }))
    const wrapper = await setup('/employees/jefa')
    wrapper.findComponent(EmployeeTaskBoard).vm.$emit('select-task', { id: 'a1', projectId: 'project-a', title: '任务 A', status: 'planned' })
    await flushPromises()
    postJson.mockRejectedValue(new ApiError('forbidden', 403))
    await wrapper.get('.jefa-read-actions button').trigger('click'); await flushPromises()
    detail({ item: { id: 'a1', projectId: 'project-a', title: '旧任务', summary: '撤权后晚到私密正文', status: 'planned', updatedAt: '2026-10-18T17:00:00Z' } })
    await flushPromises()
    expect(wrapper.findComponent(EmployeeTaskDialog).props('open')).toBe(false)
    expect(wrapper.find('dialog').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('撤权后晚到私密正文')
  })

  it('opens a board task as a quick look in the URL, and Back closes it without reading the board again', async () => {
    twoProjects()
    postJson.mockImplementation(async (_url: string, body: { personalProjectId: string; tool: string; arguments?: { workItemId?: string } }) => body.tool === 'get_task'
      ? { item: { id: body.arguments?.workItemId, projectId: body.personalProjectId, title: '已打开的任务', summary: '详情正文', status: 'planned', updatedAt: '2026-10-18T17:00:00Z' } }
      : { items: [{ id: `t-${body.personalProjectId}`, projectId: body.personalProjectId, title: `任务 ${body.personalProjectId}`, status: 'planned' }], total: 1, truncated: false })
    const wrapper = await setup('/employees/jefa')
    const boardReads = () => postJson.mock.calls.filter(([, body]) => body.tool === 'read_board').length
    const reads = boardReads()
    await wrapper.get('[aria-label="在 项目 B 中查看任务：任务 project-b"]').trigger('click')
    await flushPromises()
    expect(wrapper.vm.$route.query.item).toBe('space-a/project-b%3At-project-b')
    expect(wrapper.getComponent(EmployeeTaskDialog).props('item')).toEqual({ projectId: 'project-b', id: 't-project-b' })
    // The open task lifts as a card on the board.
    expect(wrapper.get('[data-board-task="project-b:t-project-b"]').classes()).toContain('is-selected')
    wrapper.vm.$router.back()
    await flushPromises()
    expect(wrapper.vm.$route.query.item).toBeUndefined()
    expect(wrapper.getComponent(EmployeeTaskDialog).props('open')).toBe(false)
    expect(boardReads()).toBe(reads)
  })

  it('reads a shared task link by its exact project and id, even when the board does not list it', async () => {
    twoProjects()
    postJson.mockImplementation(async (_url: string, body: { personalProjectId: string; tool: string; arguments?: { workItemId?: string } }) => body.tool === 'get_task'
      ? { item: { id: body.arguments?.workItemId, projectId: body.personalProjectId, title: '不在第一页的任务', summary: '按身份读取', status: 'done', updatedAt: '2026-10-18T17:00:00Z' } }
      : { items: [], total: 0, truncated: false })
    const wrapper = await setup('/employees/jefa?item=space-a%2Fproject-b%253Aold-task')
    const dialog = wrapper.getComponent(EmployeeTaskDialog)
    expect(dialog.props('open')).toBe(true)
    expect(postJson).toHaveBeenCalledWith('/api/employee-templates/jefa/call', {
      personalSpaceId: 'space-a', personalProjectId: 'project-b', tool: 'get_task', arguments: { workItemId: 'old-task' },
    })
    expect(dialog.get('textarea').element).toHaveProperty('value', '按身份读取')
  })

  it('keeps a shared task link open when the catalog read fails for a reason other than access', async () => {
    const original = getJson.getMockImplementation()!
    getJson.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/employee-templates?')) throw new ApiError('down', 503)
      return original(url)
    })
    postJson.mockResolvedValue({ item: { id: 'a1', projectId: 'project-a', title: '任务', summary: '仍可读取', status: 'planned', updatedAt: '2026-10-18T17:00:00Z' } })
    const wrapper = await setup('/employees/jefa?item=space-a%2Fproject-a%253Aa1')
    expect(wrapper.getComponent(EmployeeTaskDialog).props('open')).toBe(true)
    expect(wrapper.vm.$route.query.item).toBe('space-a/project-a%3Aa1')
  })
  it('closes a task quick look when a complete catalog read no longer has Jefa, and drops its late detail', async () => {
    let detail!: (value: unknown) => void
    postJson.mockImplementation((_url: string, body: { tool: string; personalProjectId: string }) => body.tool === 'get_task'
      ? new Promise(resolve => { detail = resolve })
      : Promise.resolve({ items: [{ id: 'a1', projectId: 'project-a', title: '任务 A', status: 'planned' }], total: 1, truncated: false }))
    const wrapper = await setup('/employees/jefa?item=space-a%2Fproject-a%253Aa1')
    expect(wrapper.getComponent(EmployeeTaskDialog).props('open')).toBe(true)
    const original = getJson.getMockImplementation()!
    getJson.mockImplementation(async (url: string) => url.startsWith('/api/employee-templates?') ? { templates: [] } : original(url))
    await refreshEmployeeCatalog('space-a')
    await flushPromises()
    expect(wrapper.getComponent(EmployeeTaskDialog).props('open')).toBe(false)
    expect(wrapper.vm.$route.query.item).toBeUndefined()
    detail({ item: { id: 'a1', projectId: 'project-a', title: '任务 A', summary: '移除后晚到的正文', status: 'planned', updatedAt: '2026-10-18T17:00:00Z' } })
    await flushPromises()
    expect(wrapper.text()).not.toContain('移除后晚到的正文')
  })
})
