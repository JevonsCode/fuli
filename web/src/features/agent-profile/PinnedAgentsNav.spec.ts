import { mount, RouterLinkStub } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import PinnedAgentsNav from './PinnedAgentsNav.vue'

const agent = (agentId: string, name: string) => ({
  agentId,
  personalSpaceId: 'space-a',
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
  profile: {
    name,
    responsibility: 'Review work',
    capabilities: [],
    initialPreferences: [],
    status: 'active' as const,
  },
})

describe('PinnedAgentsNav', () => {
  it('renders only pinned identities present in the loaded roster', () => {
    const wrapper = mount(PinnedAgentsNav, {
      props: {
        spaceId: 'space-a',
        agents: [agent('employee.jefa', 'Jefa'), agent('employee.bole', 'Bole')],
        pinnedAgentIds: ['employee.bole', 'employee.unknown'],
        loading: false,
        rosterLoading: false,
        error: '',
      },
      global: { stubs: { RouterLink: RouterLinkStub } },
    })

    expect(wrapper.findAll('.pinned-agent-nav')).toHaveLength(1)
    expect(wrapper.get('.pinned-agent-nav').text()).toContain('Bole')
    expect(wrapper.findComponent(RouterLinkStub).props('to')).toBe('/agents/space-a/employee.bole')
    expect(wrapper.text()).not.toContain('employee.unknown')
  })

  it('keeps an empty server response empty instead of restoring defaults', () => {
    const wrapper = mount(PinnedAgentsNav, {
      props: {
        spaceId: 'space-a',
        agents: [agent('employee.bole', 'Bole')],
        pinnedAgentIds: [],
        loading: false,
        rosterLoading: false,
        error: '',
      },
      global: { stubs: { RouterLink: RouterLinkStub } },
    })

    expect(wrapper.findAll('.pinned-agent-nav')).toHaveLength(0)
    expect(wrapper.get('.pinned-agents-empty').text()).toMatch(/No pinned Agents|暂未置顶 Agent/)
  })

  it('keeps loaded links visible while a refresh shows inline progress', () => {
    const wrapper = mount(PinnedAgentsNav, {
      props: {
        spaceId: 'space-a',
        agents: [agent('employee.bole', 'Bole')],
        pinnedAgentIds: ['employee.bole'],
        loading: true,
        rosterLoading: false,
        error: '',
      },
      global: { stubs: { RouterLink: RouterLinkStub } },
    })

    expect(wrapper.find('.pinned-agent-nav').exists()).toBe(true)
    expect(wrapper.get('.growth-loading--inline').attributes('aria-label')).toMatch(/Reading pinned Agents|正在读取已置顶 Agent/)
  })

  it('shows roster failures instead of presenting an authoritative empty state', async () => {
    const wrapper = mount(PinnedAgentsNav, {
      props: {
        spaceId: 'space-a', agents: [], pinnedAgentIds: [], loading: false, rosterLoading: false,
        error: 'Roster is temporarily unavailable.',
      },
      global: { stubs: { RouterLink: RouterLinkStub } },
    })

    expect(wrapper.find('.pinned-agents-empty').exists()).toBe(false)
    expect(wrapper.get('[role="alert"]').text()).toContain('Roster is temporarily unavailable.')
    await wrapper.get('[role="alert"] button').trigger('click')
    expect(wrapper.emitted('retry')).toHaveLength(1)
  })
})
