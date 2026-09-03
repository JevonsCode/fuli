import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
const { getJson, patchJson, postJson } = vi.hoisted(() => ({ getJson: vi.fn(), patchJson: vi.fn(), postJson: vi.fn() }))
vi.mock('@/api/client', () => ({ getJson, patchJson, postJson }))
vi.mock('@/stores/console', () => ({ useConsoleStore: () => ({
  activePersonalSpace: { id: 'space-a' },
  state: { personalProjects: [{ project_id: 'project-a', profile: { name: '验收项目' } }] },
}) }))
import EmployeeWorkbenchPage from './EmployeeWorkbenchPage.vue'
import { refreshEmployeeCatalog } from '@/features/employees/catalog'
import EmployeeAllProjectsBoard from '@/features/employees/EmployeeAllProjectsBoard.vue'
import EmployeeRecruitDialog from '@/features/employees/EmployeeRecruitDialog.vue'

const mounted: Array<{ unmount: () => void }> = []
beforeEach(async () => {
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
    expect(wrapper.get('h2').text()).toBe('全部项目看板')
    expect(wrapper.get('.project-scope-trigger').text()).toContain('全部项目 · 1 个')
    expect(wrapper.vm.$route.query.project).toBe('__all__')
  })
  it('embeds only the exact same-origin employee project route', async () => {
    const wrapper = await setup('/employees/jefa?project=project-a')
    expect(wrapper.get('iframe').attributes('src')).toBe('/employee-workspaces/jefa/project-a/')
    expect(wrapper.get('iframe').attributes('title')).toBe('Jefa · 验收项目')
    expect(wrapper.get('h1').text()).toBe('Jefa 项目经理')
    expect(wrapper.text()).not.toContain('员工工作台')
    expect(getJson.mock.calls.some(([url]) => String(url).includes('personalSpaceId=space-a'))).toBe(true)
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
    postJson.mockImplementation(async (_url: string, body: { personalProjectId: string; tool: string }) => ({
      project: { id: body.personalProjectId, name: body.personalProjectId },
      items: [{
        id: `task-${body.personalProjectId}`, projectId: body.personalProjectId,
        title: body.personalProjectId === 'project-a' ? '整理验收' : '准备发布', status: 'planned', tags: ['agent'],
      }],
      total: 1,
      truncated: false,
    }))
    const wrapper = await setup('/employees/jefa')
    expect(wrapper.find('iframe').exists()).toBe(false)
    expect(wrapper.get('h2').text()).toBe('全部项目看板')
    expect(wrapper.vm.$route.query.project).toBe('__all__')
    expect(postJson).toHaveBeenCalledTimes(2)
    expect(postJson.mock.calls.map(([, body]) => body.personalProjectId)).toEqual(['project-a', 'project-b'])
    expect(postJson.mock.calls.every(([, body]) => body.tool === 'read_board')).toBe(true)
    await wrapper.get('[aria-label="在 第二项目 中查看任务：准备发布"]').trigger('click')
    await flushPromises()
    expect(wrapper.vm.$route.query.project).toBe('project-b')
    expect(wrapper.get('iframe').attributes('src')).toBe('/employee-workspaces/jefa/project-b/')
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
    await wrapper.get('.employee-all-projects-empty button').trigger('click')
    expect(wrapper.text()).toContain('整理验收')
    expect(wrapper.text()).toContain('准备发布')
    expect(postJson).toHaveBeenCalledTimes(2)
    expect(wrapper.vm.$route.query.project).toBe('__all__')
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
    const board = wrapper.getComponent(EmployeeAllProjectsBoard)
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
    const board = wrapper.getComponent(EmployeeAllProjectsBoard)
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
    expect(getJson.mock.calls.some(([url]) => String(url).includes('personalProjectId=project-a'))).toBe(false)
  })
  it('rejects a workbench descriptor pointing to an external page', async () => {
    const original = getJson.getMockImplementation()!
    getJson.mockImplementation(async (url: string) => url.includes('/workspace?')
      ? { workbenchUrl: 'https://untrusted.example/', runtimeStatus: 'ready' } : original(url))
    const wrapper = await setup('/employees/jefa?project=project-a')
    expect(wrapper.find('iframe').exists()).toBe(false)
    expect(wrapper.find('[role="alert"]').exists()).toBe(true)
  })
  it('separates the current board view from the multi-project responsibility editor', async () => {
    const wrapper = await setup('/employees/jefa?project=project-a')
    expect(wrapper.find('[role="combobox"]').exists()).toBe(false)
    expect(wrapper.get('.employee-back-to-all').text()).toBe('返回全部项目')
    await wrapper.get('.employee-workbench-actions button.employee-manage-projects').trigger('click')
    await flushPromises()
    const dialog = wrapper.getComponent(EmployeeRecruitDialog)
    expect(dialog.props('templateId')).toBe('jefa')
    expect(dialog.find('.project-scope-trigger').exists()).toBe(false)
    expect((dialog.get('input[value="project-a"]').element as HTMLInputElement).checked).toBe(true)
    expect(wrapper.get('iframe').attributes('src')).toBe('/employee-workspaces/jefa/project-a/')
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
    expect(wrapper.get('h2').text()).toBe('全部项目看板')
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
})
