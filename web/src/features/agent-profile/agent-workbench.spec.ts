import { describe, expect, it } from 'vitest'
import type { ProjectAgentRecord } from '@/types'
import { agentWorkbenchEntry, compareWorkbenchRows, indexWorkbenchTasks } from './agent-workbench'
import type { AgentWorkbenchEntry } from './agent-workbench'

const agent = (patch: Partial<ProjectAgentRecord> = {}) => ({
  agentId: 'agent-a', personalSpaceId: 'space-a', createdAt: '', updatedAt: '',
  profile: { name: 'Aster', responsibility: 'Synthetic role', capabilities: [], initialPreferences: [], status: 'active' },
  ...patch,
}) as ProjectAgentRecord

const tasks = indexWorkbenchTasks([{
  taskId: 'task-1', personalSpaceId: 'space-a', title: 'Synthetic running task', status: 'running',
  createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-17T01:00:00Z',
  participants: [{ agentId: 'agent-a', role: 'lead', status: 'running', updatedAt: '2026-10-17T02:00:00Z' }],
}], 'space-a')

describe('agentWorkbenchEntry', () => {
  it('prefers the complete roster projection over the bounded task page', () => {
    const entry = agentWorkbenchEntry(agent({ workStatus: 'idle' }), {
      summary: { status: 'running', taskId: 'task-1', title: 'Synthetic running task' },
      summaryState: 'ready', tasks,
    })
    expect(entry).toMatchObject({ status: 'none', source: 'roster', taskId: null, title: null })
  })

  it('shows the roster task with its recorded update time, never its creation time', () => {
    const entry = agentWorkbenchEntry(agent({ workStatus: 'running', currentTaskId: 'task-1' }), { tasks })
    expect(entry).toEqual({
      status: 'running', source: 'roster', taskId: 'task-1',
      title: 'Synthetic running task', lastUpdateAt: '2026-10-17T02:00:00Z', reason: null, blocker: null, runningSince: null,
    })
  })

  it('carries the recorded reason only for a waiting state', () => {
    const page = indexWorkbenchTasks([{
      taskId: 'task-2', personalSpaceId: 'space-a', title: 'Synthetic blocked task', status: 'blocked',
      resultSummary: '  Needs the staging token from a person.  ', updatedAt: '2026-10-17T01:00:00Z', participants: [],
    }], 'space-a')
    expect(agentWorkbenchEntry(agent({ workStatus: 'blocked', currentTaskId: 'task-2' }), { tasks: page }).reason)
      .toBe('Needs the staging token from a person.')
    expect(agentWorkbenchEntry(agent({ workStatus: 'running', currentTaskId: 'task-2' }), { tasks: page }).reason).toBeNull()
  })

  it('takes the run start only from the recorded roster value for a running Agent', () => {
    const stamped = agentWorkbenchEntry(agent({
      workStatus: 'running', currentTaskId: 'task-1', currentTaskRunningSince: '2026-10-17T00:30:00Z',
    }), { tasks })
    expect(stamped.runningSince).toBe('2026-10-17T00:30:00Z')
    const blocked = agentWorkbenchEntry(agent({
      workStatus: 'blocked', currentTaskId: 'task-1', currentTaskRunningSince: '2026-10-17T00:30:00Z',
    }), { tasks })
    expect(blocked.runningSince).toBeNull()
  })

  it('keeps a task outside the bounded page untitled instead of inventing one', () => {
    const entry = agentWorkbenchEntry(agent({ workStatus: 'blocked', currentTaskId: 'task-old' }), { tasks })
    expect(entry).toMatchObject({ status: 'blocked', taskId: 'task-old', title: null, lastUpdateAt: null })
  })

  it.each([
    [{ summaryState: 'incomplete' as const }, 'unreported'],
    [{ summaryState: 'error' as const }, 'unavailable'],
    [{ summaryState: 'loading' as const }, 'loading'],
  ])('does not call an unknown legacy state idle', (input, status) => {
    expect(agentWorkbenchEntry(agent(), input).status).toBe(status)
  })

  it('reports an unrecognised roster state as incomplete', () => {
    expect(agentWorkbenchEntry(agent({ workStatus: 'failed' }), {}).status).toBe('unreported')
    expect(agentWorkbenchEntry(agent({ workStatus: 'ended' }), {}).status).toBe('ended')
  })
})

describe('compareWorkbenchRows', () => {
  const row = (name: string, status: AgentWorkbenchEntry['status'], lastUpdateAt: string | null = null) => ({
    name, entry: { status, source: 'roster' as const, taskId: null, title: null, lastUpdateAt, reason: null, runningSince: null },
  })
  it('puts active work first, unknown before idle, then the most recent update, then name', () => {
    const rows = [
      row('Idle', 'none'),
      row('Unknown', 'unreported'),
      row('Queued', 'queued'),
      row('Old run', 'running', '2026-10-17T01:00:00Z'),
      row('No time run', 'running'),
      row('New run', 'running', '2026-10-17T03:00:00Z'),
    ]
    expect(rows.sort(compareWorkbenchRows).map((item) => item.name)).toEqual([
      'New run', 'Old run', 'No time run', 'Queued', 'Unknown', 'Idle',
    ])
  })
})
