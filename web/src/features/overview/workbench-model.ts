import type { ProjectAgentTaskEvent, ProjectAgentTaskParticipant, ProjectAgentTaskRecord } from '@/types'
import { overviewOwnerId } from './overview-data'

/** A task's own key: the same task id may exist in two projects. */
export const taskKey = (task: Pick<ProjectAgentTaskRecord, 'personalProjectId' | 'taskId'>) => `${task.personalProjectId ?? ''}:${task.taskId}`

/**
 * The FLAs on a task, one row each: the participants the task records, or its
 * lead alone when it records none. Finished means the FLA's own assignment
 * completed; nothing is inferred from time or from the task's status.
 */
export function taskFlas(task: ProjectAgentTaskRecord): ProjectAgentTaskParticipant[] {
  const seen = new Set<string>()
  const rows = task.participants.filter(participant => participant.agentId && !seen.has(participant.agentId) && seen.add(participant.agentId))
  if (rows.length) return rows
  const lead = overviewOwnerId(task)
  return lead ? [{ agentId: lead, role: 'lead', status: task.status }] : []
}

export function flaProgress(task: ProjectAgentTaskRecord) {
  const flas = taskFlas(task)
  return { done: flas.filter(fla => fla.status === 'completed').length, total: flas.length }
}

/** What happened on the task, newest first, as the task itself recorded it. */
export function taskLog(task: ProjectAgentTaskRecord, limit = 12): ProjectAgentTaskEvent[] {
  return [...(task.events ?? [])]
    .filter(event => event.summary?.trim())
    .sort((a, b) => eventTime(b) - eventTime(a))
    .slice(0, limit)
}

/** Finished work, most recent first. */
export function recentlyDone(tasks: readonly ProjectAgentTaskRecord[], limit = 6) {
  return tasks
    .filter(task => task.status === 'completed')
    .sort((a, b) => doneTime(b) - doneTime(a))
    .slice(0, limit)
}

const parse = (value?: string | null) => {
  const time = value ? Date.parse(value) : NaN
  return Number.isNaN(time) ? 0 : time
}
const eventTime = (event: ProjectAgentTaskEvent) => parse(event.createdAt)
const doneTime = (task: ProjectAgentTaskRecord) => parse(task.completedAt ?? task.updatedAt ?? task.createdAt)
