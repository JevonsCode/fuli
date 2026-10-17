import { describe, expect, it } from 'vitest'
import type { AgentWorkbenchEntry } from './agent-workbench'
import { workbenchStatusDetail } from './workbench-status-text'

const entry = (status: AgentWorkbenchEntry['status'], patch: Partial<AgentWorkbenchEntry> = {}): AgentWorkbenchEntry => ({
  status, source: 'roster', taskId: 'task-1', title: null, lastUpdateAt: null, reason: null, ...patch,
})

describe('workbenchStatusDetail', () => {
  it('says what a waiting Agent waits for, from the recorded reason', () => {
    expect(workbenchStatusDetail(entry('blocked', { reason: '需要人提供测试账号' }))).toBe('受阻：需要人提供测试账号')
    expect(workbenchStatusDetail(entry('awaiting_review', { reason: '登录页改版' }))).toBe('等待验收：登录页改版')
  })

  it('says a reason is missing instead of inventing one', () => {
    expect(workbenchStatusDetail(entry('blocked'))).toContain('没有记录原因')
    expect(workbenchStatusDetail(entry('awaiting_review'))).toContain('没有记录')
  })

  it('names the missing part of an incomplete status and stays quiet for clear states', () => {
    expect(workbenchStatusDetail(entry('unreported'))).toContain('名录没有报告')
    expect(workbenchStatusDetail(entry('unreported', { source: 'tasks' }))).toContain('200')
    expect(workbenchStatusDetail(entry('unavailable'))).toContain('读取失败')
    expect(workbenchStatusDetail(entry('running'))).toBeNull()
    expect(workbenchStatusDetail(entry('none'))).toBeNull()
    expect(workbenchStatusDetail(undefined)).toBeNull()
  })
})
