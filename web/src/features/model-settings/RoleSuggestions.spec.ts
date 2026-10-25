import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ getJson: vi.fn(), postJson: vi.fn(), putJson: vi.fn(), patchJson: vi.fn(), deleteJson: vi.fn() }))
vi.mock('@/api/client', async (importOriginal) => ({ ...await importOriginal<typeof import('@/api/client')>(), ...api }))

import { ApiError } from '@/api/client'
import RoleSuggestions from './RoleSuggestions.vue'
import sectionSource from './RoleSuggestions.vue?raw'
import modelSource from './suggestions.ts?raw'
import readSource from './useRoleSuggestions.ts?raw'
import tonborgSource from './tonborg-suggestions.ts?raw'
import type { TonborgSuggestion } from './tonborg-suggestions'
import type { RoleSuggestion } from './suggestions'

// Synthetic suggestions only, one per role and state; no real model, Agent or board.
const receipt = (role: string, operation: string) => ({ requestId: `${operation}:r-${role}`, evidenceVersion: role.padEnd(64, '0'),
  promptVersion: `${operation}:p`, gate: { status: 'suggestion_only', role, operation },
  modelReceipt: { requestedModel: 'qwen-test', actualModel: 'qwen-test-actual' } })
const SUGGESTIONS = [
  { id: 1, at: '2026-10-23T08:00:00.000Z', role: 'jefa', operation: 'board_match', personalSpaceId: 'space-1', personalProjectId: 'garden',
    subject: {}, status: 'paused', reason: 'window_tokens', ...receipt('jefa', 'board_match') },
  { id: 2, at: '2026-10-23T08:10:00.000Z', role: 'assistant', operation: 'project_candidate', personalSpaceId: 'space-1', personalProjectId: null,
    subject: { conversationId: 'conv-1' }, status: 'superseded', reason: 'corrected_by_user', ...receipt('assistant', 'project_candidate') },
  { id: 3, at: '2026-10-23T08:30:00.000Z', role: 'jefa', operation: 'board_match', personalSpaceId: 'space-1', personalProjectId: 'garden',
    subject: {}, status: 'suggested', hint: '可能是看板上的「Seed inventory」任务', suggestion: { taskId: 'task-seeds', title: 'Seed inventory' },
    suggestedBy: { model: 'qwen-test-actual' }, ...receipt('jefa', 'board_match') },
  { id: 4, at: '2026-10-23T07:00:00.000Z', role: 'bole', operation: 'performance_review', personalSpaceId: 'space-1', personalProjectId: 'garden',
    subject: { agentId: 'engineer-x' }, status: 'suggested', suggestion: { action: 'coach', reason: 'Completion is low.', evidenceIds: ['completion'] },
    suggestedBy: { model: 'qwen-test-actual' }, ...receipt('bole', 'performance_review') },
  { id: 5, at: '2026-10-23T08:20:00.000Z', role: 'assistant', operation: 'project_candidate', personalSpaceId: 'space-1', personalProjectId: null,
    subject: { conversationId: 'conv-2' }, status: 'suggested', hint: '可能属于「Garden」，需你确认', suggestion: { name: 'Garden', reason: 'Watering.' },
    suggestedBy: { model: 'qwen-test-actual' }, ...receipt('assistant', 'project_candidate') },
  { id: 8, at: '2026-10-23T06:30:00.000Z', role: 'jefa', operation: 'board_match', personalSpaceId: 'space-1', personalProjectId: 'garden',
    subject: { conversationId: 'conv-3' }, status: 'suggested', stale: 'newer', hint: '可能是看板上的「Old task」任务',
    suggestion: { taskId: 'task-old', title: 'Old task' }, suggestedBy: { model: 'qwen-test-actual' }, ...receipt('jefa', 'board_match') },
  // Bole's model timed out, as the producer records it: status failed, the allowed fallback only in the receipt.
  { id: 6, at: '2026-10-23T06:00:00.000Z', role: 'bole', operation: 'performance_review', personalSpaceId: 'space-1', personalProjectId: 'garden',
    subject: { agentId: 'engineer-x' }, status: 'failed', reason: 'timeout', ...receipt('bole', 'performance_review'),
    modelReceipt: { requestedModel: 'qwen-test', actualModel: null, fallbackReason: 'timeout' } },
  { id: 7, at: '2026-10-23T05:00:00.000Z', role: 'bole', operation: 'performance_review', personalSpaceId: 'space-1', personalProjectId: 'garden',
    subject: { agentId: 'engineer-x' }, status: 'failed', reason: 'timeout', ...receipt('bole', 'performance_review'),
    modelReceipt: { requestedModel: 'qwen-test', actualModel: null, fallbackReason: null } },
] as RoleSuggestion[]
// Tonborg's knowledge reviews it left to the person, newest first as the route lists them.
const verdict = (modelOutcome: 'approve' | 'escalate', interceptions: string[], reason: string | null) =>
  ({ state: 'ai_suggested' as const, modelOutcome, interceptions, gate: { status: 'not_passed' as const, reason, modelId: 'qwen-test-actual' } })
