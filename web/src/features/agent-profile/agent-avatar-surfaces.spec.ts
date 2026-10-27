import { mount, RouterLinkStub } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { ProjectAgentRecord } from '@/types'
import AgentCard from './AgentCard.vue'
import AgentPeek from './AgentPeek.vue'
import PinnedAgentsRail from './PinnedAgentsRail.vue'
import { agentAvatarUrl } from './agent-avatar'

const agent = {
  agentId: 'avatar-person', personalSpaceId: 'space-a', assignments: [],
  profile: { name: 'Aster', occupationEmoji: '🔧', status: 'active', responsibility: 'Build', capabilities: [] },
} as unknown as ProjectAgentRecord

vi.mock('vue-router', async (original) => ({
  ...await original<object>(), useRoute: () => ({ path: '/agents/space-a/avatar-person' }),
}))
vi.mock('./agent-pins', async (original) => ({
  ...await original<object>(),
  useAgentPinsState: () => ({ agentIds: ref(['avatar-person']), error: ref('') }),
}))
vi.mock('./useAgentRecords', () => ({
  useAgentRecords: () => ({ records: ref({ 'avatar-person': agent }), error: ref('') }),
}))

const global = { stubs: { RouterLink: RouterLinkStub, AgentHand: true,
  DialogHeader: { template: '<div><slot /></div>' },
  DialogTitle: { template: '<div><slot /></div>' },
  DialogDescription: { template: '<div><slot /></div>' },
  DialogFooter: { template: '<div><slot /></div>' },
} }

describe('Shared portrait surfaces', () => {
  it('uses the same local identity image in directory, quick look and both pinned rail modes', async () => {
    const card = mount(AgentCard, { props: { agent, spaceId: 'space-a' }, global })
    const peek = mount(AgentPeek, { props: { agent, state: 'ready', projectNames: {} }, global })
    const rail = mount(PinnedAgentsRail, { props: { spaceId: 'space-a', expanded: true }, global })
    const expected = agentAvatarUrl(agent.agentId)
    for (const wrapper of [card, peek, rail]) {
      expect(wrapper.get('img').attributes('src')).toBe(expected)
      expect(wrapper.get('img').attributes('alt')).toBe('')
    }
    await rail.setProps({ expanded: false })
    expect(rail.get('img').attributes('src')).toBe(expected)
    expect(rail.get('[data-pinned-agent]').attributes('aria-label')).toContain('Aster')
    for (const wrapper of [card, peek, rail]) wrapper.unmount()
  })
})
