import { currentLocale, t } from '@/i18n'
import { tableLabel } from '@/i18n/label-table'
import { formatDateTime } from '@/lib/date-time'
import type {
  ConversationSourceApplication,
  ProjectAgentActualExecution,
  ProjectAgentExecutorPolicy,
  ProjectAgentModelStrategy,
  ProjectAgentTaskEvent,
  ProjectAgentTaskExecutionSummary,
  ProjectAgentTaskRecord,
  ProjectAgentTaskStatus,
  ProjectAgentTokenUsage,
  ProjectAgentWorkStatus,
} from '@/types'
import { eventExecution } from './task-evidence'

export function formatDate(value: string | null | undefined) {
  const notReported = t('projectAgents.notReported')
  return formatDateTime(value, currentLocale(), {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }, { missing: notReported, invalid: notReported })
}

export function strategyLabel(strategy: ProjectAgentModelStrategy | null | undefined) {
  const mode = strategy?.mode ?? 'adaptive'
  return strategy?.reasoningEffort && strategy.reasoningEffort !== 'default'
    ? `${mode} · ${strategy.reasoningEffort}` : mode
}

export function policyLabel(policy: ProjectAgentExecutorPolicy | null | undefined) {
  return policy?.mode ?? 'flexible'
}

/** A reported enum value through its label table; an unknown value stays as reported unless the caller names it. */
function projectAgentLabel(table: string, value: string, unrecognized = value) {
  return tableLabel(`projectAgents.${table}`, value) ?? unrecognized
}

/** The one label table for task and work statuses (Agents, Overview, Bole). */
export function taskStatusLabel(status: ProjectAgentTaskStatus | ProjectAgentWorkStatus | string, options: { unrecognized?: string } = {}) {
  return projectAgentLabel('taskStatus', status, options.unrecognized)
}

export function recruitmentStatusLabel(status: string) {
  return projectAgentLabel('recruitmentStatus', status)
}

export function recruitmentPositionLabel(positionKind: string) {
  return projectAgentLabel('recruitmentPosition', positionKind)
}

export function memoryScopeLabel(scope: string | null | undefined) {
  return scope ? projectAgentLabel('memoryScopes', scope) : t('projectAgents.notReported')
}

export type StatusTone = 'danger' | 'warning' | 'active' | 'success' | 'neutral'

const DANGER_STATUSES = new Set(['blocked', 'failed', 'unavailable'])
const WARNING_STATUSES = new Set(['awaiting_review', 'paused', 'awaiting_recruitment'])
const ACTIVE_STATUSES = new Set(['running', 'in_progress'])

/**
 * The one status → tone mapping for every task, work, worker and plan-step
 * status, so one status always has one colour: trouble (blocked, failed) is
 * danger, waiting on a person or a breaker is warning, live work is active,
 * done is success, anything else (queued, ended, cancelled) stays neutral.
 * A problem is never green. Pages colour statuses with these tones only:
 * Badge through taskStatusTone, UiChip through taskStatusChipTone, page CSS
 * through a data-tone attribute.
 */
export function statusTone(status: ProjectAgentTaskStatus | ProjectAgentWorkStatus | string): StatusTone {
  if (DANGER_STATUSES.has(status)) return 'danger'
  if (WARNING_STATUSES.has(status)) return 'warning'
  if (ACTIVE_STATUSES.has(status)) return 'active'
  if (status === 'completed') return 'success'
  return 'neutral'
}

const BADGE_VARIANTS = { danger: 'destructive', warning: 'warning', active: 'default', success: 'success', neutral: 'secondary' } as const
const CHIP_TONES = { danger: 'danger', warning: 'warning', active: 'accent', success: 'neutral', neutral: 'neutral' } as const

/** A status as a Badge variant. */
export function taskStatusTone(status: ProjectAgentTaskStatus | ProjectAgentWorkStatus | string) {
  return BADGE_VARIANTS[statusTone(status)]
}

/** A status as a UiChip tone (UiChip has no success tone; done reads neutral). */
export function taskStatusChipTone(status: ProjectAgentTaskStatus | ProjectAgentWorkStatus | string) {
  return CHIP_TONES[statusTone(status)]
}

export function sourceLabel(source: ConversationSourceApplication | null | undefined) {
  return source ? projectAgentLabel('clients', source) : t('projectAgents.notReported')
}

export function participantRoleLabel(role: string | null | undefined) {
  return role ? projectAgentLabel('participantRoles', role) : t('projectAgents.notReported')
}

export function actualExecution(task: ProjectAgentTaskRecord): ProjectAgentActualExecution | null {
  if (task.actualExecution) return task.actualExecution
  const event = [...(task.events ?? [])].reverse().find((item) => item.actualExecution)
  return event ? eventExecution(event) : null
}

export function workerEventLabel(event: ProjectAgentTaskEvent) {
  if (event.workerLabel && event.workerId && event.workerLabel !== event.workerId) {
    return `${event.workerLabel} · ${event.workerId}`
  }
  return event.workerLabel || event.workerId || t('projectAgents.notReported')
}

export function executionSummaryStatusLabel(status: string | null | undefined) {
  return status ? taskStatusLabel(status) : t('projectAgents.notReported')
}

export function executionSummaryWorkerLabel(summary: ProjectAgentTaskExecutionSummary) {
  return summary.workerLabel || summary.agentName || summary.workerId || summary.agentId || t('projectAgents.notReported')
}

export function executionSummaryOccupationEmoji(summary: ProjectAgentTaskExecutionSummary) {
  return summary.workerOccupationEmoji || summary.occupationEmoji || ''
}

export function tokenUsageLabel(usage: ProjectAgentTokenUsage | null | undefined) {
  if (!usage || !['executor', 'host', 'dingdong'].includes(usage.source)
    || !Number.isSafeInteger(usage.totalTokens) || usage.totalTokens < 0) return '-'
  return `${new Intl.NumberFormat(currentLocale()).format(usage.totalTokens)} Token · ${t(`projectAgents.tokenSources.${usage.source}`)}`
}

// Only links that cannot leak credentials or reach arbitrary hosts become clickable.
export function sessionHref(raw: string | null | undefined) {
  const value = raw?.trim()
  if (!value) return null
  try {
    const url = new URL(value)
    if (url.username || url.password || url.search || url.hash) return null
    if (url.protocol === 'https:') return value
    if (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return value
    if (url.protocol === 'codex:' && url.hostname === 'threads' && url.pathname !== '/') return value
  } catch {
    return null
  }
  return null
}

export function executionSummarySessionHref(summary: ProjectAgentTaskExecutionSummary) {
  return sessionHref(summary.workerRuntime ? summary.workerRuntime.sessionUrl : summary.sourceSessionUrl)
}

export function executionSummarySessionId(summary: ProjectAgentTaskExecutionSummary) {
  return summary.workerRuntime ? summary.workerRuntime.sessionId : summary.sourceSessionId
}
