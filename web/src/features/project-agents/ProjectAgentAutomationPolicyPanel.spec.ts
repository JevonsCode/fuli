import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getJson = vi.hoisted(() => vi.fn())
const patchJson = vi.hoisted(() => vi.fn())

vi.mock('@/api/client', () => ({ getJson, patchJson }))

import ProjectAgentAutomationPolicyPanel from './ProjectAgentAutomationPolicyPanel.vue'

describe('ProjectAgentAutomationPolicyPanel', () => {
  beforeEach(() => {
    getJson.mockReset()
    patchJson.mockReset()
    getJson.mockResolvedValue({
      personal_space_id: 'personal-1',
      personal_project_id: 'activity-intake',
      ask_before_recruitment: true,
      auto_reuse_previous_agent: true,
    })
    patchJson.mockImplementation(async (_url: string, input: Record<string, unknown>) => input)
  })

  it('loads both project switches on by default', async () => {
    const wrapper = mountPanel()
    await flushPromises()

    expect(getJson).toHaveBeenCalledWith(
      '/api/project-agent-coordination-policy?personalSpaceId=personal-1&personalProjectId=activity-intake',
    )
    expect(wrapper.findAll<HTMLInputElement>('input[role="switch"]')).toHaveLength(2)
    expect(wrapper.findAll<HTMLInputElement>('input[role="switch"]').every(
      ({ element }) => element.checked,
    )).toBe(true)
  })

  it('persists manual @Agent mode without changing the recruitment switch', async () => {
    const wrapper = mountPanel()
    await flushPromises()

    await wrapper.findAll<HTMLInputElement>('input[role="switch"]')[0].setValue(false)
    await flushPromises()

    expect(patchJson).toHaveBeenCalledWith('/api/project-agent-coordination-policy', {
      personalSpaceId: 'personal-1',
      personalProjectId: 'activity-intake',
      askBeforeRecruitment: true,
      autoReusePreviousAgent: false,
    })
  })

  it('rolls back a failed update and offers a clear error', async () => {
    patchJson.mockRejectedValueOnce(new Error('策略暂时无法保存'))
    const wrapper = mountPanel()
    await flushPromises()

    const reuseSwitch = wrapper.findAll<HTMLInputElement>('input[role="switch"]')[0]
    await reuseSwitch.setValue(false)
    await flushPromises()

    expect(reuseSwitch.element.checked).toBe(true)
    expect(wrapper.get('[role="alert"]').text()).toContain('策略暂时无法保存')
  })
})

function mountPanel() {
  return mount(ProjectAgentAutomationPolicyPanel, {
    props: {
      personalSpaceId: 'personal-1',
      personalProjectId: 'activity-intake',
      projectName: '活动承接',
    },
  })
}
