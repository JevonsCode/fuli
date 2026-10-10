import { mount, RouterLinkStub } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import AgentCard from './AgentCard.vue'
import type { ProjectAgentRecord } from '@/types'

const agent = {
  agentId: 'employee.jefa', personalSpaceId: 'space-a', assignments: [],
  profile: { name: 'Jefa', status: 'active', responsibility: '项目经理', capabilities: [] },
} as unknown as ProjectAgentRecord

const render = (props: Record<string, unknown> = {}) => mount(AgentCard, {
  props: { agent, spaceId: 'space-a', ...props },
  global: { stubs: { RouterLink: RouterLinkStub, AgentHand: true } },
})

describe('AgentCard projects', () => {
  it('shows the stable FLA employee number', () => {
    expect(render({ agent: { ...agent, employeeNumber: '000001' } }).get('.fla-employee-number').text()).toBe('FLA 000001')
  })
  it('says the Agent manages all projects instead of none when its policy covers every project', () => {
    expect(render({ managesAllProjects: true }).get('.agent-card-projects').text()).toBe('全部项目')
    expect(render().get('.agent-card-projects').text()).toBe('未分配项目')
  })

  it('exposes an accessible pin toggle without navigating the profile', async () => {
    const wrapper = render({ pinned: false })
    const toggle = wrapper.get('[data-agent-pin-toggle]')

    expect(toggle.attributes('aria-pressed')).toBe('false')
    await toggle.trigger('click')

    expect(wrapper.emitted('toggle-pin')).toEqual([[true]])
    expect(wrapper.get('[data-agent-pin-toggle]').attributes('aria-pressed')).toBe('false')
  })

  it('keeps the pin action unavailable while the request is pending', () => {
    const wrapper = render({ pinned: true, pinPending: true })
    const toggle = wrapper.get('[data-agent-pin-toggle]')

    expect(toggle.attributes('aria-pressed')).toBe('true')
    expect(toggle.attributes('disabled')).toBeDefined()
    expect(wrapper.get('.growth-loading').attributes('aria-label')).toMatch(/Saving Agent pin|正在保存 Agent 置顶/)
  })
})
