import { latestItemValue } from '@/features/knowledge/model'
import { currentLocale, t } from '@/i18n'
import type { KnowledgeItem } from '@/types'

export type PreferenceConflictRelation = 'complementary' | 'review'
export type PreferenceConflictAction =
  | 'merge'
  | 'keep_left'
  | 'keep_right'
  | 'split_scope'

export interface PreferenceConflictDifference {
  shared: string[]
  leftOnly: string[]
  rightOnly: string[]
  similarity: number
}

export interface PreferenceConflictRecord {
  id: string
  personal_space_id: string
  preference_key: string
  preference_scope: 'global' | 'project'
  preference_project_id?: string | null
  left_item_id: string
  left_item_kind: 'entity' | 'relationship'
  right_item_id: string
  right_item_kind: 'entity' | 'relationship'
  status: 'ai_pending' | 'resolved'
  requested_by: 'human' | 'agent'
  resolution?: PreferenceConflictAction | null
  resolved_by?: 'human' | 'agent' | null
  reason: string
  resolution_reason?: string | null
  deferred_at: string
  resolved_at?: string | null
  updated_at: string
}

export interface PreferenceConflict {
  id: string
  preferenceKey: string
  scopeKey: string
  scopeLabel: string
  left: KnowledgeItem
  right: KnowledgeItem
  difference: PreferenceConflictDifference
  relation: PreferenceConflictRelation
  recommendedAction: PreferenceConflictAction | null
  reason: string
  aiRecord: PreferenceConflictRecord | null
}

export function detectPreferenceConflicts(
  candidates: KnowledgeItem[],
  records: PreferenceConflictRecord[] = [],
): PreferenceConflict[] {
  const conflicts: PreferenceConflict[] = []
  const current = candidates.filter((item) => !item.invalidAt)
  for (let leftIndex = 0; leftIndex < current.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < current.length; rightIndex += 1) {
      const candidateLeft = current[leftIndex]
      const candidateRight = current[rightIndex]
      if (
        !samePreferenceScope(candidateLeft, candidateRight)
        || !samePreferenceKey(candidateLeft, candidateRight)
        || samePreferenceValue(candidateLeft, candidateRight)
      ) continue

      const [left, right] = chronologicalPair(candidateLeft, candidateRight)
      const difference = comparePreferenceValues(
        preferenceValue(left),
        preferenceValue(right),
      )
      const relation = isSafeMergeSuggestion(difference) ? 'complementary' : 'review'
      const aiRecord = records.find(
        (record) =>
          record.status === 'ai_pending'
          && preferenceConflictRecordMatches(record, left, right),
      ) ?? null
      conflicts.push({
        id: conflictId(left, right),
        preferenceKey: preferenceKey(left),
        scopeKey: preferenceScopeKey(left),
        scopeLabel: preferenceScopeLabel(left),
        left,
        right,
        difference,
        relation,
        recommendedAction: relation === 'complementary' ? 'merge' : null,
        reason: t('preferences.shared.conflictReason', {
          key: preferenceKey(left),
        }),
        aiRecord,
      })
    }
  }
  return conflicts.sort((left, right) => {
    const locale = currentLocale()
    const scopeOrder = left.scopeKey.localeCompare(right.scopeKey, locale)
    if (scopeOrder) return scopeOrder
    return left.preferenceKey.localeCompare(right.preferenceKey, locale)
  })
}

export function preferenceConflictRecordItemIds(
  record: PreferenceConflictRecord,
) {
  return [record.left_item_id, record.right_item_id]
}

function preferenceConflictRecordMatches(
  record: PreferenceConflictRecord,
  left: KnowledgeItem,
  right: KnowledgeItem,
) {
  const recordItems = new Set([
    `${record.left_item_kind}:${record.left_item_id}`,
    `${record.right_item_kind}:${record.right_item_id}`,
  ])
  return recordItems.has(`${left.itemKind}:${left.id}`)
    && recordItems.has(`${right.itemKind}:${right.id}`)
}

export function preferenceKey(item: KnowledgeItem) {
  const attributes = item.raw.attributes ?? {}
  return String(
    attributes.preferenceKey
    ?? attributes.preference_key
    ?? item.title,
  ).trim()
}

export function preferenceValue(item: KnowledgeItem) {
  return item.body.trim()
}

export function preferenceScopeKey(item: KnowledgeItem) {
  return item.preferenceScope === 'project' && item.preferenceProjectId
    ? `project:${item.preferenceProjectId}`
    : 'global'
}

