import type { ProjectAgentTaskRecord, ProjectAgentTaskStatus } from '@/types'
import { arrayOf, normalizeTask, unknownRecord } from '@/features/project-agents/task-evidence'
import { currentLocale, t } from '@/i18n'
import { formatDateTime } from '@/lib/date-time'

export const CURRENT_WORK_STATUSES = new Set<ProjectAgentTaskStatus>([
  'awaiting_recruitment',
  'queued',
  'running',
  'paused',
  'awaiting_review',
  'blocked',
  'failed',
])

export function normalizeOverviewTasks(value: unknown, personalSpaceId?: string) {
  const record = unknownRecord(value)
  const rows = arrayOf(Array.isArray(value) ? value : record.tasks ?? record.items)
  return rows
    .map(normalizeTask)
    .filter((task): task is ProjectAgentTaskRecord => Boolean(
      task && (!personalSpaceId || !task.personalSpaceId || task.personalSpaceId === personalSpaceId),
    ))
}

/** Missing content stays missing; normalized identifiers are never business titles. */
export function overviewTaskTitle(task: ProjectAgentTaskRecord) {
  const title = task.title?.trim()
  if (title && title !== task.taskId) return title
  const objective = task.objective?.trim()
  return objective && objective !== task.taskId ? objective : ''
}

/** A request's or task's time on the home pages: month, day and minute, or that it is missing. */
export function overviewTime(value?: string | null) {
  return formatDateTime(value, currentLocale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' },
    { missing: t('overview.missing.time'), invalid: t('overview.missing.time') })
}

export function overviewOwnerId(task: ProjectAgentTaskRecord) {
  return task.leadAgentId?.trim() || task.ownerAgentId?.trim() || null
}

// How many FLAs one page reads names for; the ones past it say the name is not available.
const OVERVIEW_NAME_LIMIT = 240

/** Every FLA the workbench can name, most visible first: requests, then each task's lead, participants and history. */
export function overviewAgentIds(requests: readonly { agentId: string }[], tasks: readonly ProjectAgentTaskRecord[]) {
  const ids = [
    ...requests.map(item => item.agentId),
    ...tasks.map(overviewOwnerId),
    ...tasks.flatMap(task => [...(task.participants ?? []).map(participant => participant.agentId),
      ...(task.events ?? []).map(event => event.agentId)]),
  ].map(id => id?.trim()).filter((id): id is string => Boolean(id))
  return [...new Set(ids)].slice(0, OVERVIEW_NAME_LIMIT)
}

export function overviewTaskHref(task: ProjectAgentTaskRecord) {
  const query = new URLSearchParams()
  const agentId = task.leadAgentId
    ?? task.ownerAgentId
    ?? task.participants.find((participant) => participant.agentId)?.agentId
  if (agentId) query.set('agent', agentId)
  if (task.personalProjectId) query.set('project', task.personalProjectId)
  query.set('task', task.taskId)
  return `/project-agents/manage?${query}#task-${encodeURIComponent(task.taskId)}`
}
