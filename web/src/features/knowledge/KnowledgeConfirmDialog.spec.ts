import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const patchJson = vi.hoisted(() => vi.fn())

vi.mock('@/api/client', () => ({ patchJson }))

import KnowledgeConfirmDialog from './KnowledgeConfirmDialog.vue'
import { knowledgeItemFromNode } from './model'

describe('KnowledgeConfirmDialog', () => {
  beforeEach(() => {
    patchJson.mockReset()
    patchJson.mockResolvedValue({})
  })

  it('confirms one pending preference with auditable basis', async () => {
    const item = knowledgeItemFromNode({
      id: 'preference-1',
      name: '使用干净的实心选中态',
      type: 'DesignTaste',
      summary: '避免齿轮状、虚线或点状选中环。',
      origin_quadrant: 'known_known',
      current_quadrant: 'known_known',
      epistemic_state_explicit: true,
      confirmation_status: 'pending',
      confirmation_state_explicit: false,
      profile_aspect: 'taste',
      evidence: [{
        source_description: '用户在会话中明确提出了这个视觉偏好。',
        source_application: 'codex',
      }],
    })
    const wrapper = mount(KnowledgeConfirmDialog, {
      props: {
        item,
        personalSpaceId: 'space-1',
        personalProjectId: null,
      },
      global: {
        plugins: [createPinia()],
      },
    })

    expect(wrapper.get('h3').text()).toBe('确认这条偏好')
    expect(
      (wrapper.get('[name="confirmation-existence-reason"]').element as HTMLTextAreaElement).value,
    )
      .toBe('用户在会话中明确提出了这个视觉偏好。')
    expect(
      (wrapper.get('[name="confirmation-quadrant-reason"]').element as HTMLTextAreaElement).value,
    )
      .toContain('已知的已知')
    expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeDefined()

    await wrapper.get('[name="confirmation-acknowledged"]').setValue(true)
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(patchJson).toHaveBeenCalledWith(
      '/api/knowledge/entity/preference-1',
      expect.objectContaining({
        personalSpaceId: 'space-1',
        personalProjectId: null,
        action: 'confirm',
        confirmationStatus: 'confirmed',
        confirmationBasis: expect.objectContaining({
          proposedBy: { kind: 'agent', label: 'Codex' },
          confirmedBy: { kind: 'user', label: '当前用户' },
          confirmedAt: expect.any(String),
        }),
      }),
    )
    expect(wrapper.emitted('saved')).toHaveLength(1)
    expect(wrapper.emitted('close')).toHaveLength(1)
  })
})
