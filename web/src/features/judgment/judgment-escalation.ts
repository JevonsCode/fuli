import type { RouteLocationRaw } from 'vue-router'

import { modelDetailsLink, modelEditLink, modelProjectsLink } from '@/features/model-settings/details-link'
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
  if (interceptions.includes('gate_not_passed')) return gateReason(review.gate?.reason ?? '')
  return ''
}

const gateReason = (gate: string) => (gate in GATE_REASONS ? (GATE_REASONS[gate] ? reason(GATE_REASONS[gate]) : '') : reason('notTrusted'))

// What the person can do about a reason that is a setting of theirs, so the line
// never stops at 「交给你确认」 (docs/console-design.md): where to change it, one click.
// The gate reasons are role-trust.js's refusals; any other opens Tonborg's trust settings.
const SETTING_ACTIONS: Record<string, { to: RouteLocationRaw, label: string }> = {
  session_answer: { to: modelEditLink('tonborg'), label: 'connectModel' },
  not_configured: { to: modelEditLink('tonborg'), label: 'connectModel' },
  egress_not_approved: { to: modelProjectsLink('tonborg'), label: 'chooseProjects' },
  capture_off: { to: { path: '/settings', query: { tab: 'recording' } }, label: 'openRecording' },
}

/** Where to change what kept this record from Tonborg, or null when the reason is the item itself. */
export function escalationAction(record: JudgmentDecisionRecord): { to: RouteLocationRaw, label: string } | null {
  const shown = escalationReason(record)
  const gate = record.aiReview?.gate?.reason ?? ''
  // Only when the gate is the reason the card names: an injection or a doubt is about the item.
  if (!shown || !record.aiReview?.interceptions?.includes('gate_not_passed') || shown !== gateReason(gate)) return null
  const action = SETTING_ACTIONS[gate] ?? { to: modelDetailsLink('tonborg'), label: 'openTrust' }
  return { to: action.to, label: t(`judgment.workbench.reasonAction.${action.label}`) }
}
