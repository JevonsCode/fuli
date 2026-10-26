import { flushPromises, mount } from '@vue/test-utils'
import type { Mock } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'
import type { ConsoleState } from '@/types'
import EmployeeWorkbenchPage from '@/pages/EmployeeWorkbenchPage.vue'
import { useConsoleStore } from '@/stores/console'
import { refreshEmployeeCatalog } from '@/features/employees/catalog'

// Synthetic space, project and Jefa catalog shared by the employee workbench page specs.
// Each spec mocks '@/api/client' itself and passes its mocks in.
export interface WorkbenchApiMocks { getJson: Mock; patchJson: Mock; postJson: Mock }

export function defaultConsoleState(): ConsoleState {
  return {
    mode: 'connected', activePersonalSpaceId: 'space-a',
    personalSpaces: [{ id: 'space-a', name: '我' }],
    personalProjects: [{ project_id: 'project-a', personal_space_id: 'space-a', profile: { name: '验收项目', sources: [], boundaries: [] } }],
    projects: [], subscriptions: [],
  }
}

export async function resetEmployeeWorkbench({ getJson, patchJson, postJson }: WorkbenchApiMocks) {
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
}

const mounted: Array<{ unmount: () => void }> = []
export function unmountEmployeeWorkbenches() { for (const wrapper of mounted.splice(0)) wrapper.unmount() }

export async function mountEmployeeWorkbench(path: string) {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/employees/:templateId', component: EmployeeWorkbenchPage }, { path: '/project-agents', component: { template: '<p>Agents</p>' } }] })
  await router.push(path)
  const wrapper = mount(EmployeeWorkbenchPage, { global: { plugins: [router] } })
  mounted.push(wrapper)
  await flushPromises()
  return wrapper
}
