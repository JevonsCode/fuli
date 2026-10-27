import { afterEach, describe, expect, it } from 'vitest'
import { setLocale } from '@/i18n'
import { fuzzyMatch, agentProfilePath, agentResponsibility, collaboratorsFor } from './profile-model'
import type { ProjectAgentTaskRecord } from '@/types'
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
})
