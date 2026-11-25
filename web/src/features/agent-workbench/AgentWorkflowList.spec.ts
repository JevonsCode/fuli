import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import AgentWorkflowList from './AgentWorkflowList.vue'
import type { AgentWorkflow } from './agent-workflows'
import { setLocale } from '@/i18n'

vi.mock('@/api/client', async (original) => ({ ...(await original<typeof import('@/api/client')>()), getJson: vi.fn(), postJson: vi.fn() }))

const version = (name: string) => ({ workflowId: name, version: 1, name, purpose: `Purpose of ${name}`, steps: [{ title: `Step of ${name}` }], source: 'agent', createdBy: 'agent', createdAt: '2026-11-01T00:00:00Z' })
const workflow = (name: string) => ({ workflowId: name, status: 'proposed', personalProjectId: 'project-a', versionCount: 1, active: null, pending: version(name), recentRuns: [], createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' }) as unknown as AgentWorkflow
const many = (count: number) => Array.from({ length: count }, (_, index) => workflow(`flow-${index}`))

// Jevons 11-04: one is shown whole, several are an index, many get a search; each opens over the whole app.
describe('AgentWorkflowList', () => {
  beforeEach(() => { setLocale('en-US', { persist: false }) })

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

  it('says how often a confirmed workflow was used, and nothing for one never run', () => {
    const used = { ...workflow('flow-0'), status: 'active', active: version('flow-0'), pending: null, runCount: 7, doneCount: 6 } as unknown as AgentWorkflow
    expect(mount(AgentWorkflowList, { props: { workflows: [used] } }).get('[data-workflow-run-totals]').text()).toMatch(/7.*6/)
    const unused = { ...used, runCount: 0, doneCount: 0 } as unknown as AgentWorkflow
    expect(mount(AgentWorkflowList, { props: { workflows: [unused] } }).find('[data-workflow-run-totals]').exists()).toBe(false)
  })

  it('shows what a kept lesson is for, its pitfalls, the evidence it worked and the delivery it came from', () => {
    const lesson = version('flow-0')
    Object.assign(lesson, { source: 'lesson:abc123', lesson: { trigger: 'A release needs checking', scope: 'This project',
      pitfalls: ['Do not start with the full suite'], acceptanceEvidence: ['The focused suite passed first'] },
      delivery: { conversationId: 'conversation-7', revision: 3 } })
    const kept = { ...workflow('flow-0'), status: 'active', active: lesson, pending: null } as unknown as AgentWorkflow
    const wrapper = mount(AgentWorkflowList, { props: { workflows: [kept] } })
    expect(wrapper.get('[data-workflow-lesson]').text()).toContain('A release needs checking')
    expect(wrapper.get('[data-workflow-pitfalls]').text()).toContain('Do not start with the full suite')
    expect(wrapper.get('[data-workflow-evidence]').text()).toContain('The focused suite passed first')
    expect(wrapper.get('[data-workflow-delivery]').text()).toContain('conversation-7')
    expect(wrapper.text()).toContain('You asked to do this next time')
  })
})
