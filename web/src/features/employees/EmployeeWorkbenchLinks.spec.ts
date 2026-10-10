import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
vi.mock('./catalog', async () => {
  const { ref } = await import('vue')
  return { employeeTemplates: ref([
    { id: 'jefa', name: 'Jefa', role: '项目经理', agentId: 'employee.jefa', agentStatus: 'active', runtime: { apiVersion: 1 } },
    { id: 'bole', name: 'Bole', role: 'HR', agentId: 'employee.bole', agentStatus: 'active', runtime: null, workbench: { kind: 'native', view: 'people' } },
    { id: 'idle', name: 'Idle', role: 'Identity only', agentId: 'employee.idle', agentStatus: 'active', runtime: null },
  ]), refreshEmployeeCatalog: vi.fn() }
})
import EmployeeWorkbenchLinks from './EmployeeWorkbenchLinks.vue'

describe('EmployeeWorkbenchLinks', () => {
  it('links only to employees that have a workbench', () => {
    const wrapper = mount(EmployeeWorkbenchLinks, { props: { personalSpaceId: 'space-a' },
      global: { stubs: { RouterLink: { props: ['to'], template: '<a :href="to"><slot /></a>' } } } })
    expect(wrapper.findAll('a').map(link => link.attributes('href'))).toEqual(['/employees/jefa', '/employees/bole'])
    expect(wrapper.text()).toContain('Jefa · 项目经理')
  })
})
