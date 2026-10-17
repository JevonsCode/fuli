import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectAgentRecord } from '@/types'
import AgentOccupationEditor from './AgentOccupationEditor.vue'

const { putJson } = vi.hoisted(() => ({ putJson: vi.fn() }))
vi.mock('@/api/client', () => ({ putJson, getJson: vi.fn(), postJson: vi.fn(), patchJson: vi.fn() }))

const agent: ProjectAgentRecord = {
  agentId: 'alpha', personalSpaceId: 'space-a', createdAt: '', updatedAt: '',
  profile: { name: 'Aster', responsibility: 'Synthetic role', capabilities: [], initialPreferences: [], status: 'active' },
  occupation: { role: 'design', tags: ['product', 'research', 'data', 'writing', 'testing'], updatedAt: '2026-10-17T00:00:00Z' },
}

describe('AgentOccupationEditor', () => {
  beforeEach(() => putJson.mockReset())

  it('starts from the stored occupation and caps tags at five', () => {
    const wrapper = mount(AgentOccupationEditor, { props: { agent } })
    expect(wrapper.get('[data-occupation-tag="product"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.get('[data-occupation-tag="engineering"]').attributes('disabled')).toBeDefined()
  })

  it('keeps the chosen tags and reports a failed save without claiming success', async () => {
    putJson.mockRejectedValueOnce(new Error('Provider unavailable'))
    const wrapper = mount(AgentOccupationEditor, { props: { agent } })
    await wrapper.get('[data-occupation-tag="testing"]').trigger('click')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(putJson).toHaveBeenCalledWith('/api/project-agents/alpha/occupation', {
      personalSpaceId: 'space-a', role: 'design', tags: ['product', 'research', 'data', 'writing'],
    })
    expect(wrapper.get('[role="alert"]').text()).toBe('Provider unavailable')
    expect(wrapper.find('[role="status"]').exists()).toBe(false)
    expect(wrapper.emitted('saved')).toBeUndefined()
  })
})
