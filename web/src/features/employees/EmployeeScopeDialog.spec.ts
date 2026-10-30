import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'
import type { PersonalProject } from '@/types'
import { setLocale } from '@/i18n'

const { getJson, postJson } = vi.hoisted(() => ({ getJson: vi.fn(), postJson: vi.fn() }))
vi.mock('@/api/client', () => ({ getJson, postJson }))
import EmployeeScopeDialog from './EmployeeScopeDialog.vue'
import EmployeeWorkbenchLinks from './EmployeeWorkbenchLinks.vue'
import { employeeCatalogLoading, employeeTemplates, refreshEmployeeCatalog, type EmployeeTemplate } from './catalog'

const projects: PersonalProject[] = [{
  project_id: 'project-a', personal_space_id: 'space-a',
  profile: { name: '招募验收项目', sources: [], boundaries: [] },
}, {
  project_id: 'project-b', personal_space_id: 'space-a',
  profile: { name: '第二个验收项目', sources: [], boundaries: [] },
}, {
  project_id: 'archived', personal_space_id: 'space-a',
  profile: { name: '归档项目', sources: [], boundaries: [], lifecycle: 'archived' },
}]
const fresh = (): EmployeeTemplate => ({
  id: 'jefa', version: '1.0.0', name: 'Jefa', role: '项目经理', description: '整理任务与目标',
  capabilities: ['项目管理'], permissions: ['board.read', 'board.write'],
  runtime: { apiVersion: 1 }, runtimeStatus: 'ready', agentId: null, agentStatus: null,
  assignments: [], assignmentsVersion: 'version-0', identityConflict: false,
})
let entry = fresh()
const mounted: Array<{ unmount: () => void }> = []

beforeEach(async () => {
  setActivePinia(createPinia())
  await refreshEmployeeCatalog('')
  setLocale('zh-CN', { persist: false })
  getJson.mockReset()
  postJson.mockReset()
  entry = fresh()
  getJson.mockImplementation(async () => ({ templates: [structuredClone(entry)] }))
})
afterEach(() => { for (const wrapper of mounted.splice(0)) wrapper.unmount() })

async function setup(projectsList = projects, props: { templateId?: string } = {}) {
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/:pathMatch(.*)*', component: { template: '<div />' } },
  ] })
  await router.push('/project-agents')
  const wrapper = mount(EmployeeScopeDialog, {
    attachTo: document.body, props: { open: true, personalSpaceId: 'space-a', projects: projectsList, templateId: 'jefa', ...props },
    global: { plugins: [router] },
  })
  mounted.push(wrapper)
  await flushPromises()
  return { wrapper, router }
}

