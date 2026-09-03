import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
const { getJson, postJson } = vi.hoisted(() => ({ getJson: vi.fn(), postJson: vi.fn() }))
vi.mock('@/api/client', () => ({ getJson, postJson }))
vi.mock('@/stores/console', () => ({ useConsoleStore: () => ({
  activePersonalSpace: { id: 'space-a' },
  state: { personalProjects: [{ project_id: 'project-a', profile: { name: '验收项目' } }] },
}) }))
import EmployeeWorkbenchPage from './EmployeeWorkbenchPage.vue'
import { refreshEmployeeCatalog } from '@/features/employees/catalog'
import EmployeeRecruitDialog from '@/features/employees/EmployeeRecruitDialog.vue'

const mounted: Array<{ unmount: () => void }> = []
beforeEach(async () => {
  await refreshEmployeeCatalog('')
  getJson.mockReset()
  postJson.mockReset()
  postJson.mockImplementation(async (_url: string, body: { personalProjectId: string }) => ({
    project: { id: body.personalProjectId, name: body.personalProjectId },
    items: [], total: 0, truncated: false,
  }))
  getJson.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/employee-templates?')) return { templates: [{
      id: 'jefa', name: 'Jefa', role: '项目经理', runtime: { apiVersion: 1 }, runtimeStatus: 'ready',
      capabilities: ['项目管理'], permissions: ['board.read'], agentId: 'employee.jefa', agentStatus: 'active', assignmentsVersion: 'version-1',
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
    expect(wrapper.get('iframe').attributes('src')).toBe('/employee-workspaces/jefa/project-a/')
    expect(wrapper.get('[role="combobox"]').text()).toContain('自动纳入的新项目')
    expect(wrapper.vm.$route.query.project).toBe('project-a')
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
    const wrapper = await setup('/employees/jefa?project=__all__')
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
    expect(wrapper.get('[role="combobox"]').attributes('aria-label')).toBe('当前查看的项目')
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
    expect(wrapper.get('iframe').attributes('src')).toBe('/employee-workspaces/jefa/project-a/')
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
