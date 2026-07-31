import { beforeEach, describe, expect, it } from 'vitest'

import { knowledgeItemFromNode } from '@/features/knowledge/model'
import { setLocale } from '@/i18n'
import {
  comparePreferenceValues,
  detectPreferenceConflicts,
  mergePreferenceValues,
  preferenceValue,
} from './preference-conflicts'

describe('preference conflicts', () => {
  beforeEach(() => {
    setLocale('zh-CN', { persist: false })
  })

  it('detects one chronological pair and explains the shared scope and key', () => {
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

    const [conflict] = detectPreferenceConflicts([newer, older])

    expect(conflict.left.id).toBe('older')
    expect(conflict.right.id).toBe('newer')
    expect(conflict.preferenceKey).toBe('dashboard.layout')
    expect(conflict.scopeLabel).toBe('个人全局')
    expect(conflict.recommendedAction).toBe('merge')
    expect(conflict.reason).toContain('生效范围相同')
  })

  it('shows shared and one-sided clauses without losing the more specific wording', () => {
    const difference = comparePreferenceValues(
      '宽度工具栏、卡片、水印、筛选排序',
      '卡片、宽度、水印、类型高度、全文提示、筛选排序、不透明确认区',
    )

    expect(difference.shared).toEqual([
      '宽度工具栏',
      '卡片',
      '水印',
      '筛选排序',
    ])
    expect(difference.leftOnly).toEqual([])
    expect(difference.rightOnly).toEqual(['类型高度', '全文提示', '不透明确认区'])
  })

  it('merges around the newer structure while preserving older specific wording', () => {
    expect(mergePreferenceValues(
      '卡片、宽度、水印、类型高度、全文提示、筛选排序、不透明确认区',
      '宽度工具栏、卡片、水印、筛选排序',
    )).toBe(
      '卡片、宽度工具栏、水印、类型高度、全文提示、筛选排序、不透明确认区',
    )
  })

  it('does not recommend merging when both sides contain unmatched clauses', () => {
    const older = preference(
      'older',
      '通知使用邮件、保留审核记录',
      '2026-07-24T00:04:00Z',
    )
    const newer = preference(
      'newer',
      '通知不要使用邮件、保留审核记录',
      '2026-07-24T00:18:00Z',
    )

    const [conflict] = detectPreferenceConflicts([older, newer])

    expect(conflict.difference.shared).toEqual(['保留审核记录'])
    expect(conflict.difference.leftOnly).toEqual(['通知使用邮件'])
    expect(conflict.difference.rightOnly).toEqual(['通知不要使用邮件'])
    expect(conflict.relation).toBe('review')
    expect(conflict.recommendedAction).toBeNull()
  })

  it('attaches a persisted AI-deferred marker to the exact conflict pair', () => {
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

    const [conflict] = detectPreferenceConflicts([older, newer], [{
      id: 'deferred-1',
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
    }])

    expect(conflict.aiRecord?.id).toBe('deferred-1')
  })

  it('localizes generated explanations without translating stored preference data', () => {
    setLocale('en-US', { persist: false })
    const older = preference('older', 'Keep technical terms in English', '2026-07-24T00:04:00Z')
    const newer = preference('newer', 'Keep product terms in English', '2026-07-24T00:18:00Z')

    const [conflict] = detectPreferenceConflicts([older, newer])

    expect(conflict.scopeLabel).toBe('Personal global')
    expect(conflict.reason).toContain('Preference key “dashboard.layout”')
    expect(preferenceValue(conflict.left)).toBe('Keep technical terms in English')
  })
})

function preference(id: string, summary: string, createdAt: string) {
  return knowledgeItemFromNode({
    id,
    name: 'Dashboard 视觉规则',
    type: 'Preference',
    summary,
    attributes: {
      preferenceKey: 'dashboard.layout',
      preferenceValue: summary,
    },
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
