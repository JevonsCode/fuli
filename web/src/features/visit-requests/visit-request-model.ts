import { t } from '@/i18n'
import { REQUESTER_MODES, VISIT_STATES, type RequesterMode, type VisitEvent, type VisitRequest, type VisitRequestCard } from './visit-request-shape'
import type { VisitAction } from './visit-request-api'

// How the console words and offers work another computer asked for: plain
// data in, plain words or lists out.

/** A request still waiting on the person or running; the rest only reads. */
const ACTIONS: Partial<Record<VisitRequest['state'], VisitAction[]>> = {
  received: ['cancel'], planning: ['cancel'], approved: ['cancel'], running: ['cancel'],
  awaiting_owner: ['decline', 'approve'],
  awaiting_review: ['discard', 'keep'],
}

/** The actions valid for the request's state, in the order they stand (the main one last). */
export function visitActions(request: Pick<VisitRequest, 'state'>): VisitAction[] {
  return ACTIONS[request.state] ?? []
}

/** A guest link is never 自动 or 完全信任 (src/visitor-access/port.js). */
const GUEST_MODES: readonly RequesterMode[] = ['ask_only', 'plan']

function requesterKind(key: string): 'peer' | 'guest' {
  return key.startsWith('guest:') ? 'guest' : 'peer'
}

export function modesFor(key: string): readonly RequesterMode[] {
  return requesterKind(key) === 'guest' ? GUEST_MODES : REQUESTER_MODES
}

/** Who asked: the other computer and, when it named one, its assistant. */
export function askerLine(requester: VisitRequest['requester']) {
  return requester.agentName
    ? t('visitRequests.asker', { computer: requester.label, assistant: requester.agentName })
    : requester.label
}

/** The state in plain words; a finished run waiting for the person says whether it is ready or held. */
export function visitStateLabel(request: Pick<VisitRequest, 'state' | 'review'>) {
  if (request.state === 'awaiting_review' && request.review) return t(`visitRequests.review.${request.review}`)
  return t(`visitRequests.states.${request.state}`)
}

/**
 * The requester's own words as they are shown: text only, without control,
 * zero-width or bidirectional characters. Line breaks and tabs stay.
 */
const HIDDEN_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF]/g
export function shownText(text: string) {
  return text.replace(HIDDEN_CHARACTERS, '')
}

/** Why the assistant's assessment is missing, in plain words. */
export function planErrorText(code: string) {
  return ['planning_interrupted', 'plan_unreadable', 'no_working_directory'].includes(code)
    ? t(`visitRequests.card.planErrors.${code}`) : t('visitRequests.card.planErrors.other')
}

/** How the request ended when it ended without a result, or null. */
export function endingText(request: Pick<VisitRequest, 'state' | 'reason' | 'error'>) {
  if (request.state === 'refused') {
    return request.reason === 'ask_only' || request.reason === 'budget_exceeded'
      ? t(`visitRequests.card.refused.${request.reason}`) : t('visitRequests.card.refused.other')
  }
  if (request.state === 'declined' && request.reason) return t('visitRequests.card.ownReason', { reason: shownText(request.reason) })
  if (request.state === 'unknown') return t('visitRequests.card.restarted')
  if (request.state === 'failed') return t('visitRequests.card.failed')
  return null
}

/** Who decided and under which mode. */
export function decisionText(request: Pick<VisitRequest, 'decidedBy' | 'modeAtDecision' | 'modeAtReceipt'>) {
  if (request.decidedBy === 'owner') return t('visitRequests.card.byOwner')
  if (request.decidedBy === 'rule') {
    return t('visitRequests.card.byRule', { mode: modeName(request.modeAtDecision ?? request.modeAtReceipt) })
  }
  return t('visitRequests.card.undecided')
}

export function modeName(mode: RequesterMode) {
  return t(`visitRequests.mode.names.${mode}`)
}

const KNOWN_CHECKS = new Set(['budget_left', 'plan_ready', 'areas_inside_project', 'no_dependency_changes', 'no_config_changes',
  'no_network', 'paths_inside_worktree', 'no_denied_paths', 'no_executables', 'within_size', 'no_secrets', 'integrity'])
export function checkName(name: string) {
  return KNOWN_CHECKS.has(name) ? t(`visitRequests.checks.${name}`) : name
}

/** Every check a rule made on the way, in order. */
export function ruleChecks(card: Pick<VisitRequestCard, 'events'>) {
  return card.events.flatMap(event => event.checks ?? [])
}

const ACTORS = new Set(['owner', 'rule', 'system', 'requester'])
const STATES = new Set<string>(VISIT_STATES)
/** One step of the timeline: who moved it and to what. */
export function eventText(event: Pick<VisitEvent, 'by' | 'to'>) {
  const who = ACTORS.has(event.by) ? t(`visitRequests.card.by.${event.by}`) : event.by
  const state = STATES.has(event.to) ? t(`visitRequests.states.${event.to}`) : event.to
  return t('visitRequests.card.event', { who, state })
}
