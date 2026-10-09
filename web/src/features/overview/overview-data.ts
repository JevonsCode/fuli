import type { PersonalProject, ProjectAgentTaskRecord, ProjectAgentTaskStatus } from '@/types'
import { arrayOf, normalizeTask, unknownRecord } from '@/features/project-agents/task-evidence'

export const CURRENT_WORK_STATUSES = new Set<ProjectAgentTaskStatus>([
  'awaiting_recruitment',
  'queued',
  'running',
  'paused',
  'awaiting_review',
  'blocked',
])

export interface OverviewProject {
  id: string
  name: string
  updatedAt: string | null
  taskCount: number
}

export function normalizeOverviewTasks(value: unknown, personalSpaceId?: string) {
  const record = unknownRecord(value)
  const rows = arrayOf(Array.isArray(value) ? value : record.tasks ?? record.items)
  return rows
    .map(normalizeTask)
    .filter((task): task is ProjectAgentTaskRecord => Boolean(
      task && (!personalSpaceId || !task.personalSpaceId || task.personalSpaceId === personalSpaceId),
    ))
}

export function currentWork(tasks: ProjectAgentTaskRecord[], limit = 6) {
  return tasks
    .filter((task) => CURRENT_WORK_STATUSES.has(task.status))
    .sort(compareTasks)
    .slice(0, limit)
}

export function recentProjects(
  tasks: ProjectAgentTaskRecord[],
  projects: PersonalProject[],
  limit = 6,
): OverviewProject[] {
  const projectNames = new Map(projects.map((project) => [project.project_id, project.profile.name]))
  const derived = new Map<string, OverviewProject>()
  for (const task of tasks) {
    const id = task.personalProjectId
    if (!id) continue
    const updatedAt = task.updatedAt ?? task.createdAt ?? null
    const current = derived.get(id)
    if (!current) {
      derived.set(id, { id, name: projectNames.get(id) ?? id, updatedAt, taskCount: 1 })
      continue
    }
    current.taskCount += 1
    if (compareDates(updatedAt, current.updatedAt) < 0) current.updatedAt = updatedAt
  }
  if (derived.size) return [...derived.values()].sort(compareProjects).slice(0, limit)
  return projects.slice(0, limit).map((project) => ({
    id: project.project_id,
    name: project.profile.name,
    updatedAt: null,
    taskCount: 0,
  }))
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

export function overviewAttentionTaskHref(item: {
  agentId: string
  personalProjectId: string
  taskId: string
}) {
  const query = new URLSearchParams({
    agent: item.agentId,
    project: item.personalProjectId,
    task: item.taskId,
  })
  return `/project-agents/manage?${query}#task-${encodeURIComponent(item.taskId)}`
}

function compareTasks(left: ProjectAgentTaskRecord, right: ProjectAgentTaskRecord) {
  return compareDates(left.updatedAt ?? left.createdAt ?? null, right.updatedAt ?? right.createdAt ?? null)
    || right.taskId.localeCompare(left.taskId)
}

function compareProjects(left: OverviewProject, right: OverviewProject) {
  return compareDates(left.updatedAt, right.updatedAt)
    || right.taskCount - left.taskCount
    || left.name.localeCompare(right.name)
}

function compareDates(left: string | null | undefined, right: string | null | undefined) {
  const leftTime = left ? Date.parse(left) : Number.NaN
  const rightTime = right ? Date.parse(right) : Number.NaN
  if (!Number.isNaN(leftTime) && !Number.isNaN(rightTime)) return rightTime - leftTime
  if (!Number.isNaN(leftTime)) return -1
  if (!Number.isNaN(rightTime)) return 1
  return String(right ?? '').localeCompare(String(left ?? ''))
}
