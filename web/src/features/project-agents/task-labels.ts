import { currentLocale, t } from '@/i18n'
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

/** A reported enum value through its label table; an unknown value stays as reported. */
function tableLabel(table: string, value: string) {
  const key = `projectAgents.${table}.${value}`
  const translated = t(key)
  return translated === key ? value : translated
}

export function taskStatusLabel(status: ProjectAgentTaskStatus | ProjectAgentWorkStatus | string) {
  return tableLabel('taskStatus', status)
}

export function recruitmentStatusLabel(status: string) {
  return tableLabel('recruitmentStatus', status)
}

export function recruitmentPositionLabel(positionKind: string) {
  return tableLabel('recruitmentPosition', positionKind)
}

export function memoryScopeLabel(scope: string | null | undefined) {
  return scope ? tableLabel('memoryScopes', scope) : t('projectAgents.notReported')
}

/**
 * How a task status reads at a glance, as a Badge variant: trouble is danger,
 * waiting on a person or a breaker is warning, live work is primary, done is
 * success, anything else stays neutral.
 */
export function taskStatusTone(status: ProjectAgentTaskStatus | ProjectAgentWorkStatus | string) {
  if (status === 'blocked' || status === 'failed') return 'destructive' as const
  if (['awaiting_review', 'waiting_for_human', 'paused', 'awaiting_recruitment'].includes(status)) return 'warning' as const
  if (status === 'running') return 'default' as const
  if (status === 'completed') return 'success' as const
  return 'secondary' as const
}

export function sourceLabel(source: ConversationSourceApplication | null | undefined) {
  return source ? t(`projectAgents.clients.${source}`) : t('projectAgents.notReported')
}

export function participantRoleLabel(role: string | null | undefined) {
  return role ? tableLabel('participantRoles', role) : t('projectAgents.notReported')
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
