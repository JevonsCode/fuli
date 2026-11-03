import { describe, expect, it } from 'vitest'
import type { ProjectAgentRecord } from '@/types'
import { lacksOccupation, suggestedOccupation } from './occupation-backfill'

// Synthetic FLAs only.
const fla = (responsibility: string, extra: Partial<ProjectAgentRecord> = {}, capabilities: string[] = []) => ({
  agentId: 'agent-x', personalSpaceId: 'space-a', createdAt: '', updatedAt: '',
  profile: { name: 'Synthetic', responsibility, capabilities, initialPreferences: [], status: 'active' },
  ...extra,
}) as unknown as ProjectAgentRecord

describe('occupation backfill', () => {
  it('reads FULI\'s early lead wording as 负责人 before any skill word', () => {
    expect(suggestedOccupation(fla('负责 Synthetic project 的开发、修复、测试与交付，并延续项目上下文。'))).toBe('lead')
    expect(suggestedOccupation(fla('统筹 Synthetic project 的任务拆分、分工、集成与交付'))).toBe('lead')
  })

  it('takes the first occupation its responsibility or capabilities name', () => {
    expect(suggestedOccupation(fla('负责回归测试和验收'))).toBe('testing')
    expect(suggestedOccupation(fla('Builds the console UI'))).toBe('frontend')
    expect(suggestedOccupation(fla('', {}, ['自动化测试']))).toBe('qa_automation')
    expect(suggestedOccupation(fla('实现同步脚本'))).toBe('engineering')
  })

  it('makes no guess from words that name nothing', () => {
    expect(suggestedOccupation(fla('陪伴并记录日常想法'))).toBeNull()
    expect(suggestedOccupation(fla(''))).toBeNull()
  })

  it('offers only the person\'s own active FLAs without a main occupation', () => {
    expect(lacksOccupation(fla('x'))).toBe(true)
    expect(lacksOccupation(fla('x', { occupation: { role: 'design', tags: [] } as never }))).toBe(false)
    expect(lacksOccupation(fla('x', { agentId: 'employee.jefa' }))).toBe(false)
    expect(lacksOccupation({ ...fla('x'), profile: { ...fla('x').profile, status: 'archived' } } as ProjectAgentRecord)).toBe(false)
  })
})