export function preferenceScopeLabel(item: KnowledgeItem) {
  return item.preferenceScope === 'project' && item.preferenceProjectId
    ? t('preferences.shared.projectScope', { project: item.preferenceProjectId })
    : t('preferences.shared.personalGlobal')
}

export function comparePreferenceValues(
  leftValue: string,
  rightValue: string,
): PreferenceConflictDifference {
  const leftSegments = preferenceSegments(leftValue)
  const rightSegments = preferenceSegments(rightValue)
  const matchedRight = new Set<number>()
  const shared: string[] = []
  const leftOnly: string[] = []

  for (const leftSegment of leftSegments) {
    const rightIndex = rightSegments.findIndex(
      (rightSegment, index) =>
        !matchedRight.has(index) && equivalentSegment(leftSegment, rightSegment),
    )
    if (rightIndex < 0) {
      leftOnly.push(leftSegment)
      continue
    }
    matchedRight.add(rightIndex)
    shared.push(moreSpecificSegment(leftSegment, rightSegments[rightIndex]))
  }

  const rightOnly = rightSegments.filter((_, index) => !matchedRight.has(index))
  return {
    shared,
    leftOnly,
    rightOnly,
    similarity: shared.length / Math.max(leftSegments.length, rightSegments.length, 1),
  }
}

export function mergePreferenceValues(primaryValue: string, secondaryValue: string) {
  const merged = [...preferenceSegments(primaryValue)]
  for (const segment of preferenceSegments(secondaryValue)) {
    const existingIndex = merged.findIndex((existing) =>
      equivalentSegment(existing, segment),
    )
    if (existingIndex < 0) {
      merged.push(segment)
      continue
    }
    merged[existingIndex] = moreSpecificSegment(merged[existingIndex], segment)
  }
  if (!merged.length) return ''
  const separator = merged.some((segment) => segment.length > 24) ? '；' : '、'
  return merged.join(separator)
}

function isSafeMergeSuggestion(difference: PreferenceConflictDifference) {
  return difference.shared.length > 0
    && (difference.leftOnly.length === 0 || difference.rightOnly.length === 0)
}

function samePreferenceScope(left: KnowledgeItem, right: KnowledgeItem) {
  return preferenceScopeKey(left) === preferenceScopeKey(right)
}

function samePreferenceKey(left: KnowledgeItem, right: KnowledgeItem) {
  return normalize(preferenceKey(left)) === normalize(preferenceKey(right))
}

function samePreferenceValue(left: KnowledgeItem, right: KnowledgeItem) {
  return normalize(preferenceValue(left)) === normalize(preferenceValue(right))
}

function chronologicalPair(
  left: KnowledgeItem,
  right: KnowledgeItem,
): [KnowledgeItem, KnowledgeItem] {
  const leftTime = timestamp(left)
  const rightTime = timestamp(right)
  if (leftTime === rightTime) {
    return left.id.localeCompare(right.id) <= 0 ? [left, right] : [right, left]
  }
  return leftTime <= rightTime ? [left, right] : [right, left]
}

function timestamp(item: KnowledgeItem) {
  const value = latestItemValue(item)
  if (!value) return 0
  const result = new Date(value).getTime()
  return Number.isNaN(result) ? 0 : result
}

function conflictId(left: KnowledgeItem, right: KnowledgeItem) {
  return [left.itemKind, left.id, right.itemKind, right.id].join(':')
}

function preferenceSegments(value: string) {
  return value
    .split(/[\n\r,，、;；。.!！?？]+/u)
    .map((segment) => segment.trim())
    .filter(Boolean)
}

function equivalentSegment(left: string, right: string) {
  const normalizedLeft = normalize(left)
  const normalizedRight = normalize(right)
  if (normalizedLeft === normalizedRight) return true
  const shorter = normalizedLeft.length <= normalizedRight.length
    ? normalizedLeft
    : normalizedRight
  const longer = shorter === normalizedLeft ? normalizedRight : normalizedLeft
  return shorter.length >= 2 && longer.includes(shorter)
}

function moreSpecificSegment(left: string, right: string) {
  return normalize(left).length >= normalize(right).length ? left : right
}

function normalize(value: unknown) {
  return String(value ?? '')
    .trim()
    .toLocaleLowerCase()
    .replace(/[“”‘’"'`]/gu, '')
    .replace(/\s+/gu, ' ')
}
