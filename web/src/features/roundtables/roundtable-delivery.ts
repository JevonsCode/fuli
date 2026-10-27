import { t } from '@/i18n'
import type { ChatDelivery } from './roundtable-model'

const REASONS = new Set(['not_waiting', 'nested_limit', 'task_context_required', 'no_client', 'wake_failed', 'peer_send_failed',
  'no_working_directory', 'instant_unavailable', 'execution_claimed', 'cleanup_unconfirmed', 'wake_timeout',
  'client_login_required', 'client_unavailable', 'delegation_not_redeemed', 'session_mismatch', 'cancelled',
  'lead_changed', 'lead_unavailable', 'client_not_allowed', 'agent_unavailable', 'provider_error'])

/** A stored failure code in words when known; an unknown code stays visible as recorded. */
export const reasonLabel = (code: string | null) => !code ? '' : REASONS.has(code) ? t(`roundtable.reasons.${code}`) : code

/** An unknown status keeps its recorded value and says it is unknown. */
export function statusLabel(status: string) {
  const key = `roundtable.status.${status}`
  const label = t(key)
  return label === key ? t('roundtable.statusUnknown', { status }) : label
}

/** One recipient's state of one message, in words, from what was recorded. */
export function deliveryLabel({ to, state }: ChatDelivery, via: string | null) {
  const name = to.name ?? t('roundtable.unknownAgent')
  if (state.kind === 'held' || state.kind === 'failed') return t(`roundtable.delivery.${state.kind}`, { name, reason: reasonLabel(state.reason) })
  if (state.kind === 'status') return via === 'peer' && state.status === 'sent' ? t('roundtable.status.remoteQueued') : statusLabel(state.status)
  return t(`roundtable.delivery.${state.kind}`, { name })
}

/** A held message reads as a warning and a failed one as danger, in the shared status tones. */
export const deliveryTone = ({ state }: ChatDelivery) => state.kind === 'failed' ? 'danger' : state.kind === 'held' ? 'warning' : undefined

/** How a reply was produced: a woken conversation, a new session, or during a task. */
export function viaLabel(via: string | null) {
  const mode = via?.split(':')[1]
  return mode && ['resume', 'new', 'inbox'].includes(mode) ? t(`roundtable.via.${mode}`) : ''
}
