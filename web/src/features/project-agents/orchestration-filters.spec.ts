import { describe, expect, it } from 'vitest'
import type { ProjectAgentRecord } from '@/types'
import {
  agentManagementPath,
  compareOrchestrationAgents,
  orchestrationFilterQuery,
  projectChipGroups,
  readOrchestrationFilters,
} from './orchestration-filters'

const agent = (agentId: string, name: string, status: ProjectAgentRecord['profile']['status']) => ({
  agentId, personalSpaceId: 's', profile: { name, responsibility: '', capabilities: [], initialPreferences: [], status },
  createdAt: '', updatedAt: '',
}) as ProjectAgentRecord

describe('编排 filters in the URL', () => {
  it('reads every project when none is named, none when the value is empty, and known statuses only', () => {
    expect(readOrchestrationFilters({})).toEqual({ projects: null, status: 'all', search: '' })
    expect(readOrchestrationFilters({ project: '' })).toEqual({ projects: [], status: 'all', search: '' })
    expect(readOrchestrationFilters({ project: ['a', 'b', 'a'], status: 'inactive', q: '复盘' }))
      .toEqual({ projects: ['a', 'b'], status: 'inactive', search: '复盘' })
    expect(readOrchestrationFilters({ status: 'sleeping' }).status).toBe('all')
  })

  it('writes only what differs from the defaults and keeps unrelated keys', () => {
    expect(orchestrationFilterQuery({ item: 's/a', status: 'active' }, { projects: null, status: 'all', search: '' }))
      .toEqual({ item: 's/a' })
    expect(orchestrationFilterQuery({}, { projects: [], status: 'archived', search: 'x' }))
      .toEqual({ project: '', status: 'archived', q: 'x' })
    const query = orchestrationFilterQuery({}, { projects: ['a', 'b'], status: 'all', search: '' })
    expect(readOrchestrationFilters(query as never).projects).toEqual(['a', 'b'])
  })
})

describe('编排 collection order and labels', () => {
  it('puts available Agents first, then orders by name and id', () => {
    const sorted = [agent('3', 'Bea', 'archived'), agent('2', 'Ann', 'active'), agent('1', 'Ann', 'active'), agent('4', 'Cy', 'inactive')]
      .sort((a, b) => compareOrchestrationAgents(a, b, 'en-US'))
    expect(sorted.map(item => item.agentId)).toEqual(['1', '2', '4', '3'])
  })

  it('counts same-named projects once', () => {
    expect(projectChipGroups([{ name: '会话' }, { name: '会话' }, { name: 'Atlas' }]))
      .toEqual([{ name: '会话', count: 2 }, { name: 'Atlas', count: 1 }])
  })

  it('builds an Agent page path with both parts encoded', () => {
    expect(agentManagementPath('space 1', 'employee/a')).toBe('/project-agents/manage/space%201/employee%2Fa')
  })
})
