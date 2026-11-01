import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const patchJson = vi.hoisted(() => vi.fn())
vi.mock('@/api/client', () => ({ patchJson }))

import { useConsoleStore } from '@/stores/console'
import { knowledgeItemFromNode } from './model'
import { useKnowledgeConfirm } from './useKnowledgeConfirm'

function harness(spaceId: string) {
  const reload = vi.fn()
  const accessDenied = vi.fn()
  let api!: ReturnType<typeof useKnowledgeConfirm>
  const wrapper = mount(defineComponent({
    setup() {
      api = useKnowledgeConfirm({ personalSpaceId: () => spaceId, personalProjectId: () => 'project-1', accessDenied, reload })
      return () => h('div')
    },
  }))
  return { api, reload, accessDenied, wrapper }
}

const item = (id: string) => knowledgeItemFromNode({
  id, name: 'Synthetic preference', type: 'DesignTaste', origin_quadrant: 'known_known', epistemic_state_explicit: true,
  confirmation_status: 'pending', profile_aspect: 'taste',
  evidence: [{ source_description: 'Synthetic source said so.', source_application: 'codex' }],
})

describe('useKnowledgeConfirm', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    patchJson.mockReset()
  })

  it('confirms in one request with the item\'s source basis, says so, and reads again', async () => {
    patchJson.mockResolvedValue({})
    const { api, reload, wrapper } = harness('space-ok')
    const pending = api.confirm(item('one'))
    void api.confirm(item('one'))
    expect(api.confirming.value).toBe(true)
    await pending
    expect(patchJson).toHaveBeenCalledTimes(1)
    expect(patchJson).toHaveBeenCalledWith('/api/knowledge/entity/one', {
      personalSpaceId: 'space-ok',
      personalProjectId: 'project-1',
      action: 'confirm',
      reason: '已核对内容与发现时象限，确认无误。',
      confirmationStatus: 'confirmed',
      confirmationBasis: {
        existenceReason: 'Synthetic source said so.',
        quadrantReason: expect.stringContaining('已知的已知'),
        proposedBy: { kind: 'agent', label: 'Codex' },
        confirmedBy: { kind: 'user', label: '当前用户' },
        confirmedAt: expect.any(String),
      },
    })
    expect(useConsoleStore().feedback).toEqual({ message: '这条偏好已确认，并记录了确认人和确认时间。', tone: 'success' })
    expect(reload).toHaveBeenCalledTimes(1)
    expect(api.confirming.value).toBe(false)
    wrapper.unmount()
  })

  it('reports an unconfirmed result and reads again instead of retrying', async () => {
    patchJson.mockRejectedValue({ status: 409 })
    const { api, reload, wrapper } = harness('space-conflict')
    await api.confirm(item('two'))
    expect(useConsoleStore().feedback).toEqual({ message: '记录已变化，请重新读取后再决定。', tone: 'error' })
    expect(reload).toHaveBeenCalledTimes(1)
    await api.confirm(item('two'))
    await flushPromises()
    expect(patchJson).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('hands a revoked access to the page without a reload', async () => {
    patchJson.mockRejectedValue({ status: 403 })
    const { api, reload, accessDenied, wrapper } = harness('space-denied')
    await api.confirm(item('three'))
    expect(accessDenied).toHaveBeenCalledTimes(1)
    expect(reload).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})
