import type { AgentAttention } from '@/features/project-agents/attention-store'
import type { Notice } from '@/features/overview/notices'
import { overviewOwnerId, overviewTaskTitle } from '@/features/overview/overview-data'
import type { TeamSheet } from '@/features/team-work/team-sheets'
import type { ProjectAgentTaskRecord, ProjectAgentTaskSession } from '@/types'

// What 今天 shows in each section, as plain data. The page and its cards only render it.
export const DECISION_ROWS = 5
export const DONE_ROWS = 5
export const WORKING_ROWS = 6

export type DecisionRow =
  | { kind: 'request'; item: AgentAttention }
  | { kind: 'review'; count: number }
  | { kind: 'conflicts'; count: number }

/**
 * 等你拍板, at most five rows: the open requests first, then one row for the
 * habits waiting to be confirmed, then one for preferences that disagree.
 * `more` counts what waits and no row stands for.
 */
export function decisionRows({ requests, requestTotal, reviewTotal, conflicts }: {
  requests: readonly AgentAttention[]; requestTotal: number; reviewTotal: number; conflicts: number
}): { rows: DecisionRow[]; more: number } {
  const rows: DecisionRow[] = requests.slice(0, DECISION_ROWS).map(item => ({ kind: 'request', item }))
  let more = Math.max(requestTotal, requests.length) - rows.length
  for (const row of [{ kind: 'review', count: reviewTotal }, { kind: 'conflicts', count: conflicts }] as const) {
    if (row.count <= 0) continue
    if (rows.length < DECISION_ROWS) rows.push(row)
    else more += row.count
  }
  return { rows, more }
}

/** The notices from the person's local today, newest first as the server sent them. */
export function todayNotices(items: readonly Notice[], now: Date) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime()
  return items.filter(item => { const at = Date.parse(item.at); return at >= start && at < end }).slice(0, DONE_ROWS)
}

// Work an assistant is doing now: not waiting on the person, not stopped, not finished.
const WORKING = new Set(['running', 'queued', 'awaiting_recruitment'])

/** `sessions`: the clients the work runs in, as its own task records name them; a shared row has none. */
export interface WorkingRow { key: string; agentId: string | null; projectId: string | null; title: string; team: boolean; sessions: ProjectAgentTaskSession[] }

/** 正在干活: each task an assistant is on now, its own first, then shared ones the task list did not have. */
export function workingRows(tasks: readonly ProjectAgentTaskRecord[], sheets: readonly TeamSheet[]): WorkingRow[] {
  const own = tasks.filter(task => WORKING.has(task.status)).map(task => ({
    key: task.taskId, agentId: overviewOwnerId(task), projectId: task.personalProjectId ?? null, title: overviewTaskTitle(task), team: false, sessions: task.sessions ?? [],
  }))
  const seen = new Set(tasks.map(task => task.taskId))
  const shared = sheets.filter(sheet => WORKING.has(sheet.status) && !seen.has(sheet.taskId)).map(sheet => ({
    key: sheet.taskId, agentId: sheet.leadAgentId, projectId: sheet.personalProjectId, title: sheet.title.trim(), team: true, sessions: [],
  }))
  return [...own, ...shared].slice(0, WORKING_ROWS)
}