const REVIEWS: TonborgSuggestion[] = [
  { id: 'judgment-3', createdAt: '2026-10-23T09:00:00.000Z', personalSpaceId: 'space-1', personalProjectId: 'garden', target: 'entity:seed-rule',
    title: 'Seed rule', summary: 'Stated twice by the person.', confidence: 0.6, aiReview: verdict('approve', ['below_confidence', 'gate_not_passed'], 'suggestions_only'),
    model: 'qwen-test-actual', client: null, judgedBy: { mode: 'model_api', independent: true } },
  { id: 'judgment-2', createdAt: '2026-10-23T06:45:00.000Z', personalSpaceId: 'space-1', personalProjectId: null, target: 'entity:watering',
    title: 'Watering rule', summary: 'Only said for today.', confidence: 0.9, aiReview: verdict('escalate', [], 'session_answer'),
    model: null, client: 'claude_code', judgedBy: { mode: 'current_session', independent: false } },
  { id: 'judgment-1', createdAt: '2026-10-23T05:30:00.000Z', personalSpaceId: 'space-1', personalProjectId: 'garden', target: 'entity:seed-rule',
    title: 'Seed rule', summary: 'Earlier look.', confidence: 0.5, aiReview: verdict('approve', ['gate_not_passed'], 'not_configured'),
    model: 'qwen-test-actual', client: null, judgedBy: { mode: 'model_api', independent: true }, stale: 'newer' },
]
const SCORE_CARD = { dimensions: {
  completion: { status: 'scored', sample: 8, passed: 2, rate: 0.25 }, firstPass: { status: 'insufficient_data', sample: 1, label: '数据不足' } } }

beforeEach(() => {
  for (const spy of Object.values(api)) spy.mockReset()
  api.getJson.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/project-agents/engineer-x/score-card')) return SCORE_CARD
    if (url.startsWith('/api/project-agents/engineer-x')) return { agentId: 'engineer-x', personalSpaceId: 'space-1', profile: { name: 'Engineer X' } }
    throw new Error(`unexpected read ${url}`)
  })
})

const mountSection = async (props: { entries: RoleSuggestion[] | null; loading?: boolean; error?: string
  reviews?: TonborgSuggestion[] | null; reviewsLoading?: boolean; reviewsError?: string }) => {
  const wrapper = mount(RoleSuggestions, { attachTo: document.body, props: { loading: false, error: '', ...props },
    global: { stubs: { RouterLink: { props: ['to'], template: '<a :href="JSON.stringify(to)"><slot /></a>' } } } })
  await flushPromises()
  return wrapper
}
const href = (element: { attributes: (name: string) => string | undefined }) => JSON.parse(element.attributes('href')!)

