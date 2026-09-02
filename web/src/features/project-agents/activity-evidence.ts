import type {
  ConversationSourceApplication, ProjectAgentActivityDay, ProjectAgentActivityResult,
} from '@/types'
import {
  arrayOf, normalizeActual, normalizeParticipant, normalizeTokenUsage,
  normalizeWorkerRuntime, stringArrayOf, stringOf, unknownRecord, valueOf,
} from './task-evidence'

export function activityRange() {
  const to = new Date()
  const from = new Date(to)
  from.setUTCFullYear(from.getUTCFullYear() - 1)
  return { fromDate: toIsoDate(from), toDate: toIsoDate(to) }
}
function toIsoDate(value: Date) { return value.toISOString().slice(0, 10) }
export function normalizeActivity(
  value: unknown, fallback: { agentId: string; personalSpaceId: string },
): ProjectAgentActivityResult | null {
  const record = unknownRecord(value); const rawDays = arrayOf(record.days)
  if (!rawDays.length && !('days' in record)) return null
  const reportedDays = rawDays.map((raw) => {
    const item = unknownRecord(raw)
    return {
      date: stringOf(item, 'date', 'date') ?? '', completed: typeof item.completed === 'number' ? item.completed : 0,
      failed: typeof item.failed === 'number' ? item.failed : 0, cancelled: typeof item.cancelled === 'number' ? item.cancelled : 0,
      total: typeof item.total === 'number' ? item.total : 0, tasks: arrayOf(item.tasks).map(normalizeActivityTask).filter((task): task is NonNullable<ReturnType<typeof normalizeActivityTask>> => Boolean(task)),
    }
  }).filter(({ date }) => date)
  const reportedFrom = stringOf(record, 'fromDate', 'from_date')
  const reportedTo = stringOf(record, 'toDate', 'to_date')
  const hasHistory = reportedDays.some(({ total, tasks }) => total > 0 || Boolean(tasks?.length))
  const fromDate = reportedFrom ?? (reportedDays.length ? reportedDays.map(({ date }) => date).sort()[0] : undefined)
  const toDate = reportedTo ?? (reportedDays.length ? reportedDays.map(({ date }) => date).sort().at(-1) : undefined)
  const days = hasHistory && fromDate && toDate
    ? fillActivityCalendar(reportedDays, fromDate, toDate)
    : []
  return { agentId: stringOf(record, 'agentId', 'agent_id') ?? fallback.agentId, personalSpaceId: stringOf(record, 'personalSpaceId', 'personal_space_id') ?? fallback.personalSpaceId, fromDate, toDate, days }
}

function fillActivityCalendar(reportedDays: ProjectAgentActivityDay[], fromDate: string, toDate: string) {
  const byDate = new Map(reportedDays.map((day) => [day.date, day]))
  const from = new Date(`${fromDate}T00:00:00Z`)
  const to = new Date(`${toDate}T00:00:00Z`)
  if (Number.isNaN(from.valueOf()) || Number.isNaN(to.valueOf()) || from > to) return reportedDays
  const days: ProjectAgentActivityDay[] = []
  for (const cursor = new Date(from); cursor <= to; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const date = toIsoDate(cursor)
    days.push(byDate.get(date) ?? { date, completed: 0, failed: 0, cancelled: 0, total: 0, tasks: [] })
  }
  return days.reverse()
}

function normalizeActivityTask(value: unknown): NonNullable<ProjectAgentActivityDay['tasks']>[number] | null {
  const record = unknownRecord(value); const taskId = stringOf(record, 'taskId', 'task_id'); if (!taskId) return null
  const reportedActual = normalizeActual(valueOf(record, 'actualExecution', 'actual_execution')) ?? normalizeActual({
    executor: stringOf(record, 'actualExecutor', 'actual_executor'),
    provider: stringOf(record, 'actualModelProvider', 'actual_model_provider'),
    model: stringOf(record, 'actualModel', 'actual_model'),
    client: stringOf(record, 'sourceApplication', 'source_application'),
  })
  return {
    taskId, title: stringOf(record, 'title', 'title') ?? taskId, status: stringOf(record, 'status', 'status') as 'completed' | 'failed' | 'cancelled',
    summary: stringOf(record, 'summary', 'summary') ?? '', occurredAt: stringOf(record, 'occurredAt', 'occurred_at') ?? '',
    personalProjectId: stringOf(record, 'personalProjectId', 'personal_project_id'), assignmentId: stringOf(record, 'assignmentId', 'assignment_id'),
    collaborators: arrayOf(record.collaborators).map(normalizeParticipant), sourceApplication: stringOf(record, 'sourceApplication', 'source_application') as ConversationSourceApplication | null,
    sourceSessionId: stringOf(record, 'sourceSessionId', 'source_session_id'),
    sourceSessionUrl: stringOf(record, 'sourceSessionUrl', 'source_session_url'),
    workerRuntime: normalizeWorkerRuntime(valueOf(record, 'workerRuntime', 'worker_runtime')),
    toolsUsed: stringArrayOf(record, 'toolsUsed', 'tools_used'),
    tokenUsage: normalizeTokenUsage(valueOf(record, 'tokenUsage', 'token_usage')),
    actualExecution: reportedActual, actualModelProvider: stringOf(record, 'actualModelProvider', 'actual_model_provider'), actualModel: stringOf(record, 'actualModel', 'actual_model'),
  }
}