describe('employee project scope', () => {
  it('edits one named role and offers no hiring step', async () => {
    const { wrapper } = await setup()
    expect(wrapper.get('h2').text()).toBe('管理 Jefa 的项目')
    expect(wrapper.find('[data-control-id="employee-template"], #employee-template').exists()).toBe(false)
    expect(wrapper.text()).not.toMatch(/聘请|恢复/)
    expect(wrapper.get('button[type="submit"]').text()).toBe('保存负责范围')
  })

  it('lists people-made projects before fallback session projects, which are named by last use', async () => {
    const fallback: PersonalProject = {
      project_id: `conversation-${'f'.repeat(64)}`, personal_space_id: 'space-a', updated_at: '2026-10-17T07:20:00Z',
      profile: { name: '会话项目 / Conversation project', sources: [], boundaries: [] },
    }
    const { wrapper } = await setup([fallback, ...projects])
    const labels = wrapper.findAll('label').map(label => label.text()).filter(text => /项目/.test(text))
    const formal = labels.findIndex(text => text.includes('招募验收项目'))
    const session = labels.findIndex(text => text.startsWith('会话项目 · '))
    expect(formal).toBeGreaterThanOrEqual(0)
    expect(session).toBeGreaterThan(formal)
    expect(wrapper.text()).not.toContain('Conversation project')
  })

  it('reads a fresh management snapshot without toggling the shared catalog state', async () => {
    const { wrapper } = await setup()
    expect(wrapper.find('form').exists()).toBe(true)
    expect(employeeCatalogLoading.value).toBe(false)
    expect(employeeTemplates.value).toEqual([])
  })

  it('supports all current and future projects with explicit exclusions and keeps exclusion IDs when projects disappear', async () => {
    entry.management = { mode: 'all', projectIds: [], excludedProjectIds: ['temporarily-unavailable'], titleMode: 'auto', titleStyle: 'emoji' }
    entry.permissions.push('session.title')
    const { wrapper } = await setup()
    expect(wrapper.get('[data-scope="all"]').attributes('aria-checked')).toBe('true')
    expect(wrapper.text()).toContain('以后的项目')
    expect(wrapper.get('.project-scope-picker').find('select').exists()).toBe(false)
    expect(wrapper.find('select:not([aria-hidden="true"])').exists()).toBe(false)
    expect(wrapper.findAll('.employee-title-settings .ui-select')).toHaveLength(2)
    expect(wrapper.get('.project-scope-count').text()).toContain('2 / 共 2')
    await wrapper.get('input[value="project-b"]').setValue(false)
    expect(wrapper.text()).not.toContain('将移出')
    const future = { ...projects[0]!, project_id: 'future-project', profile: { ...projects[0]!.profile, name: 'Future project' } }
    await wrapper.setProps({ projects: [...projects, future] })
    expect((wrapper.get('input[value="future-project"]').element as HTMLInputElement).checked).toBe(true)
    postJson.mockRejectedValue(new Error('Synthetic response'))
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(postJson.mock.calls[0]![1]).toMatchObject({ management: {
      mode: 'all', projectIds: [], excludedProjectIds: ['project-b', 'temporarily-unavailable'], titleMode: 'auto', titleStyle: 'emoji',
    }, expectedAssignmentsVersion: 'version-0' })
    expect(postJson.mock.calls[0]![1]).not.toHaveProperty('personalProjectIds')
    expect(wrapper.text()).toContain('手动改过的标题不再覆盖')
  })

  it('switches to a fixed selection with keyboard access, without silently including future projects', async () => {
    entry.management = { mode: 'all', projectIds: [], excludedProjectIds: [], titleMode: 'suggest', titleStyle: 'text' }
    const { wrapper } = await setup()
    await wrapper.get('[role="radiogroup"]').trigger('keydown', { key: 'ArrowRight' })
    expect(wrapper.get('[data-scope="selected"]').attributes('aria-checked')).toBe('true')
    const future = { ...projects[0]!, project_id: 'future-project', profile: { ...projects[0]!.profile, name: 'Future project' } }
    await wrapper.setProps({ projects: [...projects, future] })
    expect((wrapper.get('input[value="future-project"]').element as HTMLInputElement).checked).toBe(false)
    postJson.mockRejectedValue(new Error('Synthetic response'))
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(postJson.mock.calls[0]![1]).toMatchObject({ management: { mode: 'selected', projectIds: ['project-a', 'project-b'], excludedProjectIds: [] } })
  })

  it('saves a built-in role\'s projects and shows the saved scope read back (rec#58)', async () => {
    entry = { ...fresh(), id: 'bole', name: 'Bole', role: 'AR', runtime: null, agentId: 'employee.bole', agentStatus: 'active',
      management: { mode: 'all', projectIds: [], excludedProjectIds: [], titleMode: 'suggest', titleStyle: 'emoji' } }
    const { wrapper } = await setup(projects, { templateId: 'bole' })
    expect(wrapper.get('h2').text()).toBe('管理 Bole 的项目')
    await wrapper.get('[data-scope="selected"]').trigger('click')
    await wrapper.get('input[value="project-b"]').setValue(false)
    postJson.mockImplementation(async () => {
      entry.management = { mode: 'selected', projectIds: ['project-a'], excludedProjectIds: [], titleMode: 'suggest', titleStyle: 'emoji' }
      entry.assignments = [{ assignmentId: 'assignment-a', agentId: 'employee.bole', personalSpaceId: 'space-a', personalProjectId: 'project-a', responsibility: 'AR', status: 'active', assignedAt: '2026-10-31T00:00:00Z', updatedAt: '2026-10-31T00:00:00Z' }]
      entry.assignmentsVersion = 'version-1'
      return { templateId: 'bole', agent: { agentId: 'employee.bole' }, assignment: null, assignments: entry.assignments, endedAssignments: [], assignmentsVersion: 'version-1', idempotent: false }
    })
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(postJson).toHaveBeenCalledWith('/api/employee-templates/bole/recruit', { personalSpaceId: 'space-a',
      management: { mode: 'selected', projectIds: ['project-a'], excludedProjectIds: [], titleMode: 'suggest', titleStyle: 'emoji' },
      replaceAssignments: true, expectedAssignmentsVersion: 'version-0' })
    expect(wrapper.text()).toContain('负责范围已保存')
    // Read back: the saved selection is the new baseline at its new version.
    expect(wrapper.get('[data-scope="selected"]').attributes('aria-checked')).toBe('true')
    expect((wrapper.get('input[value="project-b"]').element as HTMLInputElement).checked).toBe(false)
    expect(wrapper.get('footer a').attributes('href')).toBe('/employees/bole?project=project-a')
  })

  it('says why FULI keeps a built-in Agent\'s scope when the save is refused', async () => {
    const { wrapper } = await setup()
    await wrapper.get('input[value="project-a"]').setValue(true)
    postJson.mockRejectedValueOnce(new Error(JSON.stringify({ code: 'system_managed_employee' })))
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('由 FULI 自动维护')
  })

  it('keeps an existing fixed scope until the user explicitly enables all-project management', async () => {
    entry.agentId = 'employee.jefa'
    entry.agentStatus = 'active'
    entry.defaultProjectScope = 'all'
    entry.management = { mode: 'selected', projectIds: [], excludedProjectIds: [], titleMode: 'auto', titleStyle: 'emoji' }
    const { wrapper } = await setup()
    expect(wrapper.get('[data-scope="selected"]').attributes('aria-checked')).toBe('true')
    expect(wrapper.get('.project-scope-count').text()).toContain('0 / 共 2')
    expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeDefined()
    await wrapper.get('[data-scope="all"]').trigger('click')
    expect(wrapper.get('.project-scope-count').text()).toContain('2 / 共 2')
    expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeUndefined()
  })

  it('uses a custom project picker, saves the exact project, then exposes the workbench and sidebar entry', async () => {
    const { wrapper, router } = await setup()
    expect(wrapper.find('select').exists()).toBe(false)
    expect(wrapper.find('.project-scope-trigger').exists()).toBe(false)
    await wrapper.get('input[value="project-a"]').setValue(true)
    postJson.mockImplementation(async () => {
      entry.agentId = 'employee.jefa'
      entry.agentStatus = 'active'
      entry.assignments = [{ assignmentId: 'assignment-a', agentId: 'employee.jefa', personalSpaceId: 'space-a', personalProjectId: 'project-a', responsibility: '项目管理', status: 'active', assignedAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z' }]
      entry.assignmentsVersion = 'version-1'
      return { templateId: 'jefa', agent: { agentId: entry.agentId }, assignment: entry.assignments[0], assignments: entry.assignments, endedAssignments: [], assignmentsVersion: entry.assignmentsVersion, idempotent: false }
    })
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(postJson).toHaveBeenCalledWith('/api/employee-templates/jefa/recruit', { personalSpaceId: 'space-a', personalProjectIds: ['project-a'], replaceAssignments: true, expectedAssignmentsVersion: 'version-0' })
    expect(wrapper.emitted('saved')).toHaveLength(1)
    expect(wrapper.text()).toContain('负责范围已保存')
    expect(wrapper.get('footer a').attributes('href')).toBe('/employees/jefa?project=project-a')
    await wrapper.get('form').trigger('submit')
    expect(postJson).toHaveBeenCalledTimes(1)
    const links = mount(EmployeeWorkbenchLinks, { props: { personalSpaceId: 'space-a' }, global: { plugins: [router] } })
    mounted.push(links)
    await flushPromises()
    expect(links.get('a').attributes('href')).toBe('/employees/jefa')
    expect(links.text()).toContain('Jefa')
  })

  it('saves an empty scope without creating a project', async () => {
    const { wrapper } = await setup([])
    postJson.mockResolvedValue({ templateId: 'jefa', agent: { agentId: 'employee.jefa' }, assignment: null, idempotent: false })
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(postJson).toHaveBeenCalledWith('/api/employee-templates/jefa/recruit', { personalSpaceId: 'space-a', personalProjectIds: [], replaceAssignments: true, expectedAssignmentsVersion: 'version-0' })
    expect(wrapper.find('footer a').exists()).toBe(false)
    expect(wrapper.text()).toContain('创建项目')
  })

  it('surfaces a failed save and supports retry without closing the dialog', async () => {
    const { wrapper } = await setup()
    postJson.mockRejectedValueOnce(new Error(JSON.stringify({ code: 'identity_conflict' })))
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('标识')
    expect(wrapper.emitted('close')).toBeUndefined()
    expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeUndefined()
  })

  it('selects all available projects, excludes individually, and never submits archived projects', async () => {
    const { wrapper } = await setup()
    expect(wrapper.find('input[value="archived"]').exists()).toBe(false)
    await wrapper.get('.project-scope-all input').setValue(true)
    expect(wrapper.get('.project-scope-count').text()).toContain('2 / 共 2')
    await wrapper.get('input[value="project-b"]').setValue(false)
    postJson.mockRejectedValue(new Error('Synthetic failure preserves selection'))
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(postJson.mock.calls[0]![1]).toMatchObject({ personalProjectIds: ['project-a'] })
    expect(wrapper.text()).toContain('新建项目需另行选择')
  })

  it('preselects existing assignments and lets the user remove a project with its last-read version', async () => {
    entry.agentId = 'employee.jefa'
    entry.agentStatus = 'active'
    entry.assignments = ['project-a', 'project-b'].map((personalProjectId) => ({
      assignmentId: personalProjectId, personalProjectId, agentId: 'employee.jefa', personalSpaceId: 'space-a',
      status: 'active', responsibility: '管理', assignedAt: '', updatedAt: '',
    }))
    const { wrapper } = await setup()
    expect(wrapper.find('footer a').exists()).toBe(true)
    await wrapper.get('input[value="project-b"]').setValue(false)
    expect(wrapper.text()).toContain('将移出 1 个项目')
    expect(wrapper.find('footer a').exists()).toBe(false)
    expect(wrapper.get('button[type="submit"]').text()).toBe('保存负责范围')
    postJson.mockRejectedValue(new Error(JSON.stringify({ code: 'assignment_scope_conflict' })))
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('在别处改变')
    expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeDefined()
    await wrapper.get('form').trigger('submit')
    expect(postJson).toHaveBeenCalledTimes(1)
    entry.assignmentsVersion = 'version-2'
    entry.assignments = []
    await wrapper.findAll('button').find((button) => button.text() === '重新读取负责范围')!.trigger('click')
    await flushPromises()
    expect(wrapper.get('.project-scope-count').text()).toContain('0 / 共 2')
    await wrapper.get('input[value="project-a"]').setValue(true)
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(postJson.mock.calls[1]![1]).toMatchObject({ personalProjectIds: ['project-a'], expectedAssignmentsVersion: 'version-2' })
  })

  it('does not mistake ended assignments for current scope', async () => {
    entry.agentId = 'employee.jefa'
    entry.agentStatus = 'active'
    entry.assignments = [{ assignmentId: 'ended', personalProjectId: 'project-b', agentId: 'employee.jefa', personalSpaceId: 'space-a', status: 'ended', responsibility: '管理', assignedAt: '', updatedAt: '' }]
    const { wrapper } = await setup(projects)
    expect(wrapper.get('h2').text()).toBe('管理 Jefa 的项目')
    expect(wrapper.get('.project-scope-count').text()).toContain('0 / 共 2')
    expect(wrapper.findAll('.project-scope-list input').every((input) => !(input.element as HTMLInputElement).checked)).toBe(true)
    expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeDefined()
  })

  it('keeps the last-read baseline when another consumer refreshes the employee catalog', async () => {
    entry.agentId = 'employee.jefa'
    entry.agentStatus = 'active'
    const { wrapper } = await setup()
    await wrapper.get('input[value="project-a"]').setValue(true)
    entry.assignmentsVersion = 'version-elsewhere'
    entry.assignments = [{ assignmentId: 'new', personalProjectId: 'project-b', agentId: 'employee.jefa', personalSpaceId: 'space-a', status: 'active', responsibility: '管理', assignedAt: '', updatedAt: '' }]
    await refreshEmployeeCatalog('space-a')
    await flushPromises()
    expect(wrapper.text()).not.toContain('将移出')
    postJson.mockRejectedValue(new Error(JSON.stringify({ code: 'assignment_scope_conflict' })))
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(postJson.mock.calls[0]![1]).toMatchObject({ personalProjectIds: ['project-a'], expectedAssignmentsVersion: 'version-0' })
    expect(wrapper.get('[role="alert"]').text()).toContain('在别处改变')
  })

  it('never falls back to a different employee when the requested template is unavailable', async () => {
    const { wrapper } = await setup(projects, { templateId: 'unavailable-role' })
    expect(wrapper.find('button[type="submit"]').exists()).toBe(false)
    expect(postJson).not.toHaveBeenCalled()
  })
})
