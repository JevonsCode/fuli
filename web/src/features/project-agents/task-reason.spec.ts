import { afterEach, describe, expect, it } from 'vitest'
import { setLocale } from '@/i18n'
import { taskReason } from './task-reason'

afterEach(() => setLocale('zh-CN', { persist: false }))

describe('a recorded task reason reads as a sentence, never as a code', () => {
  it('reads a staffing decision by its code and its executor selection', () => {
    const raw = 'project_team_lead: project team lead is the stable conversation owner and fits this work; exact work kind; executor: no usable executor'
    expect(taskReason(raw)).toEqual({ text: '由项目组长负责；没有可用的执行客户端', unknownCode: null, raw })
    expect(taskReason('explicit_agent: explicit Agent selected; executor: no usable executor')?.text).toBe('交给你指定的 Agent；没有可用的执行客户端')
    expect(taskReason('no_match: no exact assignment match')?.text).toBe('没有找到合适的 Agent')
    expect(taskReason('project_team_gap')?.text).toBe('小组里没有合适的成员，需要招聘')
    setLocale('en-US', { persist: false })
    expect(taskReason('explicit_agent: explicit Agent selected; executor: locked allow-list unavailable')?.text)
      .toBe('Assigned to the Agent you named; none of the allowed executor clients is available')
  })

  it('reads worker and recruitment codes, keeping the stored text for 原始信息', () => {
    expect(taskReason('worker_session_stopped. Actual model use is unverified.'))
      .toEqual({ text: '执行这个任务的会话已经停止。', unknownCode: null, raw: 'worker_session_stopped. Actual model use is unverified.' })
    expect(taskReason('worker_prompt_failed. Actual model use is unverified.')?.text).toBe('执行客户端在运行过程中出错。')
    expect(taskReason('recruitment cancelled: the person chose another Agent'))
      .toEqual({ text: '招聘已取消，任务在等待重新安排', unknownCode: null, raw: 'recruitment cancelled: the person chose another Agent' })
    expect(taskReason('AR recruitment approved: fits the gap')?.text).toBe('招聘已批准')
  })

  it('says an unknown code has no description yet and names the code, instead of showing its English detail', () => {
    expect(taskReason('quota_exhausted: the synthetic provider ran out of quota'))
      .toEqual({ text: '记录了一个还没有说明的原因', unknownCode: 'quota_exhausted', raw: 'quota_exhausted: the synthetic provider ran out of quota' })
    expect(taskReason('worker_brand_new_case. detail')).toMatchObject({ text: '记录了一个还没有说明的原因', unknownCode: 'worker_brand_new_case' })
  })

  it('keeps an Agent\'s own words as written and reports nothing when nothing was recorded', () => {
    expect(taskReason('Which staging database should the migration target?'))
      .toEqual({ text: 'Which staging database should the migration target?', unknownCode: null, raw: null })
    expect(taskReason('Note: waiting for the API region')?.unknownCode).toBeNull()
    expect(taskReason('  ')).toBeNull()
    expect(taskReason(null)).toBeNull()
  })
})
