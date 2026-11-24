import type { AgentWorkbenchEntry } from '@/features/agent-profile/agent-workbench'
import { currentStepOf, type TeamProgress, type TeamSheet } from '@/features/team-work/team-sheets'
import { progressOf, type Progress } from '@/features/team-work/work-freshness'
import type { ProjectAgentTaskRecord, ProjectAgentTaskSession } from '@/types'

// 现在 on an FLA's page (docs/fla-page.md): what it is doing, in one line.
// Only recorded facts: the status the server reports, the step and count of a
// recorded plan, the clients the task runs in, a recorded time. A gap is said
// to be a gap — 没有上报状态 is never shown as 空闲, and there is no bar
// without a plan.
export interface FinishedWork { taskId: string; title: string; at: string | null; failed: boolean; result: string | null; projectId: string | null }

/** Other tasks of this FLA that wait on the person, besides the one 现在 names. */
export interface Waiting { review: number; blocked: number; taskId: string | null }

export type NowLine = (
  | { kind: 'loading' }
  | { kind: 'working'; status: 'running' | 'queued' | 'awaiting_recruitment'; taskId: string | null; title: string | null
      step: string | null; progress: TeamProgress | null; sessions: ProjectAgentTaskSession[]
      /** A recorded start (running) or, failing that, the last recorded change. */
      since: { at: string; started: boolean } | null
      /** Running only: how recent its last recorded change is. */
      lastProgress: Progress | null }
  | { kind: 'waiting'; status: 'awaiting_review' | 'blocked' | 'paused'; taskId: string | null; title: string | null }
  | { kind: 'idle'; last: FinishedWork | null }
  | { kind: 'unknown' }
  | { kind: 'ended' }
) & { others?: Waiting }

const FINISHED = new Set(['completed', 'failed'])

/** The newest finished task: completed or failed, by when it finished. */
export function lastFinished(tasks: readonly ProjectAgentTaskRecord[]): FinishedWork | null {
  return finishedWork(tasks)[0] ?? null
}

/** Finished tasks, newest first (最近做完). */
export function finishedWork(tasks: readonly ProjectAgentTaskRecord[]): FinishedWork[] {
  return tasks.filter(task => FINISHED.has(task.status))
    .map(task => ({ taskId: task.taskId, title: task.title, at: task.completedAt ?? task.updatedAt ?? null, failed: task.status === 'failed',
      result: (task.status === 'failed' ? task.failureReason : task.resultSummary)?.trim() || null, projectId: task.personalProjectId ?? null }))
    .sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))
}

/**
 * The FLA's tasks that wait on the person (等你拍板, 被卡住) other than the one
 * `shown`: the Provider ranks running first, so a review would otherwise hide
 * behind the work 现在 names. Null when there are none.
 */
export function waitingBesides(tasks: readonly ProjectAgentTaskRecord[], shown: string | null): Waiting | null {
  const others = tasks.filter(task => task.taskId !== shown)
  const review = others.filter(task => task.status === 'awaiting_review')
  const blocked = others.filter(task => task.status === 'blocked')
  if (!review.length && !blocked.length) return null
  return { review: review.length, blocked: blocked.length, taskId: (review[0] ?? blocked[0])!.taskId }
}

export function nowLine(input: {
  entry: AgentWorkbenchEntry
  agentId: string
  sheets: readonly TeamSheet[]
  tasks: readonly ProjectAgentTaskRecord[]
  /** The clock 现在 reads freshness against. */
  now: number
}): NowLine {
  const line = lineFor(input)
  if (line.kind === 'loading' || line.kind === 'ended') return line
  const others = waitingBesides(input.tasks, input.entry.taskId)
  return others ? { ...line, others } : line
}

function lineFor(input: Parameters<typeof nowLine>[0]): NowLine {
  const { entry } = input
  switch (entry.status) {
    case 'loading': return { kind: 'loading' }
    case 'ended': return { kind: 'ended' }
    case 'unreported': case 'unavailable': return { kind: 'unknown' }
    case 'none': return { kind: 'idle', last: lastFinished(input.tasks) }
    case 'awaiting_review': case 'blocked': case 'paused':
      return { kind: 'waiting', status: entry.status, taskId: entry.taskId, title: entry.title }
    default: {
      const sheet = input.sheets.find(item => item.taskId === entry.taskId)
      const share = sheet?.shares.find(item => item.agentId === input.agentId)
      const task = input.tasks.find(item => item.taskId === entry.taskId)
      const since = entry.runningSince ? { at: entry.runningSince, started: true }
        : entry.lastUpdateAt ? { at: entry.lastUpdateAt, started: false } : null
      return {
        kind: 'working', status: entry.status, taskId: entry.taskId, title: entry.title ?? sheet?.title ?? null,
        step: sheet && share ? currentStepOf(sheet, share)?.title ?? null : null,
        progress: share?.progress ?? sheet?.progress ?? null,
        sessions: task?.sessions ?? [],
        since,
        lastProgress: entry.status === 'running' ? progressOf(entry.lastUpdateAt, input.now) : null,
      }
    }
  }
}
