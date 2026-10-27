import { t } from '@/i18n'
import { tableLabel } from '@/i18n/label-table'

/** A recorded task reason as a person reads it. */
export interface TaskReason {
  /** One localized sentence; an Agent's own words when the reason carries no code. */
  text: string
  /** The code FULI does not have a description for yet, shown as small meta. */
  unknownCode: string | null
  /** The stored text, kept behind 原始信息 whenever text is not that text. */
  raw: string | null
}

// "worker_session_stopped. Actual model use is unverified." (a worker FULI started)
const WORKER_CODE = /^(worker_[a-z_]+)\.(?:\s|$)/
// "project_team_lead: <basis>; executor: <selection>" (a staffing decision), any other
// snake_case code before a colon, or a bare code. A plain word before a colon is prose.
const CODE_PREFIX = /^([a-z][a-z0-9]*(?:_[a-z0-9]+)+)(?::\s|$)/
const EXECUTOR_PART = /;\s*executor:\s*([^;]+?)\s*$/
// "recruitment cancelled: …" and "AR recruitment approved: …" (a recruitment decision).
const RECRUITMENT = /^(?:AR\s+)?recruitment\s+(cancelled|approved):/i
const WORKER_STAGE_FAILED = /^worker_[a-z]+(?:_[a-z]+)*_failed$/

// The executor selection records a phrase, not a code; each phrase it can write.
const EXECUTOR_REASONS: Record<string, string> = {
  'no usable executor': 'noUsableExecutor',
  'locked allow-list unavailable': 'lockedUnavailable',
  'locked executor allow-list': 'lockedAllowList',
  'explicit executor preference': 'explicitPreference',
  'same-level routing rule': 'sameLevelRule',
  'global executor priority': 'globalPriority',
}

function workerText(code: string) {
  return tableLabel('taskReason.worker', code)
    ?? (WORKER_STAGE_FAILED.test(code) ? t('taskReason.worker.stageFailed') : null)
}

function routingText(code: string, detail: string) {
  const routing = tableLabel('taskReason.routing', code)
  const phrase = EXECUTOR_PART.exec(detail)?.[1]?.toLowerCase()
  const executor = phrase ? tableLabel('taskReason.executor', EXECUTOR_REASONS[phrase]) : null
  if (routing && executor) return t('taskReason.withExecutor', { routing, executor })
  return routing
}

const unknown = (code: string, raw: string): TaskReason => ({ text: t('taskReason.unknown'), unknownCode: code, raw })

/**
 * What a task's recorded reason (blocker, failure, waiting state) means.
 * A code reads as its sentence and an unknown code as a generic sentence plus
 * the code, never as the stored English; text without a code is an Agent's own
 * words and reads as written. Null when nothing was recorded.
 */
export function taskReason(recorded: string | null | undefined): TaskReason | null {
  const raw = recorded?.trim()
  if (!raw) return null
  const worker = WORKER_CODE.exec(raw)?.[1]
  if (worker) {
    const text = workerText(worker)
    return text ? { text, unknownCode: null, raw } : unknown(worker, raw)
  }
  const recruitment = RECRUITMENT.exec(raw)?.[1]
  if (recruitment) return { text: t(`taskReason.recruitment.${recruitment.toLowerCase()}`), unknownCode: null, raw }
  const code = CODE_PREFIX.exec(raw)?.[1]
  if (code) {
    const text = routingText(code, raw)
    return text ? { text, unknownCode: null, raw } : unknown(code, raw)
  }
  return { text: raw, unknownCode: null, raw: null }
}
