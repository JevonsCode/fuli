import { describe, expect, it } from 'vitest'
import type { ProjectAgentTaskRecord } from '@/types'
import { flaProgress, recentlyDone, taskFlas, taskKey, taskLog } from './workbench-model'

const task = (patch: Partial<ProjectAgentTaskRecord>): ProjectAgentTaskRecord =>
  ({ taskId: 't-1', personalProjectId: 'p-1', title: 'T', status: 'running', participants: [], ...patch }) as ProjectAgentTaskRecord

describe('workbench model', () => {
  it('keys a task by project and id', () => {
    expect(taskKey(task({}))).toBe('p-1:t-1')
  })

  it('counts each FLA once and only finished assignments as done', () => {
    const work = task({ participants: [
      { agentId: 'a', role: 'lead', status: 'completed' },
      { agentId: 'b', role: 'collaborator', status: 'running' },
      { agentId: 'a', role: 'collaborator', status: 'running' },
      { agentId: 'c', role: 'collaborator', status: 'blocked' },
    ] })
    expect(taskFlas(work).map(fla => fla.agentId)).toEqual(['a', 'b', 'c'])
    expect(flaProgress(work)).toEqual({ done: 1, total: 3 })
  })

  it('falls back to the lead when a task records no participants, and to nothing without one', () => {
    expect(taskFlas(task({ leadAgentId: 'lead' })).map(fla => fla.agentId)).toEqual(['lead'])
    expect(flaProgress(task({}))).toEqual({ done: 0, total: 0 })
  })

  it('lists the recorded events newest first and drops empty ones', () => {
    const log = taskLog(task({ events: [
      { eventId: 'e1', taskId: 't-1', status: 'queued', summary: 'queued', createdAt: '2026-11-01T10:00:00Z' },
      { eventId: 'e2', taskId: 't-1', status: 'running', summary: ' ', createdAt: '2026-11-01T11:00:00Z' },
      { eventId: 'e3', taskId: 't-1', status: 'running', summary: 'started', createdAt: '2026-11-01T12:00:00Z' },
    ] as never }))
    expect(log.map(event => event.eventId)).toEqual(['e3', 'e1'])
  })

  it('keeps only finished work, latest completion first', () => {
    const done = recentlyDone([
      task({ taskId: 'old', status: 'completed', completedAt: '2026-10-01T00:00:00Z' }),
      task({ taskId: 'live', status: 'running' }),
      task({ taskId: 'new', status: 'completed', completedAt: '2026-10-30T00:00:00Z' }),
    ])
    expect(done.map(item => item.taskId)).toEqual(['new', 'old'])
  })
})
