import { mount, RouterLinkStub } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
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
    expect(running.attributes('style')).toMatch(/--agent-identity: var\(--identity-[0-7]\)/)
    expect(running.classes()).toContain('is-working')
    for (const status of ['none', 'blocked', 'unreported']) {
      expect(render({ agent: { ...agent, agentId: 'custom' }, entry: entry(status) }).get('[data-card-portrait]').classes()).not.toContain('is-working')
    }
  })
  it('gives each initials portrait the same identity colour as the profile and pinned nav', () => {
    // Only the identity colours; the working-ring phase follows the wall clock.
    const style = (agentId: string) => (render({ agent: { ...agent, agentId } }).get('[data-card-portrait]').attributes('style') ?? '')
      .split(';').filter(rule => rule.includes('--agent-identity')).join(';')
    expect(style('custom-a')).toMatch(/--agent-identity: var\(--identity-[0-7]\)/)
    expect(style('custom-a')).toBe(style('custom-a'))
    const colours = new Set(['a', 'b', 'c', 'd', 'e', 'f'].map(id => style(`agent-${id}`)))
    expect(colours.size).toBeGreaterThan(1)
    expect(render({ agent: { ...agent, agentId: 'custom-a' } }).get('[data-card-portrait]').classes()).toContain('agent-card-identity')
  })
  it('starts the working ring at the shared clock phase so re-renders never restart it', () => {
    vi.spyOn(Date, 'now').mockReturnValue(2400 * 10 + 900)
    expect(render({ agent: { ...agent, agentId: 'custom-a' } }).get('[data-card-portrait]').attributes('style')).toContain('--working-phase: -900ms')
    vi.restoreAllMocks()
  })
  it('shows the person-set occupation next to the name and nothing when unset', () => {
    const classified = render({ agent: { ...agent, occupation: { role: 'product', tags: ['writing'], updatedAt: '2026-10-17T00:00:00Z' } } })
    expect(classified.get('[data-occupation]').text()).toBe('产品 · 写作')
    expect(render().find('[data-occupation]').exists()).toBe(false)
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
    expect(wrapper.get('.growth-loading').attributes('aria-label')).toMatch(/Saving pin|正在保存置顶/)
  })

  it('renders name, occupation (including lead/assistant), summary and current task on the card', () => {
    const wrapper = render({
      agent: {
        ...agent,
        agentId: 'agent-lead',
        profile: { ...agent.profile, name: 'Rowan', responsibility: '负责拆活、派活、整合，对用户汇报。' },
        occupation: { role: 'lead', tags: ['engineering'], updatedAt: '2026-10-18T00:00:00Z' },
      },
      entry: {
        status: 'running',
        source: 'tasks',
        taskId: 'task-101',
        title: '收口 R-06 项目视图改造',
        runningSince: '2026-10-18T00:00:00Z',
        lastUpdateAt: '2026-10-18T00:05:00Z',
      },
    })
    expect(wrapper.get('.agent-directory-name').text()).toContain('Rowan')
    expect(wrapper.get('[data-occupation]').text()).toBe('组长 · 开发')
    expect(wrapper.get('[data-agent-summary]').text()).toBe('负责拆活、派活、整合，对用户汇报。')
    expect(wrapper.get('[data-current-task]').text()).toContain('收口 R-06 项目视图改造')
  })
})
