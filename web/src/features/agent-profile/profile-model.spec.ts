import { afterEach, describe, expect, it } from 'vitest'
import { setLocale } from '@/i18n'
import { fuzzyMatch, agentProfilePath, agentResponsibility, collaboratorsFor, mentionPartner } from './profile-model'
import { isMentionableFla } from './fla-mention'
import type { ProjectAgentRecord, ProjectAgentTaskRecord } from '@/types'
describe('Agent profile model', () => {
  afterEach(() => setLocale('zh-CN', { persist: false }))
  it('shows a built-in Agent default responsibility in the console language, and an edited one as written', () => {
    const jefa = { agentId: 'employee.jefa', profile: { responsibility: '项目经理：拆解目标、维护看板与进展，并为任务选择合适的 Agent。' } }
    setLocale('en-US', { persist: false })
    expect(agentResponsibility(jefa)).toMatch(/^Project manager: breaks goals into tasks/)
    expect(agentResponsibility({ ...jefa, profile: { responsibility: '我自己写的说明' } })).toBe('我自己写的说明')
    expect(agentResponsibility({ agentId: 'custom-agent', profile: { responsibility: jefa.profile.responsibility } })).toBe(jefa.profile.responsibility)
    setLocale('zh-CN', { persist: false })
    expect(agentResponsibility(jefa)).toBe(jefa.profile.responsibility)
  })
  it('encodes each identity segment and keeps spaces separate', () => {
    expect(agentProfilePath('space/a', 'agent ?')).toBe('/agents/space%2Fa/agent%20%3F')
  })
  it('finds partial Chinese, reordered words and a minor Latin name typo', () => {
    expect(fuzzyMatch('Jamie Fox 前端设计 活动页', '设计 前端')).toBe(true)
    expect(fuzzyMatch('Jamie Fox', 'fox jamie')).toBe(true)
    expect(fuzzyMatch('Jamie Fox', 'jmaie')).toBe(true)
    expect(fuzzyMatch('Jamie Fox 前端设计', '数据')).toBe(false)
  })
  it('does not invent completed collaborations from queued task plans', () => {
    const tasks = [
      { taskId:'one', status:'completed', participants:[{agentId:'self', status:'completed'},{agentId:'peer',status:'completed'}] },
      { taskId:'not-started', status:'completed', participants:[{agentId:'self',status:'queued'},{agentId:'unmet',status:'completed'}] },
      { taskId:'two', status:'queued', participants:[{agentId:'self',status:'queued'},{agentId:'planned',status:'queued'}] },
    ] as ProjectAgentTaskRecord[]
    expect(collaboratorsFor('self',tasks)).toEqual([{agentId:'peer',count:1}])
  })
  it('calls only active FLAs by name, never FULI roles or task-only Agents', () => {
    const fla = (agentId: string, profile: Record<string, unknown> = {}) =>
      ({ agentId, profile: { name: 'r', status: 'active', capabilities: [], ...profile } }) as unknown as ProjectAgentRecord
    expect(isMentionableFla(fla('lyra'))).toBe(true)
    for (const agent of [fla('lyra', { status: 'inactive' }), fla('lyra', { agentType: 'temporary' }), fla('lyra', { agentType: 'hr' }),
      fla('employee.jefa'), fla('employee.assistant'), fla('custom', { capabilities: ['FULI.employee:tonborg'] })]) {
      expect(isMentionableFla(agent)).toBe(false)
    }
  })
  it('names a partner FLA from a shared project first, else any other FLA', () => {
    const fla = (agentId: string, displayName: string, project: string, profile: Record<string, unknown> = {}) => ({
      agentId, assignments: [{ personalProjectId: project, status: 'active' }],
      profile: { name: 'r', displayName, status: 'active', capabilities: [], ...profile },
    }) as unknown as ProjectAgentRecord
    const self = fla('self', 'Lyra North', 'alpha')
    const elsewhere = fla('far', 'Milo Reed', 'beta')
    const sameProject = fla('near', 'Nova Lane', 'alpha')
    const role = fla('employee.bole', 'Bole', 'alpha')
    expect(mentionPartner(self, [self, role, elsewhere, sameProject])).toBe('Nova Lane')
    expect(mentionPartner(self, [self, role, elsewhere])).toBe('Milo Reed')
    expect(mentionPartner(self, [self, role])).toBeNull()
  })
})
