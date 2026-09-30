import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it, vi } from 'vitest'
vi.mock('./catalog', async () => {
  const { ref } = await import('vue')
  return { employeeTemplates: ref([{ id: 'jefa', name: 'Jefa', role: '项目经理', agentId: 'employee.jefa', agentStatus: 'active', runtime: 'native' }]), refreshEmployeeCatalog: vi.fn() }
})
vi.mock('@/api/client', () => ({ getJson: vi.fn().mockResolvedValue({ items: [], total: 2, counts: { 'employee.jefa': 2 } }) }))
import EmployeeNavigation from './EmployeeNavigation.vue'
import { useAgentAttention } from '../project-agents/attention-store'

describe('employee raised hand', () => {
  it('opens the manager queue independently of the employee page link', async () => {
    setActivePinia(createPinia())
    const store = useAgentAttention()
    store.setSpace('space-a')
    const wrapper = mount(EmployeeNavigation, { props: { personalSpaceId: 'space-a' }, global: { stubs: { RouterLink: { props: ['to'], template: '<a :href="to"><slot /></a>' } } } })
    await flushPromises()
    const button = wrapper.get('button.agent-hand')
    expect(button.element.closest('a')).toBeNull()
    await button.trigger('click')
    expect(store.open).toBe(true)
    expect(store.agentId).toBe('employee.jefa')
    expect(wrapper.get('a').attributes('href')).toBe('/agents/space-a/employee.jefa')
    expect(wrapper.get('.employee-workbench-link').attributes('href')).toBe('/employees/jefa')
  })
})
