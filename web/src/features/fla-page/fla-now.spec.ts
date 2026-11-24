import { describe, expect, it } from 'vitest'
import type { AgentWorkbenchEntry } from '@/features/agent-profile/agent-workbench'
import type { TeamSheet } from '@/features/team-work/team-sheets'
import type { ProjectAgentTaskRecord } from '@/types'
import { finishedWork, nowLine, STALE_AFTER_MS } from './fla-now'

// Synthetic tasks only.
const entry = (status: AgentWorkbenchEntry['status'], extra: Partial<AgentWorkbenchEntry> = {}): AgentWorkbenchEntry => ({
  status, source: 'roster', taskId: null, title: null, lastUpdateAt: null, reason: null, runningSince: null, ...extra,
})
const task = (taskId: string, status: string, extra: Partial<ProjectAgentTaskRecord> = {}) =>
  ({ taskId, title: `Synthetic ${taskId}`, status, participants: [], ...extra }) as ProjectAgentTaskRecord
const NOW = Date.parse('2026-11-24T09:05:00Z')
const minutesBefore = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString()
const sheet = (taskId: string, progress: TeamSheet['progress'], currentStepId: string | null): TeamSheet => ({
  taskId, personalProjectId: 'p-1', title: `Synthetic ${taskId}`, objective: null, status: 'running', leadAgentId: 'fla-1', updatedAt: null,
  blocker: null, progress, unassignedSteps: 0,
  steps: [{ id: 's1', title: 'Read the brief', status: 'completed', agentId: 'fla-1' }, { id: 's2', title: 'Check the locale branch', status: 'in_progress', agentId: 'fla-1' }],
  shares: [{ agentId: 'fla-1', role: 'lead', status: 'running', assignment: null, progress, currentStepId }],
})

describe('现在', () => {
  it('names the running task, its recorded step and count, the clients it runs in and since when', () => {
    const line = nowLine({
      entry: entry('running', { taskId: 't-1', title: 'Synthetic t-1', runningSince: '2026-11-24T08:00:00Z', lastUpdateAt: '2026-11-24T09:00:00Z' }),
      agentId: 'fla-1', sheets: [sheet('t-1', { completed: 1, total: 2 }, 's2')], now: NOW,
      tasks: [task('t-1', 'running', { sessions: [{ client: 'codex', sessionId: 'session-a' }] })],
    })
    expect(line).toEqual({ kind: 'working', status: 'running', taskId: 't-1', title: 'Synthetic t-1', step: 'Check the locale branch',
      progress: { completed: 1, total: 2 }, sessions: [{ client: 'codex', sessionId: 'session-a' }], since: { at: '2026-11-24T08:00:00Z', started: true },
      lastProgress: { state: 'fresh', at: '2026-11-24T09:00:00Z' } })
  })

  it('shows no bar and no step without a recorded plan, and the last change when no start was stamped', () => {
    const line = nowLine({ entry: entry('running', { taskId: 't-1', title: 'Synthetic t-1', lastUpdateAt: '2026-11-24T09:00:00Z' }),
      agentId: 'fla-1', sheets: [], tasks: [], now: NOW })
    expect(line).toMatchObject({ kind: 'working', step: null, progress: null, since: { at: '2026-11-24T09:00:00Z', started: false } })
  })

  it('says nothing is on its hands and points at the last finished task when it is idle', () => {
    const tasks = [task('old', 'completed', { completedAt: '2026-11-01T00:00:00Z' }), task('new', 'failed', { completedAt: '2026-11-20T00:00:00Z', failureReason: 'Synthetic reason' }), task('open', 'queued')]
    expect(nowLine({ entry: entry('none'), agentId: 'fla-1', sheets: [], tasks, now: NOW })).toEqual({ kind: 'idle',
      last: { taskId: 'new', title: 'Synthetic new', at: '2026-11-20T00:00:00Z', failed: true, result: 'Synthetic reason', projectId: null } })
    expect(nowLine({ entry: entry('none'), agentId: 'fla-1', sheets: [], tasks: [], now: NOW })).toEqual({ kind: 'idle', last: null })
  })

  it('never reads an unreported or unreadable status as idle', () => {
    expect(nowLine({ entry: entry('unreported'), agentId: 'fla-1', sheets: [], tasks: [task('done', 'completed')], now: NOW }).kind).toBe('unknown')
    expect(nowLine({ entry: entry('unavailable'), agentId: 'fla-1', sheets: [], tasks: [], now: NOW }).kind).toBe('unknown')
  })

  it('keeps a task that waits on the person apart from running work', () => {
    expect(nowLine({ entry: entry('awaiting_review', { taskId: 't-2', title: 'Synthetic t-2' }), agentId: 'fla-1', sheets: [], tasks: [], now: NOW }))
      .toEqual({ kind: 'waiting', status: 'awaiting_review', taskId: 't-2', title: 'Synthetic t-2' })
  })
})

