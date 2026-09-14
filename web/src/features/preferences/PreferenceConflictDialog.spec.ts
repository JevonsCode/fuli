import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const patchJson = vi.hoisted(() => vi.fn())
const postJson = vi.hoisted(() => vi.fn())

vi.mock('@/api/client', () => ({
  patchJson,
  postJson,
}))

import { knowledgeItemFromNode } from '@/features/knowledge/model'
import PreferenceConflictDialog from './PreferenceConflictDialog.vue'
import { detectPreferenceConflicts } from './preference-conflicts'

describe('PreferenceConflictDialog', () => {
  beforeEach(() => {
    patchJson.mockReset()
    patchJson.mockResolvedValue({})
    postJson.mockReset()
    postJson.mockResolvedValue({})
    setActivePinia(createPinia())
  })

  it('merges complementary content into the newer item and links the older history', async () => {
    const conflict = currentConflict()
    const wrapper = mount(PreferenceConflictDialog, {
      props: {
        conflict,
        personalSpaceId: 'personal-space',
        projects: [],
      },
    })

    expect(wrapper.text()).toContain('内容互补，优先合并')
    expect(wrapper.get('textarea').element.value).toContain('宽度工具栏')
    await wrapper.get('.conflict-resolution-actions .primary-action').trigger('click')
    await flushPromises()

    expect(patchJson).toHaveBeenCalledTimes(2)
    expect(patchJson).toHaveBeenNthCalledWith(
      1,
      '/api/knowledge/entity/newer',
      expect.objectContaining({
        personalSpaceId: 'personal-space',
        action: 'update',
        name: 'Dashboard 视觉规则',
        summary: '卡片、宽度工具栏、水印、类型高度、全文提示、筛选排序、不透明确认区',
        confirmationStatus: 'confirmed',
      }),
    )
    expect(patchJson).toHaveBeenNthCalledWith(
      2,
      '/api/knowledge/entity/older',
      expect.objectContaining({
        action: 'invalidate',
        replacementItemId: 'newer',
        replacementItemKind: 'entity',
      }),
    )
    expect(wrapper.emitted('resolved')).toHaveLength(1)
  })

  it('locks conflict choices and keeps the original reason across a delayed multi-step merge', async () => {
    let finish!: (value: object) => void
    patchJson.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const wrapper = mount(PreferenceConflictDialog, { props: {
      conflict: currentConflict(), personalSpaceId: 'personal-space', projects: [],
    } })
    await wrapper.get('.conflict-resolution-actions .primary-action').trigger('click')
    await wrapper.get('.conflict-resolution-actions .primary-action').trigger('click')
    expect(patchJson).toHaveBeenCalledTimes(1)
    expect(wrapper.get('.conflict-inputs').attributes('disabled')).toBeDefined()
    expect(wrapper.get('.growth-loading--inline').text()).toContain('偏好冲突处理')
    const submittedReason = patchJson.mock.calls[0][1].reason
    // Simulate even a programmatic model update; later writes keep the submitted reason.
    await wrapper.get('.conflict-resolution-reason textarea').setValue('Different later input')
    finish({})
    await flushPromises()
    expect(patchJson.mock.calls[1][1].reason).toBe(submittedReason)
    expect(wrapper.get('.conflict-inputs').attributes('disabled')).toBeUndefined()
    expect(wrapper.find('.growth-loading--inline').exists()).toBe(false)
    wrapper.unmount()
  })

  it('can split one item into an exact personal project scope', async () => {
    const wrapper = mount(PreferenceConflictDialog, {
      props: {
        conflict: currentConflict(),
        personalSpaceId: 'personal-space',
        projects: [
          {
            project_id: 'project-dashboard',
            personal_space_id: 'personal-space',
            profile: { name: 'Dashboard 项目' },
          },
        ],
      },
    })
    const splitAction = wrapper
      .findAll('.conflict-resolution-options > button')
      .find((button) => button.text().includes('拆分生效范围'))
    expect(splitAction).toBeDefined()
    await splitAction!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('Dashboard 项目')
    await wrapper.get('.conflict-resolution-actions .primary-action').trigger('click')
    await flushPromises()

    expect(postJson).toHaveBeenCalledWith(
      '/api/knowledge/entity/newer/preference-scope',
      {
        personalSpaceId: 'personal-space',
        scope: 'project',
        projectId: 'project-dashboard',
        reason: '两条偏好适用于不同项目，拆分生效范围并同时保留。',
      },
    )
  })

  it('closes an AI-deferred marker when the user resolves it manually', async () => {
    const conflict = currentConflict()
    conflict.aiRecord = {
      id: 'deferred-conflict',
      personal_space_id: 'personal-space',
      preference_key: 'dashboard.layout',
      preference_scope: 'global',
      left_item_id: 'older',
      left_item_kind: 'entity',
      right_item_id: 'newer',
      right_item_kind: 'entity',
      status: 'ai_pending',
      requested_by: 'human',
      reason: '使用时再判断。',
      deferred_at: '2026-07-29T01:00:00Z',
      updated_at: '2026-07-29T01:00:00Z',
    }
    const wrapper = mount(PreferenceConflictDialog, {
      props: {
        conflict,
        personalSpaceId: 'personal-space',
        projects: [],
      },
    })

    await wrapper.get('.conflict-resolution-actions .primary-action').trigger('click')
    await flushPromises()

    expect(postJson).toHaveBeenCalledWith(
      '/api/preference-conflicts/deferred-conflict/complete',
      expect.objectContaining({
        personalSpaceId: 'personal-space',
        resolution: 'merge',
      }),
    )
  })
})

function currentConflict() {
  const older = preference(
    'older',
    '宽度工具栏、卡片、水印、筛选排序',
    '2026-07-24T00:04:00Z',
  )
  const newer = preference(
    'newer',
    '卡片、宽度、水印、类型高度、全文提示、筛选排序、不透明确认区',
    '2026-07-24T00:18:00Z',
  )
  return detectPreferenceConflicts([older, newer])[0]
}

function preference(id: string, summary: string, createdAt: string) {
  return knowledgeItemFromNode({
    id,
    name: 'Dashboard 视觉规则',
    type: 'Preference',
    summary,
    attributes: { preferenceKey: 'dashboard.layout' },
    profile_aspect: 'taste',
    preference_scope: 'global',
    origin_quadrant: 'known_known',
    epistemic_state_explicit: true,
    confirmation_status: 'confirmed',
    confirmation_state_explicit: true,
    confirmation_basis: {
      existence_reason: '用户明确表达。',
      quadrant_reason: '用户直接说明了界面偏好。',
      proposed_by: { kind: 'user', label: '用户' },
      confirmed_by: { kind: 'user', label: '用户' },
      confirmed_at: createdAt,
    },
    created_at: createdAt,
  })
}
