import { describe, expect, it } from 'vitest'
import { boardTaskAccessRevoked, boardTaskPeekId, readBoardTaskPeekId } from './board-task-peek'

describe('board task quick look identity', () => {
  it('keeps the owning project with the task id, whatever characters either holds', () => {
    const task = { projectId: 'project:a/b', id: 'task 1:ü' }
    expect(readBoardTaskPeekId(boardTaskPeekId(task))).toEqual(task)
    expect(boardTaskPeekId({ projectId: 'proj-atlas', id: 't-1' })).toBe('proj-atlas:t-1')
  })

  it('ignores a value that is not exactly one project and one task', () => {
    for (const value of ['t-1', 'a:b:c', ':t-1', 'proj:', '%E0%A4%A:t']) expect(readBoardTaskPeekId(value)).toBeNull()
  })
})

describe('boardTaskAccessRevoked', () => {
  const task = { projectId: 'project-a', id: 't-1' }
  const ready = { template: { permissions: ['board.read'] }, catalogRead: true, projects: [{ id: 'project-a' }], failures: [] }
  const failure = (projectId: string, category: string) => ({ projectId, category, stage: 'board' as const, at: '2026-10-21T00:00:00Z' })

  it('keeps a task open while the catalog is unread, pending or failed for another reason', () => {
    expect(boardTaskAccessRevoked(task, { template: null, catalogRead: false, projects: [], failures: [] })).toBe(false)
    expect(boardTaskAccessRevoked(task, { template: null, catalogRead: false, projects: [], failures: [failure('', 'TimeoutError')] })).toBe(false)
    expect(boardTaskAccessRevoked(task, { ...ready, failures: [failure('project-a', 'HTTP 500')] })).toBe(false)
    expect(boardTaskAccessRevoked(task, ready)).toBe(false)
  })

  it('closes a task on an authoritative answer', () => {
    expect(boardTaskAccessRevoked(task, { ...ready, projects: [{ id: 'project-b' }] })).toBe(true)
    // A catalog read in full that has no Jefa at all.
    expect(boardTaskAccessRevoked(task, { template: null, catalogRead: true, projects: [], failures: [] })).toBe(true)
    expect(boardTaskAccessRevoked(task, { ...ready, template: { permissions: [] } })).toBe(true)
    expect(boardTaskAccessRevoked(task, { ...ready, failures: [failure('project-a', 'HTTP 403')] })).toBe(true)
    expect(boardTaskAccessRevoked(task, { template: null, catalogRead: true, projects: [], failures: [failure('', 'HTTP 401')] })).toBe(true)
    expect(boardTaskAccessRevoked(task, { ...ready, failures: [failure('project-b', 'HTTP 404')] })).toBe(false)
  })
})
