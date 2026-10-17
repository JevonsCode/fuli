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
  it.each(['jefa', 'bole', 'tonborg'])('uses the %s portrait instead of its occupation icon', (id) => {
    const wrapper = render({ agent: { ...agent, agentId: `employee.${id}`, profile: { ...agent.profile, occupationEmoji: '⚖️' } } })
    expect(wrapper.get('.agent-portrait img').attributes('src')).toContain(`${id}-avatar.webp`)
    expect(wrapper.get('.agent-portrait').text()).toBe('')
  })
  it('keeps the occupation icon for an Agent without a portrait', () => {
    const wrapper = render({ agent: { ...agent, agentId: 'custom', profile: { ...agent.profile, occupationEmoji: '🔧' } } })
    expect(wrapper.get('.agent-portrait').text()).toBe('🔧')
  })
  it('uses the Agent identity colour and moves only for a reported running state', () => {
    const entry = (status: string) => ({ status, source: 'roster', taskId: null, title: null, lastUpdateAt: null })
    const running = render({ agent: { ...agent, agentId: 'custom' }, entry: entry('running') }).get('[data-card-portrait]')
    expect(running.attributes('style')).toMatch(/--agent-identity: #[0-9a-f]{6}/)
    expect(running.classes()).toContain('is-working')
    for (const status of ['none', 'blocked', 'unreported']) {
      expect(render({ agent: { ...agent, agentId: 'custom' }, entry: entry(status) }).get('[data-card-portrait]').classes()).not.toContain('is-working')
    }
  })
  it('gives each initials portrait the same identity colour as the profile and pinned nav', () => {
    const style = (agentId: string) => render({ agent: { ...agent, agentId } }).get('[data-card-portrait]').attributes('style')
    expect(style('custom-a')).toMatch(/--agent-identity: #[0-9a-f]{6}/)
    expect(style('custom-a')).toBe(style('custom-a'))
    const colours = new Set(['a', 'b', 'c', 'd', 'e', 'f'].map(id => style(`agent-${id}`)))
    expect(colours.size).toBeGreaterThan(1)
    expect(render({ agent: { ...agent, agentId: 'custom-a' } }).get('[data-card-portrait]').classes()).toContain('agent-card-identity')
  })
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
    expect(wrapper.get('.growth-loading').attributes('aria-label')).toMatch(/Saving pin|正在保存 pin/)
  })
})
