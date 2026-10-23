import type { RouteLocationRaw } from 'vue-router'

import { getJson } from '@/api/client'
import { peekItemValue } from '@/composables/useRoutePeek'
import { boardTaskPeekId } from '@/features/employees/board-task-peek'
import { i18n, t } from '@/i18n'

// The 建议 section of the model settings page (rec#8): what Astro, Bole and
// Jefa showed after asking their own model, read from the suggestion log
// (src/model-backends/suggestion-log.js). Every entry is a suggestion only;
// a person acts on it through the page that already owns that decision.

export type SuggestionRole = 'assistant' | 'bole' | 'jefa'
export type SuggestionState = 'suggested' | 'superseded' | 'stopped' | 'fallback'

export interface RoleSuggestion {
  id: number
  at: string
  role: SuggestionRole
  operation: string
  personalSpaceId: string
  personalProjectId: string | null
  subject: { agentId?: string; conversationId?: string | null }
  status: string
  reason?: string | null
  hint?: string
  suggestion?: {
    action?: string
    evidenceIds?: string[]
    reason?: string
    personalProjectId?: string
    name?: string
    taskId?: string
    title?: string
  }
  suggestedBy?: { model: string | null }
  requestId: string
  evidenceVersion: string
  gate: { status: 'suggestion_only'; role: string; operation: string }
  modelReceipt: { requestedModel: string | null; actualModel: string | null }
}

export const readRoleSuggestions = (signal?: AbortSignal) =>
  getJson<{ suggestions?: RoleSuggestion[] }>('/api/model-backends/suggestions', { signal }).then(body => body.suggestions ?? [])

// Bole's score card of the reviewed Agent in the reviewed project, through its existing read route.
export interface ScoreDimension { status: string; sample: number; rate?: number; passed?: number; label?: string }
export interface ScoreCard { dimensions: Record<string, ScoreDimension> }
export const readScoreCard = (entry: RoleSuggestion, signal?: AbortSignal) => getJson<ScoreCard>(
  `/api/project-agents/${encodeURIComponent(entry.subject.agentId ?? '')}/score-card?${new URLSearchParams({
    personalSpaceId: entry.personalSpaceId, ...(entry.personalProjectId ? { personalProjectId: entry.personalProjectId } : {}) })}`,
  { signal })

const STATE_BY_STATUS: Record<string, SuggestionState> = { suggested: 'suggested', superseded: 'superseded', inline: 'fallback' }

// stopped, paused and failed all mean the model's answer is not shown.
export const suggestionState = (entry: RoleSuggestion): SuggestionState => STATE_BY_STATUS[entry.status] ?? 'stopped'

export const suggestionModel = (entry: RoleSuggestion) =>
  entry.suggestedBy?.model ?? entry.modelReceipt.actualModel ?? entry.modelReceipt.requestedModel ?? null

// What was suggested, in one line; empty when nothing was.
export function suggestionText(entry: RoleSuggestion) {
  if (suggestionState(entry) !== 'suggested') return ''
  if (entry.role === 'bole') return t(`modelSettings.suggestions.boleActions.${entry.suggestion?.action}`)
  return entry.hint ?? ''
}

// Why nothing is shown, in plain words; empty for a suggestion.
export function suggestionWhy(entry: RoleSuggestion) {
  const state = suggestionState(entry)
  if (state === 'suggested') return ''
  const key = `modelSettings.suggestions.reasons.${entry.reason}`
  return entry.reason && i18n.global.te(key) ? t(key) : t('modelSettings.suggestions.reasons.other', { reason: entry.reason ?? '—' })
}

// The references the suggestion rests on: Bole's cited dimensions, then the evidence version.
export function suggestionEvidence(entry: RoleSuggestion) {
  const dimensions = (entry.suggestion?.evidenceIds ?? []).map(id => t(`modelSettings.suggestions.dimensions.${id}`))
  return { dimensions, version: entry.evidenceVersion.slice(0, 8), title: `${entry.evidenceVersion}\n${entry.requestId}` }
}

export type SuggestionAction = { kind: 'link'; label: string; to: RouteLocationRaw } | { kind: 'score_card'; label: string }

// The person's own path for a shown suggestion: Astro's project is confirmed
// in the unclaimed-conversation triage, Jefa's task opens on the board, and
// Bole's score card opens here. Nothing is applied by opening it.
export function suggestionAction(entry: RoleSuggestion): SuggestionAction | null {
  if (suggestionState(entry) !== 'suggested') return null
  if (entry.role === 'bole' && entry.subject.agentId) return { kind: 'score_card', label: t('modelSettings.suggestions.openScoreCard') }
  if (entry.role === 'assistant') {
    return { kind: 'link', label: t('modelSettings.suggestions.confirm'), to: { path: '/employees/assistant',
      query: entry.subject.conversationId ? { conversation: entry.subject.conversationId } : {} } }
  }
  const task = entry.suggestion
  if (entry.role === 'jefa' && task?.taskId && entry.personalProjectId) {
    return { kind: 'link', label: t('modelSettings.suggestions.openTask'), to: { path: '/employees/jefa', query: {
      item: peekItemValue({ spaceId: entry.personalSpaceId, id: boardTaskPeekId({ projectId: entry.personalProjectId, id: task.taskId }) }) } } }
  }
  return null
}

export function scoreValue(dimension: ScoreDimension) {
  return dimension.status === 'scored' && typeof dimension.rate === 'number'
    ? t('modelSettings.suggestions.scoreValue', { rate: Math.round(dimension.rate * 100), passed: dimension.passed ?? 0, sample: dimension.sample })
    : t('modelSettings.suggestions.insufficient')
}
