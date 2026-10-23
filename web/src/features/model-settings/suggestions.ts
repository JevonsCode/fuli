import type { RouteLocationRaw } from 'vue-router'

import { getJson } from '@/api/client'
import { peekItemValue } from '@/composables/useRoutePeek'
import { boardTaskPeekId } from '@/features/employees/board-task-peek'
import { i18n, t } from '@/i18n'

// The 建议记录 section of the model settings page (rec#8, rec#10 D-30): what
// Astro, Bole and Jefa showed after asking their own model, as recorded at
// that moment (src/model-backends/suggestion-log.js). A record, never a
// to-do: a person decides on the page that owns that decision.

export type SuggestionRole = 'assistant' | 'bole' | 'jefa'
export type SuggestionState = 'suggested' | 'newer' | 'superseded' | 'fallback' | 'stopped'

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
  modelReceipt: { requestedModel: string | null; actualModel: string | null; fallbackReason?: string | null }
  // A newer suggestion for the same subject was recorded since.
  stale?: 'newer'
  // A permanent delete of knowledge cleared its words (rec#10 D-30.9).
  hard_deleted?: true
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

// The state recorded at the time. A fallback the role allowed is the current
// session answering instead: Astro and Jefa record it as inline, Bole as its
// model's failure with the fallback in the receipt. Any other stop, pause or
// failure showed nothing.
export function suggestionState(entry: RoleSuggestion): SuggestionState {
  if (entry.status === 'suggested') return entry.stale === 'newer' ? 'newer' : 'suggested'
  if (entry.status === 'superseded') return 'superseded'
  return entry.status === 'inline' || entry.modelReceipt.fallbackReason ? 'fallback' : 'stopped'
}

// A suggestion as recorded, whether or not a newer one followed.
export const isSuggestion = (state: SuggestionState) => state === 'suggested' || state === 'newer'

export const suggestionModel = (entry: RoleSuggestion) =>
  entry.suggestedBy?.model ?? entry.modelReceipt.actualModel ?? entry.modelReceipt.requestedModel ?? null

// What was suggested, in one line; empty when nothing was. A permanent
// delete of knowledge cleared the words of a record (D-30.9): it says so.
export function suggestionText(entry: RoleSuggestion) {
  if (!isSuggestion(suggestionState(entry))) return ''
  if (entry.hard_deleted) return t('modelSettings.suggestions.cleared')
  if (entry.role === 'bole') return t(`modelSettings.suggestions.boleActions.${entry.suggestion?.action}`)
  return entry.hint ?? ''
}

// Why nothing was shown, in plain words; empty for a suggestion.
export function suggestionWhy(entry: RoleSuggestion) {
  if (isSuggestion(suggestionState(entry))) return ''
  const key = `modelSettings.suggestions.reasons.${entry.reason}`
  return entry.reason && i18n.global.te(key) ? t(key) : t('modelSettings.suggestions.reasons.other', { reason: entry.reason ?? '—' })
}

// What a person can read of the evidence (Bole's cited dimensions); the
// evidence version and request id are only for a title.
export function suggestionEvidence(entry: RoleSuggestion) {
  const dimensions = (entry.suggestion?.evidenceIds ?? []).map(id => t(`modelSettings.suggestions.dimensions.${id}`))
  return { dimensions, title: `${entry.evidenceVersion}\n${entry.requestId}` }
}

// How many the section shows before 显示全部.
export const VISIBLE_SUGGESTIONS = 8

// Suggestions first (those with nothing newer before those with), then the
// rest; each newest first.
const RANK: Record<SuggestionState, number> = { suggested: 2, newer: 1, superseded: 0, fallback: 0, stopped: 0 }
export function orderSuggestions(entries: RoleSuggestion[]) {
  const rank = (entry: RoleSuggestion) => RANK[suggestionState(entry)]
  return [...entries].sort((a, b) => rank(b) - rank(a) || b.at.localeCompare(a.at) || b.id - a.id)
}


export type SuggestionAction = { kind: 'link'; label: string; to: RouteLocationRaw } | { kind: 'score_card'; label: string }

// The page that answers whether anything is still to do: Astro's
// conversation in the unclaimed triage, Jefa's task (or, without one, the
// project's board) and Bole's score card here. Opening it applies nothing. A
// stop or a fallback has none.
export function suggestionAction(entry: RoleSuggestion): SuggestionAction | null {
  const state = suggestionState(entry)
  if (!isSuggestion(state) && state !== 'superseded') return null
  if (entry.role === 'assistant' && entry.subject.conversationId) {
    return { kind: 'link', label: t('modelSettings.suggestions.openConversation'),
      to: { path: '/employees/assistant', query: { conversation: entry.subject.conversationId } } }
  }
  if (entry.role === 'jefa' && entry.personalProjectId) {
    const taskId = entry.suggestion?.taskId
    return taskId
      ? { kind: 'link', label: t('modelSettings.suggestions.openTask'), to: { path: '/employees/jefa', query: {
        item: peekItemValue({ spaceId: entry.personalSpaceId, id: boardTaskPeekId({ projectId: entry.personalProjectId, id: taskId }) }) } } }
      : { kind: 'link', label: t('modelSettings.suggestions.openBoard'), to: { path: '/employees/jefa', query: { project: entry.personalProjectId } } }
  }
  if (entry.role === 'bole' && isSuggestion(state) && entry.subject.agentId) {
    return { kind: 'score_card', label: t('modelSettings.suggestions.openScoreCard') }
  }
  return null
}

export function scoreValue(dimension: ScoreDimension) {
  return dimension.status === 'scored' && typeof dimension.rate === 'number'
    ? t('modelSettings.suggestions.scoreValue', { rate: Math.round(dimension.rate * 100), passed: dimension.passed ?? 0, sample: dimension.sample })
    : t('modelSettings.suggestions.insufficient')
}
