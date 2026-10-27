import { flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useOccupationCatalog } from '@/features/occupations/occupation-catalog'
import { SYNTHETIC_OCCUPATIONS } from '@/test-support/occupation-fixtures'
import type { ProjectAgentRecord } from '@/types'
import AgentOccupationEditor from './AgentOccupationEditor.vue'

const { putJson, getJson } = vi.hoisted(() => ({ putJson: vi.fn(), getJson: vi.fn() }))
vi.mock('@/api/client', () => ({ putJson, getJson, postJson: vi.fn(), patchJson: vi.fn() }))

// The editor offers the space catalog's active occupations.
beforeAll(async () => {
  getJson.mockResolvedValue(SYNTHETIC_OCCUPATIONS)
  await useOccupationCatalog(ref('space-a')).load()
})

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

  it('keeps the main role out of the extra tags', async () => {
    putJson.mockResolvedValue({})
    const wrapper = mount(AgentOccupationEditor, { props: { agent: { ...agent, occupation: { role: 'design', tags: ['design', 'product'], updatedAt: '2026-10-17T00:00:00Z' } } } })
    const design = wrapper.get('[data-occupation-tag="design"]')
    expect(design.attributes('disabled')).toBeDefined()
    expect(design.attributes('aria-pressed')).toBe('false')
    expect(design.text()).toContain('主角色')
    await wrapper.get('[data-occupation-tag="data"]').trigger('click')
    const select = wrapper.findComponent({ name: 'UiSelect' })
    await select.vm.$emit('update:modelValue', 'data')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(putJson).toHaveBeenCalledWith('/api/project-agents/alpha/occupation', { personalSpaceId: 'space-a', role: 'data', tags: ['product'] })
  })
})
