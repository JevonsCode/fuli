import { describe, expect, it } from 'vitest'

import { logSuggestionView, orderSuggestions, type RoleSuggestion } from './suggestions'

// Synthetic suggestions only, in the shape the suggestion log returns.
const base = (overrides: Partial<RoleSuggestion>): RoleSuggestion => ({
  id: 1, at: '2026-10-23T08:00:00.000Z', role: 'jefa', operation: 'board_match', personalSpaceId: 'space-1', personalProjectId: 'garden',
  subject: {}, status: 'suggested', requestId: 'board_match:r1', evidenceVersion: 'abcdef0123456789',
  gate: { status: 'suggestion_only', role: 'jefa', operation: 'board_match' },
  modelReceipt: { requestedModel: 'qwen-test', actualModel: null }, ...overrides,
})
const view = (overrides: Partial<RoleSuggestion>) => logSuggestionView(base(overrides))

describe('role suggestions', () => {
  it('maps every result to the state recorded at the time', () => {
    expect(['suggested', 'superseded', 'inline', 'stopped', 'paused', 'failed'].map(status => view({ status }).state))
      .toEqual(['suggested', 'superseded', 'fallback', 'stopped', 'stopped', 'stopped'])
    expect(view({ stale: 'newer' }).state).toBe('newer')
    // Bole keeps its model's failure as the status; an allowed fallback shows only in the receipt.
    const timeout = (fallbackReason: string | null) => view({ role: 'bole', status: 'failed', reason: 'timeout',
      modelReceipt: { requestedModel: 'qwen-test', actualModel: null, fallbackReason } })
    expect([timeout('timeout').state, timeout(null).state]).toEqual(['fallback', 'stopped'])
    expect(view({ role: 'bole', status: 'failed', reason: 'server_error',
      modelReceipt: { requestedModel: 'qwen-test', actualModel: null, fallbackReason: 'server_error' } }).state).toBe('fallback')
  })

  it('names the model that answered, else the configured one', () => {
    expect(view({ suggestedBy: { model: 'qwen-test-actual' } }).model).toBe('qwen-test-actual')
    expect(view({}).model).toBe('qwen-test')
  })

  it('says what was suggested and the model\'s reason, and only for a suggestion', () => {
    expect(view({ hint: '可能是看板上的「Seed inventory」任务' }).text).toBe('可能是看板上的「Seed inventory」任务')
    expect(view({ role: 'bole', subject: { agentId: 'engineer-x' }, suggestion: { action: 'coach', reason: 'Completion is low.' } }))
      .toMatchObject({ text: '针对弱项给出反馈', reason: 'Completion is low.', bole: { subject: { agentId: 'engineer-x' } } })
    expect(view({ status: 'superseded', reason: 'task_changed', hint: 'stale' }).text).toBe('')
    expect(view({ hard_deleted: true, suggestion: { taskId: 'task-seeds', reason: 'gone' } })).toMatchObject({ text: '内容已因彻底删除清除', reason: '' })
    expect(view({}).bole).toBeUndefined()
  })

  it('says why in plain words, with the code for an unknown reason', () => {
    expect(view({ status: 'superseded', reason: 'corrected_by_user' }).why).toBe('你已经给这段对话定了归属。')
    expect(view({ status: 'paused', reason: 'window_tokens' }).why).toBe('这个周期的 tokens 用完了。')
    expect(view({ status: 'inline', reason: 'server_error' }).why).toBe('模型服务出错。')
    expect(view({ status: 'failed', reason: 'brand_new_code' }).why).toBe('原因：brand_new_code')
    expect(view({}).why).toBe('')
  })

  it('lists the readable evidence, with the version kept for a title', () => {
    expect(view({ role: 'bole', suggestion: { evidenceIds: ['completion', 'firstPass'] } }).evidence)
      .toEqual({ dimensions: ['完成', '一次通过'], title: 'abcdef0123456789\nboard_match:r1' })
    expect(view({}).evidence.dimensions).toEqual([])
  })

  it('orders what waits for the person first, each newest first', () => {
    const entries = [base({ id: 1, status: 'superseded', at: '2026-10-23T10:00:00.000Z' }), base({ id: 2, at: '2026-10-23T08:00:00.000Z' }),
      base({ id: 3, at: '2026-10-23T09:00:00.000Z' }), base({ id: 4, status: 'paused', at: '2026-10-23T11:00:00.000Z' })]
    const order = (list: RoleSuggestion[]) => orderSuggestions(list.map(logSuggestionView)).map(entry => entry.seq)
    expect(order(entries)).toEqual([3, 2, 4, 1])
    expect(order([base({ id: 5, stale: 'newer', at: '2026-10-23T12:00:00.000Z' }), ...entries])).toEqual([3, 2, 5, 4, 1])
    // The same time: the later record first.
    expect(order([base({ id: 6 }), base({ id: 7 })])).toEqual([7, 6])
  })

  it('opens only the person\'s own pages, and nothing for a stop or a fallback', () => {
    expect(view({ suggestion: { taskId: 'task 1' } }).action).toEqual({ kind: 'link', label: '查看看板任务',
      to: { path: '/employees/jefa', query: { item: 'space-1/garden%3Atask%25201' } } })
    expect(view({ role: 'assistant', personalProjectId: null, subject: { conversationId: 'conv-1' } }).action)
      .toEqual({ kind: 'link', label: '查看会话归类', to: { path: '/employees/assistant', query: { conversation: 'conv-1' } } })
    expect(view({ role: 'bole', subject: { agentId: 'engineer-x' } }).action).toEqual({ kind: 'score_card', label: '查看评分卡' })
    // Superseded: the conversation, or the project's board since no task is named any more.
    expect(view({ role: 'assistant', status: 'superseded', subject: { conversationId: 'conv-1' } }).action?.label).toBe('查看会话归类')
    expect(view({ status: 'superseded' }).action)
      .toEqual({ kind: 'link', label: '查看看板', to: { path: '/employees/jefa', query: { project: 'garden' } } })
    expect(view({ role: 'bole', status: 'superseded', subject: { agentId: 'engineer-x' } }).action).toBeNull()
    for (const status of ['inline', 'stopped', 'paused', 'failed']) {
      expect(view({ status, suggestion: { taskId: 'task-1' } }).action).toBeNull()
    }
  })
})
