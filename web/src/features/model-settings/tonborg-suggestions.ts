import { getJson } from '@/api/client'
import { peekItemValue } from '@/composables/useRoutePeek'
import type { JudgmentAiReview } from '@/features/judgment/judgment-types'
import { i18n, t } from '@/i18n'
import type { SuggestionAction, SuggestionView } from './suggestions'

// Tonborg's part of 建议记录 (rec#8): the knowledge review verdicts the host
// left to the person (src/judgment/review-suggestions.js), as Tonborg gave
// them then. The person decides on the knowledge item itself, in 知识整理.

export interface TonborgSuggestion {
  id: string
  createdAt: string
  personalSpaceId: string
  personalProjectId: string | null
  // The review candidate key, `<kind>:<id>` of the knowledge item.
  target: string
  title: string | null
  summary: string | null
  confidence: number | null
  aiReview: JudgmentAiReview
  model: string | null
  client: string | null
  judgedBy: { mode: 'model_api' | 'current_session' | 'legacy_cli'; independent: boolean } | null
  // A newer suggestion for the same item was given since.
  stale?: 'newer'
  // A permanent delete of the item cleared its words (rec#5 C9).
  hard_deleted?: true
}

export const readTonborgSuggestions = (personalSpaceId: string, signal?: AbortSignal) =>
  getJson<{ suggestions?: TonborgSuggestion[] }>(`/api/judgment/suggestions?${new URLSearchParams({ personalSpaceId })}`, { signal })
    .then(body => body.suggestions ?? [])

// One row of the section. The judgment id is kept only for a title, to find it on Tonborg's page.
export const tonborgSuggestionView = (entry: TonborgSuggestion): SuggestionView => ({
  key: `tonborg:${entry.id}`, role: 'tonborg', state: entry.stale === 'newer' ? 'newer' : 'suggested', at: entry.createdAt, seq: 0,
  text: tonborgText(entry), reason: entry.hard_deleted ? '' : entry.summary ?? '', heldBy: tonborgHeldBy(entry), why: '',
  model: tonborgSource(entry), evidence: { dimensions: [], title: entry.id }, action: tonborgAction(entry),
})

// The item and what Tonborg's model concluded about it, in one line.
function tonborgText(entry: TonborgSuggestion) {
  if (entry.hard_deleted) return t('modelSettings.suggestions.cleared')
  const verdict = t(`modelSettings.suggestions.tonborg.verdicts.${entry.aiReview.modelOutcome}`)
  return entry.title ? `${entry.title} · ${verdict}` : verdict
}

// Who answered: Tonborg's own model, or the current session it handed the review to.
function tonborgSource(entry: TonborgSuggestion) {
  if (entry.judgedBy?.mode === 'current_session') return t('modelSettings.answer.current_session')
  return entry.model ?? entry.client ?? null
}

// Why the host left it to the person rather than applying it; empty when the
// model itself asked the person to look (an escalation with nothing held back).
function tonborgHeldBy(entry: TonborgSuggestion) {
  return entry.aiReview.interceptions.map((reason) => {
    if (reason === 'gate_not_passed') return gateReason(entry.aiReview.gate?.reason ?? null)
    const key = `modelSettings.suggestions.tonborg.held.${reason}`
    return i18n.global.te(key) ? t(key) : t('modelSettings.suggestions.reasons.other', { reason })
  }).join(' · ')
}

function gateReason(reason: string | null) {
  const key = `modelSettings.suggestions.tonborg.gate.${reason}`
  return reason && i18n.global.te(key) ? t(key) : t('modelSettings.suggestions.tonborg.gate.other')
}

// The item in 知识整理, where the person confirms, edits or corrects it. A
// permanently deleted item has nothing to open.
function tonborgAction(entry: TonborgSuggestion): SuggestionAction | null {
  if (entry.hard_deleted) return null
  return { kind: 'link', label: t('modelSettings.suggestions.tonborg.open'),
    to: { path: '/organize', query: { item: peekItemValue({ spaceId: entry.personalSpaceId, id: entry.target }) } } }
}
