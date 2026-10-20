import { describe, expect, it } from 'vitest'
import { currentWorkEntry, mergeAgents } from './agent-roster-records'

const row = (projectId: string, extra: Record<string, unknown> = {}) => ({
  agent_id: 'a', personal_project_id: projectId,
  profile: { name: 'Ada', responsibility: '', capabilities: [projectId], status: 'active' },
  assignments: [{ assignment_id: `as-${projectId}`, personal_project_id: projectId, agent_id: 'a', responsibility: '', status: 'active' }],
  ...extra,
})

describe('编排 roster records', () => {
  it('folds one Agent reported per project into one record in the space', () => {
    const [agent, ...rest] = mergeAgents([row('p1'), row('p2', { workStatus: 'blocked' })], 'space-1')
    expect(rest).toEqual([])
    expect(agent!.personalSpaceId).toBe('space-1')
    expect(agent!.assignments!.map(item => item.personalProjectId)).toEqual(['p1', 'p2'])
    expect(agent!.profile.capabilities).toEqual(['p1', 'p2'])
    expect(agent!.workStatus).toBe('blocked')
  })

  it('reports current work from the open task, else a reported wait, else idle', () => {
    const [agent] = mergeAgents([row('p1')], 's')
    expect(currentWorkEntry(agent!)).toMatchObject({ status: 'none', taskId: null })
    expect(currentWorkEntry({ ...agent!, workStatus: 'queued' })).toMatchObject({ status: 'queued', taskId: null })
    const task = { taskId: 't', title: '整理', status: 'running', participants: [], personalProjectId: 'p1' }
    expect(currentWorkEntry({ ...agent!, tasks: [{ ...task, status: 'completed' }, task] as never }))
      .toMatchObject({ status: 'running', taskId: 't', title: '整理' })
  })
})
