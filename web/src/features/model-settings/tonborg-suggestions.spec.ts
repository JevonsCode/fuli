import { afterEach, describe, expect, it } from 'vitest'

import { setLocale } from '@/i18n'
import { logSuggestionView, orderSuggestions, type RoleSuggestion } from './suggestions'
import { tonborgSuggestionView, type TonborgSuggestion } from './tonborg-suggestions'

// Synthetic verdicts only, in the shape GET /api/judgment/suggestions returns.
const gate = (reason: string | null) => ({ status: 'not_passed' as const, reason, modelId: 'qwen-test' })
const base = (overrides: Partial<TonborgSuggestion> = {}): TonborgSuggestion => ({
  id: 'judgment-1', createdAt: '2026-10-24T08:00:00.000Z', personalSpaceId: 'space 1', personalProjectId: 'garden',
  target: 'entity:seed rule', title: 'Seed rule', summary: 'Two sessions state it.', confidence: 0.7,
  aiReview: { state: 'ai_suggested', modelOutcome: 'approve', interceptions: ['gate_not_passed'], gate: gate('suggestions_only') },
  model: 'qwen-test', client: null, judgedBy: { mode: 'model_api', independent: true }, ...overrides,
})
const view = (overrides: Partial<TonborgSuggestion> = {}) => tonborgSuggestionView(base(overrides))
const review = (modelOutcome: 'approve' | 'escalate', interceptions: string[], reason: string | null = null) =>
  ({ state: 'ai_suggested' as const, modelOutcome, interceptions, gate: gate(reason) })

afterEach(() => setLocale('zh-CN', { persist: false }))

describe('Tonborg suggestions', () => {
  it('names the item, the model\'s conclusion and reason, and who answered', () => {
    expect(view()).toMatchObject({ key: 'tonborg:judgment-1', role: 'tonborg', state: 'suggested', at: '2026-10-24T08:00:00.000Z',
      text: 'Seed rule · 模型认为可以通过审核', reason: 'Two sessions state it.', model: 'qwen-test', why: '',
      evidence: { dimensions: [], title: 'judgment-1' } })
    expect(view({ aiReview: review('escalate', []) })).toMatchObject({ text: 'Seed rule · 模型请你看一下', heldBy: '' })
    expect(view({ model: null, client: 'claude_code', judgedBy: { mode: 'current_session', independent: false } }).model).toBe('当前会话')
    expect(view({ stale: 'newer' }).state).toBe('newer')
  })

  it('says why the host left it to the person, in plain words', () => {
    expect(view({ aiReview: review('approve', ['needs_attention', 'below_confidence', 'gate_not_passed'], 'session_answer') }).heldBy)
      .toBe('条目有冲突或负面反馈 · 模型把握不足 · 由当前会话回答')
    expect(view({ aiReview: review('approve', ['manual_policy', 'gate_not_passed'], 'warning_not_seen') }).heldBy)
      .toBe('审核策略是手动 · 还没看过自动执行的提示')
    expect(view({ aiReview: review('approve', ['gate_not_passed', 'brand_new'], 'brand_new_gate') }).heldBy).toBe('只给建议 · 原因：brand_new')
    setLocale('en-US', { persist: false })
    expect(view().heldBy).toBe('You chose "Suggestions only"')
    expect(view().text).toBe('Seed rule · The model finds it can pass review')
  })

  it('opens the knowledge item in 知识整理, and nothing for a permanently deleted one', () => {
    expect(view().action).toEqual({ kind: 'link', label: '查看知识条目',
      to: { path: '/organize', query: { item: 'space%201/entity%3Aseed%20rule' } } })
    expect(view({ hard_deleted: true, title: null, summary: null })).toMatchObject({ text: '内容已因彻底删除清除', reason: '', action: null })
  })

  it('takes its place among the other roles\' records by state and time', () => {
    const log = (id: number, at: string, status = 'suggested'): RoleSuggestion => ({ id, at, role: 'jefa', operation: 'board_match',
      personalSpaceId: 'space 1', personalProjectId: 'garden', subject: {}, status, requestId: `r${id}`, evidenceVersion: 'v',
      gate: { status: 'suggestion_only', role: 'jefa', operation: 'board_match' }, modelReceipt: { requestedModel: 'qwen-test', actualModel: null } })
    const ordered = orderSuggestions([log(1, '2026-10-24T09:00:00.000Z'), log(2, '2026-10-24T10:00:00.000Z', 'paused')].map(logSuggestionView)
      .concat([view(), view({ id: 'judgment-0', createdAt: '2026-10-24T11:00:00.000Z', stale: 'newer' })]))
    expect(ordered.map(entry => entry.key)).toEqual(['log:1', 'tonborg:judgment-1', 'tonborg:judgment-0', 'log:2'])
  })
})
