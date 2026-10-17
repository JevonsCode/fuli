import { describe, expect, it } from 'vitest'
import type { WorkbenchStatus } from './agent-workbench'
import { groupAgentsByProject } from './directory-project-groups'

const projects: Record<string, string[]> = {
  ada: ['p-2'],
  bo: ['p-1', 'p-2'],
  cy: [],
  di: ['p-9'],
}
const statuses: Record<string, WorkbenchStatus> = { ada: 'running', bo: 'none', cy: 'unreported', di: 'running' }

describe('groupAgentsByProject', () => {
  it('keeps Agent order, lists shared Agents in every formal project and omits unassigned or non-formal projects', () => {
    const groups = groupAgentsByProject(['ada', 'bo', 'cy', 'di'], (id) => projects[id]!, (id) => statuses[id], ['p-1', 'p-2'])
    expect(groups.map((group) => [group.projectId, group.agentIds])).toEqual([
      ['p-1', ['bo']],
      ['p-2', ['ada', 'bo']],
    ])
    expect(groups[1]).toMatchObject({ runningCount: 1, unknownCount: 0 })
  })

  it('counts a missing status as unknown, never as idle', () => {
    const [group] = groupAgentsByProject(['ada'], () => ['p-1'], () => undefined, ['p-1'])
    expect(group).toMatchObject({ runningCount: 0, unknownCount: 1 })
  })

  it('shows only the selected projects for a filtered Agent', () => {
    const groups = groupAgentsByProject(['bo'], (id) => projects[id]!, (id) => statuses[id], ['p-1', 'p-2'], ['p-2'])
    expect(groups.map((group) => group.projectId)).toEqual(['p-2'])
  })

  it('includes formal projects with no loaded members when includeEmpty is enabled', () => {
    const groups = groupAgentsByProject(['ada'], (id) => projects[id]!, (id) => statuses[id], ['p-1', 'p-2'], [], true)
    expect(groups.map((group) => [group.projectId, group.agentIds])).toEqual([
      ['p-1', []],
      ['p-2', ['ada']],
    ])
  })
})
