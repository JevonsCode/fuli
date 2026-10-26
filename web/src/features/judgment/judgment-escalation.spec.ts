import { beforeEach, describe, expect, it } from 'vitest'

import { setLocale } from '@/i18n'

import { escalationReason } from './judgment-escalation'
import type { JudgmentAiReview, JudgmentDecisionRecord } from './judgment-types'

const autonomous = { mode: 'autonomous', quality: 'quality', client: 'claude_code' } as const
const gate = (reason: string | null): JudgmentAiReview['gate'] => ({ status: reason ? 'not_passed' : 'passed', reason, modelId: null })

// The owner's record (2026-10-27): 自主处理 · 质量优先 · Claude Code, 尚未执行.
function record(overrides: Partial<JudgmentDecisionRecord> = {}): JudgmentDecisionRecord {
  return {
    id: 'adb', createdAt: '2026-10-27T08:00:00.000Z', personalProjectId: null, kind: 'review', target: 'entity:adb',
    title: 'Install a debug APK over adb on a phone', summary: 'Device-specific step.', outcome: 'escalate', confidence: 0.5,
    evidence: ['Single session, confidence_score 0.5, no negative evidence'], policy: autonomous,
    execution: { status: 'not_applied' }, feedback: { revision: 0, vote: null, reason: '' }, feedbackHistory: [], executionHistory: [],
    ...overrides,
  }
}
const review = (interceptions: string[], extra: Partial<JudgmentAiReview> = {}): JudgmentAiReview =>
  ({ state: 'ai_suggested', modelOutcome: 'approve', interceptions, gate: gate('session_answer'), ...extra })

describe('escalationReason', () => {
  beforeEach(() => setLocale('zh-CN', { persist: false }))

  it('says Tonborg was unsure, with its confidence, for the owner\'s autonomous record before and after 0.20', () => {
    // Before 0.20.0 a record kept no aiReview: the host escalated an approval below 0.85.
    expect(escalationReason(record())).toBe('Tonborg 把握不足（0.5），交给你确认')
    expect(escalationReason(record({ aiReview: review(['below_confidence', 'gate_not_passed']) }))).toBe('Tonborg 把握不足（0.5），交给你确认')
  })

  it('names the reason that kept a sure approval from applying itself', () => {
    const sure = { confidence: 0.95 }
    expect(escalationReason(record({ ...sure, aiReview: review(['gate_not_passed']) }))).toMatch(/^这次由会话代 Tonborg 判断/)
    expect(escalationReason(record({ ...sure, aiReview: review(['gate_not_passed'], { gate: gate('capture_off') }) }))).toMatch(/暂停了记录/)
    expect(escalationReason(record({ ...sure, aiReview: review(['gate_not_passed'], { gate: gate('egress_not_approved') }) }))).toMatch(/模型这次不能自动执行/)
    // The trust warning has its own line on the card.
    expect(escalationReason(record({ ...sure, aiReview: review(['gate_not_passed'], { gate: gate('warning_not_seen') }) }))).toBe('')
    expect(escalationReason(record({ ...sure, aiReview: review(['injection_suspected', 'gate_not_passed']) }))).toMatch(/指挥审核者/)
    expect(escalationReason(record({ ...sure, aiReview: review(['needs_attention']) }))).toMatch(/冲突/)
    expect(escalationReason(record({ ...sure, aiReview: review([], { modelOutcome: 'escalate' }) }))).toMatch(/不能直接通过/)
    expect(escalationReason(record({ kind: 'routing', confidence: undefined, disposition: 'ask_user' }))).toMatch(/该由你决定/)
  })

  it('says nothing when the person chose 我来确认 or nothing waits', () => {
    expect(escalationReason(record({ policy: { ...autonomous, mode: 'manual' } }))).toBe('')
    expect(escalationReason(record({ outcome: 'approve', confidence: 0.95 }))).toBe('')
    expect(escalationReason(record({ execution: { status: 'stale' } }))).toBe('')
  })
})
