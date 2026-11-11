import type { ProjectAgentTaskRecord, ProjectAgentTaskStatus } from '@/types'
import { arrayOf, normalizeTask, unknownRecord } from '@/features/project-agents/task-evidence'
import type { AgentAttention } from '@/features/project-agents/attention-store'

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

export function currentWork(tasks: readonly ProjectAgentTaskRecord[], limit = 6) {
  return tasks
    .filter((task) => CURRENT_WORK_STATUSES.has(task.status))
    .sort(compareTasks)
    .slice(0, limit)
}

/** Missing content stays missing; normalized identifiers are never business titles. */
export function overviewTaskTitle(task: ProjectAgentTaskRecord) {
  const title = task.title?.trim()
  if (title && title !== task.taskId) return title
  const objective = task.objective?.trim()
  return objective && objective !== task.taskId ? objective : ''
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

export function overviewOpenRequest(task: ProjectAgentTaskRecord, items: readonly AgentAttention[], spaceId: string) {
  return items.find(item => item.status === 'open' && item.personalSpaceId === spaceId
    && task.personalSpaceId === spaceId
    && item.personalProjectId === task.personalProjectId && item.taskId === task.taskId)
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

function compareTasks(left: ProjectAgentTaskRecord, right: ProjectAgentTaskRecord) {
  const rank = (task: ProjectAgentTaskRecord) => task.status === 'blocked' || task.status === 'failed' ? 0 : task.status === 'awaiting_review' ? 1 : 2
  return rank(left) - rank(right)
    || compareDates(left.updatedAt ?? left.createdAt ?? null, right.updatedAt ?? right.createdAt ?? null)
    || right.taskId.localeCompare(left.taskId)
}

function compareDates(left: string | null | undefined, right: string | null | undefined) {
  const leftTime = left ? Date.parse(left) : Number.NaN
  const rightTime = right ? Date.parse(right) : Number.NaN
  if (!Number.isNaN(leftTime) && !Number.isNaN(rightTime)) return rightTime - leftTime
  if (!Number.isNaN(leftTime)) return -1
  if (!Number.isNaN(rightTime)) return 1
  return String(right ?? '').localeCompare(String(left ?? ''))
}
