import { describe, expect, it } from 'vitest'

import {
  suggestionAction, suggestionEvidence, suggestionModel, suggestionState, suggestionText, suggestionWhy, type RoleSuggestion,
} from './suggestions'

// Synthetic suggestions only, in the shape the suggestion log returns.
const base = (overrides: Partial<RoleSuggestion>): RoleSuggestion => ({
  id: 1, at: '2026-10-23T08:00:00.000Z', role: 'jefa', operation: 'board_match', personalSpaceId: 'space-1', personalProjectId: 'garden',
  subject: {}, status: 'suggested', requestId: 'board_match:r1', evidenceVersion: 'abcdef0123456789',
  gate: { status: 'suggestion_only', role: 'jefa', operation: 'board_match' },
  modelReceipt: { requestedModel: 'qwen-test', actualModel: null }, ...overrides,
})

describe('role suggestions', () => {
  it('maps every result to one of four states', () => {
    expect(['suggested', 'superseded', 'inline', 'stopped', 'paused', 'failed'].map(status => suggestionState(base({ status }))))
      .toEqual(['suggested', 'superseded', 'fallback', 'stopped', 'stopped', 'stopped'])
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

  it('lists the evidence it rests on, with the full version kept for a title', () => {
    expect(suggestionEvidence(base({ role: 'bole', suggestion: { evidenceIds: ['completion', 'firstPass'] } })))
      .toEqual({ dimensions: ['完成', '一次通过'], version: 'abcdef01', title: 'abcdef0123456789\nboard_match:r1' })
  })

  it('acts only through the person\'s own pages, and only on a suggestion', () => {
    expect(suggestionAction(base({ suggestion: { taskId: 'task 1' } }))).toEqual({ kind: 'link', label: '打开任务',
      to: { path: '/employees/jefa', query: { item: 'space-1/garden%3Atask%25201' } } })
    expect(suggestionAction(base({ role: 'assistant', personalProjectId: null, subject: { conversationId: 'conv-1' } })))
      .toEqual({ kind: 'link', label: '去确认', to: { path: '/employees/assistant', query: { conversation: 'conv-1' } } })
    expect(suggestionAction(base({ role: 'bole', subject: { agentId: 'engineer-x' } }))).toEqual({ kind: 'score_card', label: '打开评分卡' })
    for (const status of ['superseded', 'inline', 'stopped']) {
      expect(suggestionAction(base({ status, suggestion: { taskId: 'task-1' } }))).toBeNull()
    }
  })
})
