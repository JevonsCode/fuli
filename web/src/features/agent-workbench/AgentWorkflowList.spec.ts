import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

import AgentWorkflowList from './AgentWorkflowList.vue'
import type { AgentWorkflow } from './agent-workflows'

vi.mock('@/api/client', async (original) => ({ ...(await original<typeof import('@/api/client')>()), getJson: vi.fn(), postJson: vi.fn() }))

const version = (name: string) => ({ workflowId: name, version: 1, name, purpose: `Purpose of ${name}`, steps: [{ title: `Step of ${name}` }], source: 'agent', createdBy: 'agent', createdAt: '2026-11-01T00:00:00Z' })
const workflow = (name: string) => ({ workflowId: name, status: 'proposed', personalProjectId: 'project-a', versionCount: 1, active: null, pending: version(name), recentRuns: [], createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' }) as unknown as AgentWorkflow
const many = (count: number) => Array.from({ length: count }, (_, index) => workflow(`flow-${index}`))

// Jevons 11-04: one is shown whole, several are an index, many get a search; each opens over the whole app.
describe('AgentWorkflowList', () => {
  it('shows a single workflow whole', () => {
    const wrapper = mount(AgentWorkflowList, { props: { workflows: many(1) } })
    expect(wrapper.text()).toContain('Step of flow-0')
    expect(wrapper.find('[data-workflow-tile]').exists()).toBe(false)
  })

  it('lists several as cards and opens one over the whole app', async () => {
    const wrapper = mount(AgentWorkflowList, { props: { workflows: many(2) }, attachTo: document.body })
    expect(wrapper.findAll('[data-workflow-tile]')).toHaveLength(2)
    expect(wrapper.text()).not.toContain('Step of flow-1')
    expect(wrapper.find('[data-workflow-search]').exists()).toBe(false)
    await wrapper.get('[data-workflow-tile="flow-1"]').trigger('click'); await flushPromises()
    expect(document.querySelector('[data-workflow-full]')?.textContent).toContain('Step of flow-1')
    wrapper.unmount()
  })

  it('offers a search once there are many', async () => {
    const wrapper = mount(AgentWorkflowList, { props: { workflows: many(7) } })
    await wrapper.get('input[type="search"]').setValue('flow-3')
    expect(wrapper.findAll('[data-workflow-tile]')).toHaveLength(1)
  })
})
