import { describe, expect, it } from 'vitest'

import {
  orderSuggestions, suggestionAction, suggestionEvidence, suggestionModel, suggestionState, suggestionText, suggestionWhy,
  type RoleSuggestion,
} from './suggestions'

// Synthetic suggestions only, in the shape the suggestion log returns.
const base = (overrides: Partial<RoleSuggestion>): RoleSuggestion => ({
  id: 1, at: '2026-10-23T08:00:00.000Z', role: 'jefa', operation: 'board_match', personalSpaceId: 'space-1', personalProjectId: 'garden',
  subject: {}, status: 'suggested', requestId: 'board_match:r1', evidenceVersion: 'abcdef0123456789',
  gate: { status: 'suggestion_only', role: 'jefa', operation: 'board_match' },
  modelReceipt: { requestedModel: 'qwen-test', actualModel: null }, ...overrides,
})

describe('role suggestions', () => {
  it('maps every result to the state recorded at the time', () => {
    expect(['suggested', 'superseded', 'inline', 'stopped', 'paused', 'failed'].map(status => suggestionState(base({ status }))))
      .toEqual(['suggested', 'superseded', 'fallback', 'stopped', 'stopped', 'stopped'])
    expect(suggestionState(base({ stale: 'newer' }))).toBe('newer')
    // Bole keeps its model's failure as the status; an allowed fallback shows only in the receipt.
    const timeout = (fallbackReason: string | null) => base({ role: 'bole', status: 'failed', reason: 'timeout',
      modelReceipt: { requestedModel: 'qwen-test', actualModel: null, fallbackReason } })
    expect([suggestionState(timeout('timeout')), suggestionState(timeout(null))]).toEqual(['fallback', 'stopped'])
    expect(suggestionState(base({ role: 'bole', status: 'failed', reason: 'server_error',
      modelReceipt: { requestedModel: 'qwen-test', actualModel: null, fallbackReason: 'server_error' } }))).toBe('fallback')
  })

  it('names the model that answered, else the configured one', () => {
    expect(suggestionModel(base({ suggestedBy: { model: 'qwen-test-actual' } }))).toBe('qwen-test-actual')
    expect(suggestionModel(base({}))).toBe('qwen-test')
  })

  it('says what was suggested, and only for a suggestion', () => {
    expect(suggestionText(base({ hint: '可能是看板上的「Seed inventory」任务' }))).toBe('可能是看板上的「Seed inventory」任务')
    expect(suggestionText(base({ role: 'bole', suggestion: { action: 'coach' } }))).toBe('针对弱项给出反馈')
    expect(suggestionText(base({ status: 'superseded', reason: 'task_changed', hint: 'stale' }))).toBe('')
  })

  it('says why in plain words, with the code for an unknown reason', () => {
    expect(suggestionWhy(base({ status: 'superseded', reason: 'corrected_by_user' }))).toBe('你已经给这段对话定了归属。')
    expect(suggestionWhy(base({ status: 'paused', reason: 'window_tokens' }))).toBe('这个周期的 tokens 用完了。')
    expect(suggestionWhy(base({ status: 'inline', reason: 'server_error' }))).toBe('模型服务出错。')
    expect(suggestionWhy(base({ status: 'failed', reason: 'brand_new_code' }))).toBe('原因：brand_new_code')
    expect(suggestionWhy(base({}))).toBe('')
  })

  it('lists the readable evidence, with the version kept for a title', () => {
    expect(suggestionEvidence(base({ role: 'bole', suggestion: { evidenceIds: ['completion', 'firstPass'] } })))
      .toEqual({ dimensions: ['完成', '一次通过'], title: 'abcdef0123456789\nboard_match:r1' })
    expect(suggestionEvidence(base({})).dimensions).toEqual([])
  })

  it('orders what waits for the person first, each newest first', () => {
    const entries = [base({ id: 1, status: 'superseded', at: '2026-10-23T10:00:00.000Z' }), base({ id: 2, at: '2026-10-23T08:00:00.000Z' }),
      base({ id: 3, at: '2026-10-23T09:00:00.000Z' }), base({ id: 4, status: 'paused', at: '2026-10-23T11:00:00.000Z' })]
    expect(orderSuggestions(entries).map(entry => entry.id)).toEqual([3, 2, 4, 1])
    expect(orderSuggestions([base({ id: 5, stale: 'newer', at: '2026-10-23T12:00:00.000Z' }), ...entries]).map(entry => entry.id))
      .toEqual([3, 2, 5, 4, 1])
  })

  it('opens only the person\'s own pages, and nothing for a stop or a fallback', () => {
    expect(suggestionAction(base({ suggestion: { taskId: 'task 1' } }))).toEqual({ kind: 'link', label: '查看看板任务',
      to: { path: '/employees/jefa', query: { item: 'space-1/garden%3Atask%25201' } } })
    expect(suggestionAction(base({ role: 'assistant', personalProjectId: null, subject: { conversationId: 'conv-1' } })))
      .toEqual({ kind: 'link', label: '查看会话归类', to: { path: '/employees/assistant', query: { conversation: 'conv-1' } } })
    expect(suggestionAction(base({ role: 'bole', subject: { agentId: 'engineer-x' } }))).toEqual({ kind: 'score_card', label: '查看评分卡' })
    // Superseded: the conversation, or the project's board since no task is named any more.
    expect(suggestionAction(base({ role: 'assistant', status: 'superseded', subject: { conversationId: 'conv-1' } }))?.label).toBe('查看会话归类')
    expect(suggestionAction(base({ status: 'superseded' })))
      .toEqual({ kind: 'link', label: '查看看板任务', to: { path: '/employees/jefa', query: { project: 'garden' } } })
    expect(suggestionAction(base({ role: 'bole', status: 'superseded', subject: { agentId: 'engineer-x' } }))).toBeNull()
    for (const status of ['inline', 'stopped', 'paused', 'failed']) {
      expect(suggestionAction(base({ status, suggestion: { taskId: 'task-1' } }))).toBeNull()
    }
  })
})
