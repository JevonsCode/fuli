import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const { getJson } = vi.hoisted(() => ({ getJson: vi.fn() }))
vi.mock('@/api/client', () => ({ getJson }))

import BolePeoplePanel from './BolePeoplePanel.vue'
import ProjectScopePicker from './ProjectScopePicker.vue'

const projects = [
  { project_id: 'project-a', personal_space_id: 'space-a', profile: { name: '复利' } },
  { project_id: 'project-b', personal_space_id: 'space-a', profile: { name: '第二项目' } },
]

beforeEach(() => {
  setActivePinia(createPinia())
  getJson.mockReset()
  getJson.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/project-agents?')) return { agents: [
      {
        agent_id: 'employee.bole', personal_space_id: 'space-a',
        profile: { name: 'Bole', responsibility: '招募与人员配置', status: 'active', agent_type: 'hr', occupation_emoji: '🔎' },
        created_at: '2026-09-01T08:00:00.000Z', updated_at: '2026-09-01T08:00:00.000Z',
      },
      {
        agent_id: 'employee.jefa', personal_space_id: 'space-a',
        profile: { name: 'Jefa', responsibility: '项目管理', status: 'active', agent_type: 'durable', occupation_emoji: '🧭' },
        assignments: [{ personal_project_id: 'project-a', status: 'active' }],
        created_at: '2026-09-01T08:00:00.000Z', updated_at: '2026-09-01T08:00:00.000Z',
      },
      {
        agent_id: 'agent.researcher', personal_space_id: 'space-a',
        profile: { name: 'Researcher', responsibility: '调研', status: 'active', agent_type: 'temporary', occupation_emoji: '🧪' },
        personal_project_id: 'project-b',
        created_at: '2026-09-02T08:00:00.000Z', updated_at: '2026-09-02T08:00:00.000Z',
      },
    ] }
    if (url.startsWith('/api/project-agent-tasks?')) return { items: [
      {
        task_id: 'task-a', personal_project_id: 'project-a', title: '整理发布检查项', status: 'running',
        lead_agent_id: 'employee.jefa', coordinator_agent_id: 'system.coordinator', hr_agent_id: 'employee.bole', participants: [], created_at: '2026-09-03T08:00:00.000Z',
      },
    ] }
    if (url.startsWith('/api/project-agent-recruitments?')) return { recruitments: [
      {
        recruitment_id: 'recruit-a', personal_space_id: 'space-a', personal_project_id: 'project-b', task_id: 'task-b',
        coordinator_agent_id: 'system.coordinator', hr_agent_id: 'employee.bole', position_kind: 'temporary', work_kind: 'research',
        required_capabilities: ['research'], reason_code: 'capability_gap', reason: '需要补充用户研究能力', status: 'fulfilled',
        proposed_agent_id: 'agent.researcher', recruited_agent_id: 'agent.researcher', created_at: '2026-09-02T08:00:00.000Z',
        updated_at: '2026-09-02T09:00:00.000Z', fulfilled_at: '2026-09-02T09:00:00.000Z',
      },
    ] }
    throw new Error(`unexpected URL: ${url}`)
  })
})

