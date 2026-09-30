import { describe, expect, it } from 'vitest'
import { fuzzyMatch, agentProfilePath, collaboratorsFor } from './profile-model'
import type { ProjectAgentTaskRecord } from '@/types'
describe('Agent profile model', () => {
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
