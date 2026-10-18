import { describe, expect, it } from 'vitest'
import type { AgentAttention } from '@/features/project-agents/attention-store'
import type { ProjectAgentTaskRecord } from '@/types'
import { focusItem, laneOf, timelineHours, workLanes } from './workbench-model'

const NOW = Date.parse('2026-10-18T12:00:00Z')
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000).toISOString()
const task = (taskId: string, status: ProjectAgentTaskRecord['status'], hoursAgo: number, extra: Partial<ProjectAgentTaskRecord> = {}) =>
  ({ taskId, title: taskId, status, participants: [], updatedAt: at(hoursAgo), ...extra }) as ProjectAgentTaskRecord
const question = (requestId: string, hoursAgo: number, status: AgentAttention['status'] = 'open') =>
  ({ requestId, personalSpaceId: 's', personalProjectId: 'p', agentId: 'a', taskId: null, kind: 'decision', title: requestId,
    detail: '', requestedAction: '', revision: 1, status, createdAt: at(hoursAgo) }) as AgentAttention

describe('workbench model', () => {
  it('sorts work into lanes, newest first, keeping only the last day of finished work', () => {
    const lanes = workLanes([
      task('run-old', 'running', 5), task('run-new', 'running', 1), task('queued', 'queued', 2),
      task('blocked', 'blocked', 3), task('failed', 'failed', 4), task('review', 'awaiting_review', 1),
      task('done-today', 'completed', 2, { completedAt: at(2) }), task('done-old', 'completed', 30, { completedAt: at(30) }),
      task('cancelled', 'cancelled', 1),
    ], NOW)
    expect(lanes.running.map(item => item.taskId)).toEqual(['run-new', 'queued', 'run-old'])
    expect(lanes.stuck.map(item => item.taskId)).toEqual(['blocked', 'failed'])
    expect(lanes.waiting.map(item => item.taskId)).toEqual(['review'])
    expect(lanes.done.map(item => item.taskId)).toEqual(['done-today'])
    expect(laneOf(task('x', 'cancelled', 0))).toBeNull()
  })

  it('focuses on the oldest open question, then the longest-stuck task, then review', () => {
    const tasks = [task('stuck-new', 'blocked', 1), task('stuck-old', 'blocked', 9), task('review', 'awaiting_review', 2)]
    expect(focusItem([question('new', 1), question('old', 6), question('closed', 9, 'resolved')], tasks))
      .toMatchObject({ kind: 'question', attention: { requestId: 'old' } })
    expect(focusItem([], tasks)).toMatchObject({ kind: 'stuck', task: { taskId: 'stuck-old' } })
    expect(focusItem([], [task('review', 'awaiting_review', 2)])).toMatchObject({ kind: 'review' })
    expect(focusItem([], [task('run', 'running', 1)])).toBeNull()
  })

  it('groups the last day by hour, newest hour first', () => {
    const hours = timelineHours([task('a', 'running', 0.2), task('b', 'completed', 0.4), task('c', 'blocked', 3), task('old', 'running', 30)], NOW, 'en-US')
    expect(hours.map(hour => hour.tasks.map(item => item.taskId))).toEqual([['a', 'b'], ['c']])
  })
})