describe('Bole people panel', () => {
  it('keeps team navigation in the heading without duplicate totals or section headings', async () => {
    const wrapper = mount(BolePeoplePanel, { props: { personalSpaceId: 'space-a', projects } })
    expect(wrapper.get('[data-testid="people-total"]').text()).toBe('—')
    await flushPromises()
    expect(wrapper.find('.bole-heading .bole-views').exists()).toBe(true)
    expect(wrapper.get('#bole-work-title').text()).toContain('3')
    expect(wrapper.findAll('[data-testid="people-total"]')).toHaveLength(1)
    expect(wrapper.get('.bole-summary').text()).not.toContain('在岗')
    expect(wrapper.find('.bole-section-heading').exists()).toBe(false)
    expect(wrapper.get('section').attributes('aria-labelledby')).toBe('bole-work-title')
    await wrapper.get('.bole-search').setValue('Jefa')
    expect(wrapper.get('.bole-result-count').text()).toContain('1')
    await wrapper.get('#bole-history-title').trigger('click')
    expect(wrapper.get('section').attributes('aria-labelledby')).toBe('bole-history-title')
    wrapper.unmount()
  })

  it('shows personnel distribution, current work and recruitment reasons from the shared Agent APIs', async () => {
    const wrapper = mount(BolePeoplePanel, { props: { personalSpaceId: 'space-a', projects } })
    await flushPromises()

    expect(getJson.mock.calls.map(([url]) => url)).toEqual([
      '/api/project-agents?personalSpaceId=space-a',
      '/api/project-agent-tasks?personalSpaceId=space-a&limit=200',
      '/api/project-agent-recruitments?personalSpaceId=space-a',
    ])
    expect(wrapper.get('[data-testid="people-total"]').text()).toContain('3')
    expect(wrapper.get('[data-testid="people-working"]').text()).toContain('1')
    expect(wrapper.text()).toContain('固定 Agent')
    expect(wrapper.text()).toContain('临时 Agent')
    expect(wrapper.text()).toContain('Jefa')
    expect(wrapper.text()).toContain('整理发布检查项')
    expect(wrapper.text()).toContain('复利')
    expect(wrapper.text()).toContain('Researcher')
    expect(wrapper.text()).toContain('第二项目')
    expect(wrapper.find('.bole-timeline').exists()).toBe(false)
    await wrapper.get('.bole-views button:nth-child(2)').trigger('click')
    expect(wrapper.text()).toContain('需要补充用户研究能力')
    expect(wrapper.find('.bole-agent-list').exists()).toBe(false)
  })

  it('filters people by project, work status, role and search without changing records', async () => {
    const wrapper = mount(BolePeoplePanel, { props: { personalSpaceId: 'space-a', projects } })
    await flushPromises()
    expect(wrapper.findAll('.bole-agent-row')).toHaveLength(3)
    expect(wrapper.findAll('.bole-agent-row')[0].text()).toContain('Jefa')
    wrapper.getComponent(ProjectScopePicker).vm.$emit('update:modelValue', ['project-b'])
    await flushPromises()
    expect(wrapper.findAll('.bole-agent-row')).toHaveLength(1)
    expect(wrapper.get('.bole-agent-row').text()).toContain('Researcher')
    await wrapper.get('.bole-filters select').setValue('working')
    expect(wrapper.findAll('.bole-agent-row')).toHaveLength(0)
    await wrapper.get('.bole-clear').trigger('click')
    await wrapper.get('.bole-search').setValue('发布')
    expect(wrapper.get('.bole-agent-row').text()).toContain('Jefa')
    await wrapper.get('.bole-clear').trigger('click')
    const roleButton = wrapper.findAll('.bole-role-filters button').find((button) => button.text().includes('HR Agent'))!
    await roleButton.trigger('click')
    expect(wrapper.findAll('.bole-agent-row')).toHaveLength(1)
    expect(wrapper.get('.bole-agent-row').text()).toContain('Bole')
    expect(getJson).toHaveBeenCalledTimes(3)
  })

  it('supports no selected projects, unassigned Agents and clearing filters', async () => {
    const wrapper = mount(BolePeoplePanel, { props: { personalSpaceId: 'space-a', projects } })
    await flushPromises()
    const picker = wrapper.getComponent(ProjectScopePicker)
    picker.vm.$emit('update:modelValue', [])
    await flushPromises()
    expect(wrapper.text()).toContain('没有匹配的记录')
    const unassigned = picker.props('projects').find((item) => item.name === '未归属项目')!
    picker.vm.$emit('update:modelValue', [unassigned.id])
    await flushPromises()
    expect(wrapper.get('.bole-agent-row').text()).toContain('Bole')
    await wrapper.get('.bole-clear').trigger('click')
    expect(wrapper.findAll('.bole-agent-row')).toHaveLength(3)
  })

  it('searches recruitment reasons and shares the same project scope across views', async () => {
    const wrapper = mount(BolePeoplePanel, { props: { personalSpaceId: 'space-a', projects } })
    await flushPromises()
    await wrapper.get('.bole-views button:nth-child(2)').trigger('click')
    await wrapper.get('.bole-search').setValue('用户研究')
    expect(wrapper.findAll('.bole-timeline li')).toHaveLength(1)
    expect(wrapper.get('time').attributes('datetime')).toBe('2026-09-02T08:00:00.000Z')
    wrapper.getComponent(ProjectScopePicker).vm.$emit('update:modelValue', ['project-a'])
    await flushPromises()
    expect(wrapper.text()).toContain('没有匹配的记录')
    await wrapper.get('.bole-clear').trigger('click')
    expect(wrapper.findAll('.bole-timeline li')).toHaveLength(1)
  })

  it('preserves Provider work state instead of attributing HR/coordinator tasks to them', async () => {
    const original = getJson.getMockImplementation()!
    getJson.mockImplementation(async (url: string) => {
      const result = await original(url)
      if (url.startsWith('/api/project-agents?')) result.agents[1] = { ...result.agents[1], work_status: 'completed', current_task_id: 'task-a' }
      return result
    })
    const wrapper = mount(BolePeoplePanel, { props: { personalSpaceId: 'space-a', projects } })
    await flushPromises()
    expect(wrapper.get('[data-testid="people-working"]').text()).toContain('0')
    expect(wrapper.findAll('.bole-status')).toHaveLength(0)
  })

  it('keeps partial data visible and offers a retry when one source fails', async () => {
    getJson.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/project-agents?')) return { agents: [] }
      throw new Error('暂时不可用')
    })
    const wrapper = mount(BolePeoplePanel, { props: { personalSpaceId: 'space-a', projects } })
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain('部分人员信息暂时不可用')
    expect(wrapper.text()).toContain('还没有可展示的 Agent')
    await wrapper.get('[role="alert"] button').trigger('click')
    await flushPromises()
    expect(getJson).toHaveBeenCalledTimes(6)
  })
})
