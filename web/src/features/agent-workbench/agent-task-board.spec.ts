import { describe, expect, it } from 'vitest'

import type { ProjectAgentTaskRecord, ProjectAgentTaskStatus } from '@/types'
import { agentTaskBoards, isBoardTask } from './agent-task-board'

const task = (taskId: string, status: ProjectAgentTaskStatus, personalProjectId: string | null = 'project-b'): ProjectAgentTaskRecord =>
  ({ taskId, title: `Synthetic ${taskId}`, status, personalProjectId, participants: [], objective: `Objective of ${taskId}` })

describe('agentTaskBoards', () => {
  it('puts each task status in its built-in column and leaves cancelled tasks off', () => {
    const statuses: ProjectAgentTaskStatus[] = ['awaiting_recruitment', 'backlog', 'queued', 'running', 'paused', 'failed', 'blocked',
      'awaiting_review', 'completed', 'cancelled']
    const [board] = agentTaskBoards(statuses.map((status) => task(status, status)), (id) => id)
    expect(board!.items.map(({ id, status }) => [id, status])).toEqual([
      ['awaiting_recruitment', 'planned'], ['backlog', 'planned'], ['queued', 'planned'], ['running', 'active'], ['paused', 'active'],
      ['failed', 'blocked'], ['blocked', 'blocked'], ['awaiting_review', 'review'], ['completed', 'done'],
    ])
    expect(board!.total).toBe(9)
    expect(isBoardTask({ status: 'cancelled' })).toBe(false)
  })

  it('groups tasks by project, named and ordered by project name, keeping each project\'s task order', () => {
    const names: Record<string, string> = { 'project-a': 'Zeta', 'project-b': 'Alpha', '': 'No project' }
    const boards = agentTaskBoards([task('one', 'running', 'project-a'), task('two', 'queued'), task('three', 'completed', 'project-a'),
      task('four', 'running', null)], (id) => names[id]!)
    expect(boards.map(({ project, items }) => [project.name, items.map(({ id }) => id)])).toEqual([
      ['Alpha', ['two']], ['No project', ['four']], ['Zeta', ['one', 'three']],
    ])
    expect(boards[0]!.items[0]).toMatchObject({ projectId: 'project-b', title: 'Synthetic two', summary: 'Objective of two' })
  })
})
