import { currentLocale, t } from '@/i18n'
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
  if (!value) return t('projectAgents.notReported')
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return t('projectAgents.notReported')
  return new Intl.DateTimeFormat(currentLocale(), { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date)
}

export function strategyLabel(strategy: ProjectAgentModelStrategy | null | undefined) {
  const mode = strategy?.mode ?? 'adaptive'
  return strategy?.reasoningEffort && strategy.reasoningEffort !== 'default'
    ? `${mode} · ${strategy.reasoningEffort}` : mode
}

export function policyLabel(policy: ProjectAgentExecutorPolicy | null | undefined) {
  return policy?.mode ?? 'flexible'
}

export function taskStatusLabel(status: ProjectAgentTaskStatus | ProjectAgentWorkStatus | string) {
  const key = `projectAgents.taskStatus.${status}`
  const translated = t(key)
  return translated === key ? status : translated
}

export function sourceLabel(source: ConversationSourceApplication | null | undefined) {
  return source ? t(`projectAgents.clients.${source}`) : t('projectAgents.notReported')
}

export function participantRoleLabel(role: string | null | undefined) {
  if (!role) return t('projectAgents.notReported')
  const key = `projectAgents.participantRoles.${role}`
  const translated = t(key)
  return translated === key ? role : translated
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
