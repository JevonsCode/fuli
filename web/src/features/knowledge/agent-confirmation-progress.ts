import { t } from '@/i18n'
import type { KnowledgeItem } from '@/types'

import { knowledgeReviewState } from './model'

const PREFIX = 'knowledge.workspace.inspector.autoConfirmation'

export function showsAgentConfirmationProgress(item: KnowledgeItem) {
  const state = knowledgeReviewState(item)
  return state !== 'confirmed' && state !== 'agent_confirmed' && !item.invalidAt
}

export function agentConfirmationProgressText(item: KnowledgeItem) {
  const progress = item.agentConfirmationProgress
  if (!progress) return t(`${PREFIX}.unavailable`)
  return t(`${PREFIX}.progress`, {
    uses: countText(progress.qualified_use_count),
    requiredUses: progress.required_qualified_uses,
    tasks: countText(progress.distinct_task_count),
    requiredTasks: progress.required_distinct_tasks,
  })
}

export function agentConfirmationBlockingText(item: KnowledgeItem) {
  const progress = item.agentConfirmationProgress
  if (!progress) return t(`${PREFIX}.unknownReason`)
  if (!progress.blocking_reasons.length) return t(`${PREFIX}.ready`)
  return progress.blocking_reasons
    .map((reason) => t(`${PREFIX}.reasons.${reason}`))
    .join(t(`${PREFIX}.separator`))
}

export function materialUseText(item: KnowledgeItem) {
  const progress = item.agentConfirmationProgress
  return t('knowledge.workspace.inspector.useCount', {
    uses: countText(progress?.qualified_use_count ?? null),
    tasks: countText(progress?.distinct_task_count ?? null),
  })
}

function countText(value: number | null) {
  return value === null ? t(`${PREFIX}.unknownCount`) : String(value)
}
