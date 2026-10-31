import { describe, expect, it } from 'vitest'
import { shareFill, sharesFor, type TaskSheet } from './task-sheets'

const share = (agentId: string) => ({ agentId, role: null, status: 'running', assignment: null, progress: null })
const sheet = (leadAgentId: string): TaskSheet => ({
  taskId: 't', personalProjectId: null, title: 'Synthetic task', objective: null, status: 'running', leadAgentId, role: null,
  updatedAt: null, blocker: null, progress: null, steps: [], unassignedSteps: 0, shares: [share('lead'), share('a'), share('b')],
})

describe('task sheets', () => {
  it('shows the lead the whole sheet in its order and puts anyone else’s own share first', () => {
    expect(sharesFor(sheet('lead'), 'lead').map(item => item.agentId)).toEqual(['lead', 'a', 'b'])
    expect(sharesFor(sheet('lead'), 'b').map(item => item.agentId)).toEqual(['b', 'lead', 'a'])
  })

  it('fills a bar only from a recorded count, never from a guess', () => {
    expect(shareFill({ completed: 1, total: 4 })).toBe(0.25)
    expect(shareFill(null)).toBeNull()
    expect(shareFill({ completed: 0, total: 0 })).toBeNull()
  })
})
