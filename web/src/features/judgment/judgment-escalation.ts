import { t } from '@/i18n'

import type { JudgmentDecisionRecord } from './judgment-types'

// Tonborg's floor for applying an approval by itself: REVIEW_CONFIDENCE_FLOOR in
// src/judgment/engine.js, and the same floor in acceptance.js. Records judged
// before 0.20.0 have no aiReview, so their low confidence is read against it.
const CONFIDENCE_FLOOR = 0.85
const INJECTION = ['injection_suspected', 'batch_contaminated']
// The trust gate's refusals the card names; warning_not_seen has its own line.
const GATE_REASONS: Record<string, string> = {
  session_answer: 'sessionAnswer',
  capture_off: 'captureOff',
  suggestions_only: 'suggestionsOnly',
  warning_not_seen: '',
}

const reason = (key: string, values: Record<string, string | number> = {}) => t(`judgment.workbench.reason.${key}`, values)

// Why a record Tonborg could have handled itself waits for the person, in one
// plain line; empty when the person chose 我来确认 or nothing waits. The most
// telling reason wins: suspected injection, a protected item, low confidence,
// Tonborg's own refusal, then why its model could not act alone.
export function escalationReason(record: JudgmentDecisionRecord): string {
  const mode = record.policy?.mode
  const waiting = record.outcome === 'escalate' || record.aiReview?.state === 'ai_suggested'
  if (!mode || mode === 'manual' || !waiting || record.execution.status !== 'not_applied') return ''
  if (record.kind === 'routing') return reason('askUser')
  const review = record.aiReview
  const interceptions = review?.interceptions ?? []
  if (interceptions.some(item => INJECTION.includes(item))) return reason('injection')
  if (interceptions.includes('needs_attention')) return reason('attention')
  const unsure = interceptions.includes('below_confidence')
    || (!interceptions.length && typeof record.confidence === 'number' && record.confidence < CONFIDENCE_FLOOR)
  if (unsure) return reason('unsure', { confidence: record.confidence ?? 0 })
  if (!review || review.modelOutcome === 'escalate') return reason('refused')
  if (interceptions.includes('gate_not_passed')) {
    const gate = review.gate?.reason ?? ''
    return gate in GATE_REASONS ? (GATE_REASONS[gate] ? reason(GATE_REASONS[gate]) : '') : reason('notTrusted')
  }
  return ''
}