describe('现在 · whether running work is still going on', () => {
  // Started three days ago in every case: only the last recorded change decides.
  const running = (lastUpdateAt: string | null) => nowLine({
    entry: entry('running', { taskId: 't-1', title: 'Synthetic t-1', runningSince: minutesBefore(3 * 24 * 60), lastUpdateAt }),
    agentId: 'fla-1', sheets: [], tasks: [], now: NOW })

  it('is going on when it changed 5 minutes ago', () => {
    expect(running(minutesBefore(5))).toMatchObject({ lastProgress: { state: 'fresh', at: minutesBefore(5) } })
  })

  it('is no longer said to be going on after 2 hours or 3 days without a change', () => {
    expect(running(minutesBefore(120))).toMatchObject({ lastProgress: { state: 'stale', at: minutesBefore(120) } })
    expect(running(minutesBefore(3 * 24 * 60))).toMatchObject({ lastProgress: { state: 'stale' } })
  })

  it('says no change was recorded when there is no time, instead of guessing', () => {
    expect(running(null)).toMatchObject({ lastProgress: { state: 'unrecorded' } })
  })

  it('draws the line at a named threshold of 30 minutes', () => {
    expect(STALE_AFTER_MS).toBe(30 * 60_000)
    expect(running(minutesBefore(30))).toMatchObject({ lastProgress: { state: 'fresh' } })
    expect(running(minutesBefore(31))).toMatchObject({ lastProgress: { state: 'stale' } })
  })

  it('leaves queued work as it is', () => {
    const line = nowLine({ entry: entry('queued', { taskId: 't-1', lastUpdateAt: minutesBefore(3 * 24 * 60) }), agentId: 'fla-1', sheets: [], tasks: [], now: NOW })
    expect(line).toMatchObject({ kind: 'working', status: 'queued', lastProgress: null })
  })
})

describe('现在 · what else waits on the person', () => {
  it('counts the other tasks waiting for a call or stuck, behind the running one', () => {
    const line = nowLine({ entry: entry('running', { taskId: 't-1', lastUpdateAt: minutesBefore(5) }), agentId: 'fla-1', sheets: [], now: NOW,
      tasks: [task('t-1', 'running'), task('t-2', 'awaiting_review'), task('t-3', 'awaiting_review'), task('t-4', 'blocked'), task('t-5', 'queued')] })
    expect(line.others).toEqual({ review: 2, blocked: 1, taskId: 't-2' })
  })

  it('does not count the task 现在 already names, and says nothing when nothing else waits', () => {
    const waiting = nowLine({ entry: entry('awaiting_review', { taskId: 't-2' }), agentId: 'fla-1', sheets: [], now: NOW,
      tasks: [task('t-2', 'awaiting_review'), task('t-5', 'queued')] })
    expect(waiting.others).toBeUndefined()
    const blockedOnly = nowLine({ entry: entry('none'), agentId: 'fla-1', sheets: [], now: NOW, tasks: [task('t-4', 'blocked')] })
    expect(blockedOnly.others).toEqual({ review: 0, blocked: 1, taskId: 't-4' })
  })
})

describe('最近做完', () => {
  it('lists finished work newest first with its recorded result, and leaves open or cancelled tasks out', () => {
    const work = finishedWork([
      task('a', 'completed', { completedAt: '2026-11-02T00:00:00Z', resultSummary: ' Synthetic result ' }),
      task('b', 'cancelled'), task('c', 'running'),
      task('d', 'completed', { updatedAt: '2026-11-05T00:00:00Z' }),
    ])
    expect(work.map(item => [item.taskId, item.result])).toEqual([['d', null], ['a', 'Synthetic result']])
  })
})
