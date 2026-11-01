import { describe, expect, it } from 'vitest'
import { currentStepOf, fill, isTeamWork, sharesFor, stepsOf, type TeamSheet } from './team-sheets'

const share = (agentId: string) => ({ agentId, role: null, status: 'running', assignment: null, progress: null })
const sheet = (overrides: Partial<TeamSheet> = {}): TeamSheet => ({
  taskId: 't', personalProjectId: null, title: 'Synthetic', objective: null, status: 'running', leadAgentId: 'lead', updatedAt: null,
  blocker: null, progress: null, unassignedSteps: 0,
  steps: [
    { id: 's1', title: 'Map fields', status: 'completed', agentId: 'a' },
    { id: 's2', title: 'Write script', status: 'in_progress', agentId: 'a' },
    { id: 's3', title: 'Review', status: 'pending', agentId: 'lead' },
  ],
  shares: [share('a'), share('lead'), share('b')],
  ...overrides,
})

describe('team sheets', () => {
  it('counts only open tasks shared by two or more FLAs as team work', () => {
    expect(isTeamWork(sheet())).toBe(true)
    expect(isTeamWork(sheet({ shares: [share('a')] }))).toBe(false)
    expect(isTeamWork(sheet({ status: 'completed' }))).toBe(false)
  })

  it('puts the lead first for everyone else, and the viewer’s own share first otherwise', () => {
    expect(sharesFor(sheet()).map(item => item.agentId)).toEqual(['lead', 'a', 'b'])
    expect(sharesFor(sheet(), 'lead').map(item => item.agentId)).toEqual(['lead', 'a', 'b'])
    expect(sharesFor(sheet(), 'b').map(item => item.agentId)).toEqual(['b', 'a', 'lead'])
  })

  it('gives each share its own steps and the one it is doing now', () => {
    expect(stepsOf(sheet(), 'a').map(step => step.id)).toEqual(['s1', 's2'])
    const shares = sheet().shares
    expect(currentStepOf(sheet(), shares[0]!)?.title).toBe('Write script')
    expect(currentStepOf(sheet(), shares[2]!)).toBeNull()
    // The server's own word wins when it gives one.
    expect(currentStepOf(sheet(), { ...shares[0]!, currentStepId: null })).toBeNull()
    expect(currentStepOf(sheet(), { ...shares[0]!, currentStepId: 's1' })?.title).toBe('Map fields')
  })

  it('fills only from a recorded count', () => {
    expect(fill({ completed: 5, total: 8 })).toBe(0.625)
    expect(fill(null)).toBeNull()
    expect(fill({ completed: 0, total: 0 })).toBeNull()
  })
})