describe('RoleSuggestions', () => {
  it('lists records, suggestions first as cards, and says why in one line for the rest', async () => {
    const wrapper = await mountSection({ entries: SUGGESTIONS })
    expect(wrapper.get('h2').text()).toBe('建议记录')
    expect(wrapper.get('[data-role-suggestions-note]').text()).toContain('不是待办')
    expect(wrapper.findAll('article[data-role-suggestion]').map(card => [card.attributes('data-role-suggestion'), card.get('[data-suggestion-status]').text()]))
      .toEqual([['jefa', '当时建议'], ['assistant', '当时建议'], ['bole', '当时建议'], ['jefa', '已有更新']])
    expect(wrapper.findAll('li.role-suggestion-line').map(line => [line.attributes('data-role-suggestion'), line.get('[data-suggestion-status]').text()]))
      .toEqual([['assistant', '当时已作废'], ['jefa', '已停止'], ['bole', '已交回会话'], ['bole', '已停止']])
    expect(wrapper.text()).not.toContain('仅建议')
    expect(wrapper.text()).toContain('生成于')

    const bole = wrapper.get('article[data-role-suggestion="bole"]')
    expect(bole.get('[data-suggestion-text]').text()).toBe('Engineer X · 针对弱项给出反馈')
    expect(bole.get('[data-suggestion-evidence]').text()).toBe('依据完成')
    expect(bole.get('time').attributes('datetime')).toBe('2026-10-23T07:00:00.000Z')
    // No hash on screen: the evidence version stays in a title.
    const jefa = wrapper.get('article[data-role-suggestion="jefa"]')
    expect(jefa.find('[data-suggestion-evidence]').exists()).toBe(false)
    expect(jefa.text()).not.toContain('jefa000')
    expect(jefa.get('dd[title]').attributes('title')).toContain('board_match:r-jefa')
    expect(href(jefa.get('[data-suggestion-action]'))).toEqual({ path: '/employees/jefa', query: { item: 'space-1/garden%3Atask-seeds' } })
    const astro = wrapper.get('article[data-role-suggestion="assistant"]')
    expect(astro.get('[data-suggestion-action]').text()).toBe('查看会话归类')
    expect(jefa.get('[data-suggestion-action]').text()).toBe('查看看板任务')
    expect(href(astro.get('[data-suggestion-action]'))).toEqual({ path: '/employees/assistant', query: { conversation: 'conv-2' } })

    const [superseded, stopped, fallback] = wrapper.findAll('li.role-suggestion-line')
    expect(fallback!.get('[data-suggestion-why]').text()).toBe('模型超时。')
    expect(superseded.get('[data-suggestion-why]').text()).toBe('你已经给这段对话定了归属。')
    expect(href(superseded.get('[data-suggestion-action]'))).toEqual({ path: '/employees/assistant', query: { conversation: 'conv-1' } })
    expect(stopped.get('[data-suggestion-why]').text()).toBe('这个周期的 tokens 用完了。')
    expect(stopped.find('[data-suggestion-action]').exists()).toBe(false)
  })

  it('shows the newest 8 and the rest behind 显示全部', async () => {
    const many = Array.from({ length: 11 }, (_, index) => ({ ...SUGGESTIONS[0]!, id: 100 + index,
      at: `2026-10-22T${String(10 + index).padStart(2, '0')}:00:00.000Z` }))
    const wrapper = await mountSection({ entries: [...many, SUGGESTIONS[2]!] })
    expect(wrapper.findAll('[data-role-suggestion]')).toHaveLength(8)
    expect(wrapper.get('article[data-role-suggestion]').attributes('data-suggestion-state')).toBe('suggested')
    expect(wrapper.findAll('time')[1]!.attributes('datetime')).toBe('2026-10-22T20:00:00.000Z')
    await wrapper.get('[data-suggestions-show-all]').trigger('click')
    expect(wrapper.findAll('[data-role-suggestion]')).toHaveLength(12)
    expect(wrapper.find('[data-suggestions-show-all]').exists()).toBe(false)
  })

  it('opens Bole\'s score card read-only and lifts that card', async () => {
    const wrapper = await mountSection({ entries: SUGGESTIONS })
    const bole = () => wrapper.get('article[data-role-suggestion="bole"]')
    await bole().get('[data-suggestion-action]').trigger('click')
    await flushPromises()
    expect(bole().classes()).toContain('shadow-md')
    expect(bole().get('[data-suggestion-score-card]').text()).toContain('25% · 2/8')
    expect(bole().get('[data-suggestion-score-card]').text()).toContain('数据不足')
    expect(api.getJson).toHaveBeenCalledWith('/api/project-agents/engineer-x/score-card?personalSpaceId=space-1&personalProjectId=garden',
      expect.anything())
  })

  it('shows a record a permanent delete cleared without any of its words', async () => {
    const cleared = { ...SUGGESTIONS[2]!, hint: undefined, suggestion: { taskId: 'task-seeds' }, hard_deleted: true as const }
    const wrapper = await mountSection({ entries: [cleared] })
    const card = wrapper.get('article[data-role-suggestion="jefa"]')
    expect(card.get('[data-suggestion-text]').text()).toBe('内容已因彻底删除清除')
    expect(card.text()).not.toContain('Seed inventory')
    expect(card.find('.role-suggestion-reason').exists()).toBe(false)
  })

  it('keeps the evidence version only as the model\'s tooltip, not on the whole line', async () => {
    const wrapper = await mountSection({ entries: SUGGESTIONS })
    const line = wrapper.get('li.role-suggestion-line')
    expect(line.attributes('title')).toBeUndefined()
    expect(line.get('code').attributes('title')).toContain('project_candidate:r-assistant')
  })

  it('says the score card cannot be opened right now when its read fails, never what it would hold', async () => {
    api.getJson.mockImplementation(async (url: string) => {
      if (url.includes('/score-card')) throw new Error('HTTP 403')
      return { agentId: 'engineer-x', personalSpaceId: 'space-1', profile: { name: 'Engineer X' } }
    })
    const wrapper = await mountSection({ entries: SUGGESTIONS })
    const action = wrapper.get('article[data-role-suggestion="bole"] [data-suggestion-action]')
    expect(action.text()).toBe('查看评分卡')
    await action.trigger('click')
    await flushPromises()
    expect(wrapper.get('article[data-role-suggestion="bole"] [role="alert"]').text()).toContain('暂时无法打开评分卡。')
  })

  it('shows no title while waiting, and nothing at all without suggestions', async () => {
    const waiting = await mountSection({ entries: null, loading: true })
    expect(waiting.find('h2').exists()).toBe(false)
    expect(waiting.get('[role="status"]').attributes('aria-label')).toBe('正在读取 Astro、Bole 和 Jefa 的建议…')
    const empty = await mountSection({ entries: [] })
    expect(empty.html()).toBe('<!--v-if-->')
  })

  it('lists Tonborg\'s knowledge reviews among the others, with why each was left to the person and the item to open', async () => {
    const wrapper = await mountSection({ entries: SUGGESTIONS, reviews: REVIEWS })
    expect(wrapper.findAll('article[data-role-suggestion]').map(card => [card.attributes('data-role-suggestion'), card.get('[data-suggestion-status]').text()]))
      .toEqual([['tonborg', '当时建议'], ['jefa', '当时建议'], ['assistant', '当时建议'], ['bole', '当时建议'], ['tonborg', '当时建议'],
        ['jefa', '已有更新'], ['tonborg', '已有更新']])
    const [newest, sessionAnswer, older] = wrapper.findAll('article[data-role-suggestion="tonborg"]')
    expect(newest!.get('strong').text()).toBe('Tonborg')
    expect(newest!.get('[data-suggestion-text]').text()).toBe('Seed rule · 模型认为可以通过审核')
    expect(newest!.get('.role-suggestion-reason').text()).toBe('Stated twice by the person.')
    expect(newest!.get('[data-suggestion-held]').text()).toBe('留给你模型把握不足 · 你选了「只给建议」')
    expect(newest!.get('code').text()).toBe('qwen-test-actual')
    expect(newest!.get('dd[title]').attributes('title')).toBe('judgment-3')
    expect(newest!.get('[data-suggestion-action]').text()).toBe('查看知识条目')
    expect(href(newest!.get('[data-suggestion-action]'))).toEqual({ path: '/organize', query: { item: 'space-1/entity%3Aseed-rule' } })
    expect(sessionAnswer!.get('[data-suggestion-text]').text()).toBe('Watering rule · 模型请你看一下')
    expect(sessionAnswer!.find('[data-suggestion-held]').exists()).toBe(false)
    expect(sessionAnswer!.get('code').text()).toBe('当前会话')
    expect(older!.attributes('data-suggestion-state')).toBe('newer')
    expect(wrapper.get('[data-role-suggestions-note]').text()).toContain('Tonborg')
  })

  it('shows Tonborg\'s suggestions alone, and a permanently deleted item without its words or a link', async () => {
    const cleared = { ...REVIEWS[0]!, title: null, summary: null, hard_deleted: true as const }
    const wrapper = await mountSection({ entries: [], reviews: [cleared] })
    const card = wrapper.get('article[data-role-suggestion="tonborg"]')
    expect(card.get('[data-suggestion-text]').text()).toBe('内容已因彻底删除清除')
    expect(card.find('.role-suggestion-reason').exists()).toBe(false)
    expect(card.find('[data-suggestion-action]').exists()).toBe(false)
  })

  it('names each pending read, and says which read failed while the other is shown', async () => {
    const both = await mountSection({ entries: null, loading: true, reviews: null, reviewsLoading: true })
    expect(both.get('[role="status"]').attributes('aria-label')).toBe('正在读取 Astro、Bole、Jefa 和 Tonborg 的建议…')
    const tonborg = await mountSection({ entries: [], reviews: null, reviewsLoading: true })
    expect(tonborg.get('[role="status"]').attributes('aria-label')).toBe('正在读取 Tonborg 的知识审核建议…')
    expect(tonborg.find('h2').exists()).toBe(false)
    // A refresh keeps the shown section and names the read in its header.
    const refresh = await mountSection({ entries: SUGGESTIONS, reviews: REVIEWS, reviewsLoading: true })
    expect(refresh.findAll('[role="status"]').map(status => status.attributes('aria-label'))).toEqual(['正在读取 Tonborg 的知识审核建议…'])

    const failed = await mountSection({ entries: SUGGESTIONS, reviews: null, reviewsError: 'HTTP 503' })
    expect(failed.get('[data-role-suggestions] [role="alert"]').text()).toContain('Tonborg 的知识审核建议没有读取成功。 HTTP 503')
    await failed.get('[data-role-suggestions] [role="alert"] button').trigger('click')
    expect(failed.emitted('retry')).toHaveLength(1)
    const alone = await mountSection({ entries: null, error: 'HTTP 500', reviews: [] })
    expect(alone.find('[data-role-suggestions]').exists()).toBe(false)
    expect(alone.get('[role="alert"]').text()).toContain('Astro、Bole 和 Jefa 的建议没有读取成功。 HTTP 500')
    const same = await mountSection({ entries: null, error: 'waiting', reviews: null, reviewsError: 'waiting' })
    expect(same.get('[role="alert"]').text()).toMatch(/^建议没有读取成功。 waiting/)
  })

  it('reaches no write path: every control only reads or navigates', async () => {
    const wrapper = await mountSection({ entries: SUGGESTIONS, reviews: REVIEWS })
    for (const control of wrapper.findAll('button, a')) {
      await control.trigger('click')
      await flushPromises()
    }
    for (const write of [api.postJson, api.putJson, api.patchJson, api.deleteJson]) expect(write).not.toHaveBeenCalled()
    expect([...new Set(api.getJson.mock.calls.map(([url]) => String(url).split('?')[0]))].sort())
      .toEqual(['/api/project-agents/engineer-x', '/api/project-agents/engineer-x/score-card'])
    // The section, its model and its read import no write helper at all.
    for (const source of [sectionSource, modelSource, readSource, tonborgSource]) {
      expect(source).not.toMatch(/\b(postJson|putJson|patchJson|deleteJson|fetch\()/)
    }
  })
})


it('clears score-card caches when suggestions are removed by the recovery fence', async () => {
  const entries = [SUGGESTIONS[3]!]
  const wrapper = await mountSection({ entries })
  await wrapper.get('[data-suggestion-action]').trigger('click'); await flushPromises()
  expect(wrapper.get('[data-suggestion-score-card]').text()).toContain('25%')
  await wrapper.setProps({ entries: null, error: 'recovery waiting' })
  await wrapper.setProps({ entries: [...entries], error: '' })
  api.getJson.mockResolvedValueOnce({ dimensions: { completion: { status: 'scored', sample: 8, passed: 6, rate: 0.75 } } })
  await wrapper.get('[data-suggestion-action]').trigger('click'); await flushPromises()
  expect(wrapper.get('[data-suggestion-score-card]').text()).toContain('75%')
  expect(wrapper.text()).not.toContain('25%')
  wrapper.unmount()
})

it('reports score-card recovery refusal to the owning suggestions read', async () => {
  api.getJson.mockImplementation(async (url: string) => {
    if (url.includes('/score-card')) throw new ApiError('503', 503, '{"code":"knowledge_recovery_pending"}')
    return { agentId: 'engineer-x', personalSpaceId: 'space-1', profile: { name: 'Engineer X' } }
  })
  const wrapper = await mountSection({ entries: [SUGGESTIONS[3]!] })
  await wrapper.get('[data-suggestion-action]').trigger('click'); await flushPromises()
  expect(wrapper.emitted('recoveryPending')).toHaveLength(1)
  wrapper.unmount()
})


it('does not cache a late score-card body after entries were cleared and reloaded', async () => {
  let finish!: (value: unknown) => void
  let reads = 0
  api.getJson.mockImplementation(async (url: string) => {
    if (!url.includes('/score-card')) return { agentId: 'engineer-x', personalSpaceId: 'space-1', profile: { name: 'Engineer X' } }
    if (++reads === 1) return new Promise(resolve => { finish = resolve })
    return { dimensions: { completion: { status: 'scored', sample: 8, passed: 6, rate: 0.75 } } }
  })
  const entries = [SUGGESTIONS[3]!]
  const wrapper = await mountSection({ entries })
  await wrapper.get('[data-suggestion-action]').trigger('click')
  await wrapper.setProps({ entries: null, error: 'recovery waiting' })
  await wrapper.setProps({ entries: [...entries], error: '' })
  await wrapper.get('[data-suggestion-action]').trigger('click'); await flushPromises()
  finish(SCORE_CARD); await flushPromises()
  expect(wrapper.get('[data-suggestion-score-card]').text()).toContain('75%')
  expect(wrapper.text()).not.toContain('25%')
  wrapper.unmount()
})
