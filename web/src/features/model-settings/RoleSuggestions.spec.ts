import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ getJson: vi.fn(), postJson: vi.fn(), putJson: vi.fn(), patchJson: vi.fn(), deleteJson: vi.fn() }))
vi.mock('@/api/client', async (importOriginal) => ({ ...await importOriginal<typeof import('@/api/client')>(), ...api }))

import RoleSuggestions from './RoleSuggestions.vue'
import sectionSource from './RoleSuggestions.vue?raw'
import modelSource from './suggestions.ts?raw'

// Synthetic suggestions only, one per role and state; no real model, Agent or board.
const receipt = (role: string, operation: string) => ({ requestId: `${operation}:r-${role}`, evidenceVersion: `${role}`.padEnd(64, '0'),
  promptVersion: `${operation}:p`, gate: { status: 'suggestion_only', role, operation },
  modelReceipt: { requestedModel: 'qwen-test', actualModel: 'qwen-test-actual' } })
const SUGGESTIONS = [
  { id: 4, at: '2026-10-23T09:00:00.000Z', role: 'bole', operation: 'performance_review', personalSpaceId: 'space-1', personalProjectId: 'garden',
    subject: { agentId: 'engineer-x' }, status: 'suggested', suggestion: { action: 'coach', reason: 'Completion is low.', evidenceIds: ['completion'] },
    suggestedBy: { model: 'qwen-test-actual' }, ...receipt('bole', 'performance_review') },
  { id: 3, at: '2026-10-23T08:30:00.000Z', role: 'jefa', operation: 'board_match', personalSpaceId: 'space-1', personalProjectId: 'garden',
    subject: {}, status: 'suggested', hint: '可能是看板上的「Seed inventory」任务', suggestion: { taskId: 'task-seeds', title: 'Seed inventory' },
    suggestedBy: { model: 'qwen-test-actual' }, ...receipt('jefa', 'board_match') },
  { id: 2, at: '2026-10-23T08:10:00.000Z', role: 'assistant', operation: 'project_candidate', personalSpaceId: 'space-1', personalProjectId: null,
    subject: { conversationId: 'conv-1' }, status: 'superseded', reason: 'corrected_by_user', ...receipt('assistant', 'project_candidate') },
  { id: 1, at: '2026-10-23T08:00:00.000Z', role: 'jefa', operation: 'board_match', personalSpaceId: 'space-1', personalProjectId: 'garden',
    subject: {}, status: 'paused', reason: 'window_tokens', ...receipt('jefa', 'board_match') },
]
const SCORE_CARD = { dimensions: {
  completion: { status: 'scored', sample: 8, passed: 2, rate: 0.25 }, firstPass: { status: 'insufficient_data', sample: 1, label: '数据不足' } } }

beforeEach(() => {
  for (const spy of Object.values(api)) spy.mockReset()
  api.getJson.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/model-backends/suggestions')) return { suggestions: SUGGESTIONS }
    if (url.startsWith('/api/project-agents/engineer-x/score-card')) return SCORE_CARD
    if (url.startsWith('/api/project-agents/engineer-x')) return { agentId: 'engineer-x', personalSpaceId: 'space-1', profile: { name: 'Engineer X' } }
    throw new Error(`unexpected read ${url}`)
  })
})

const mountSection = async () => {
  const wrapper = mount(RoleSuggestions, { attachTo: document.body, global: { stubs: { RouterLink: { props: ['to'],
    template: '<a :href="JSON.stringify(to)"><slot /></a>' } } } })
  await flushPromises()
  return wrapper
}

describe('RoleSuggestions', () => {
  it('shows each suggestion with its model, time, state, gate and evidence; stops and supersessions say why', async () => {
    const wrapper = await mountSection()
    const cards = wrapper.findAll('[data-role-suggestion]')
    expect(cards.map(card => [card.attributes('data-role-suggestion'), card.attributes('data-suggestion-state')]))
      .toEqual([['bole', 'suggested'], ['jefa', 'suggested'], ['assistant', 'superseded'], ['jefa', 'stopped']])
    for (const card of cards) expect(card.get('[data-suggestion-gate]').text()).toBe('仅建议')
    expect(cards[0].get('[data-suggestion-text]').text()).toBe('Engineer X · 针对弱项给出反馈')
    expect(cards[0].text()).toContain('qwen-test-actual')
    expect(cards[0].get('[data-suggestion-evidence]').text()).toContain('完成')
    expect(cards[0].get('time').attributes('datetime')).toBe('2026-10-23T09:00:00.000Z')
    expect(cards[2].get('[data-suggestion-why]').text()).toBe('你已经给这段对话定了归属。')
    expect(cards[3].get('[data-suggestion-why]').text()).toBe('这个周期的 tokens 用完了。')
    expect(cards[2].find('[data-suggestion-action]').exists()).toBe(false)
    expect(cards[3].find('[data-suggestion-action]').exists()).toBe(false)
    expect(JSON.parse(cards[1].get('[data-suggestion-action]').attributes('href')!))
      .toEqual({ path: '/employees/jefa', query: { item: 'space-1/garden%3Atask-seeds' } })
  })

  it('opens Bole\'s score card read-only and lifts that card', async () => {
    const wrapper = await mountSection()
    const bole = () => wrapper.get('[data-role-suggestion="bole"]')
    await bole().get('[data-suggestion-action]').trigger('click')
    await flushPromises()
    expect(bole().classes()).toContain('shadow-md')
    expect(bole().get('[data-suggestion-score-card]').text()).toContain('25% · 2/8')
    expect(bole().get('[data-suggestion-score-card]').text()).toContain('数据不足')
    expect(api.getJson).toHaveBeenCalledWith('/api/project-agents/engineer-x/score-card?personalSpaceId=space-1&personalProjectId=garden',
      expect.anything())
  })

  it('reaches no write path: every control only reads or navigates', async () => {
    const wrapper = await mountSection()
    for (const control of wrapper.findAll('button, a')) {
      await control.trigger('click')
      await flushPromises()
    }
    for (const write of [api.postJson, api.putJson, api.patchJson, api.deleteJson]) expect(write).not.toHaveBeenCalled()
    expect(api.getJson.mock.calls.map(([url]) => String(url).split('?')[0]).sort()).toEqual([
      '/api/model-backends/suggestions', '/api/project-agents/engineer-x', '/api/project-agents/engineer-x/score-card'])
    // The section and its model import no write helper at all.
    for (const source of [sectionSource, modelSource]) {
      expect(source).not.toMatch(/\b(postJson|putJson|patchJson|deleteJson|fetch\()/)
    }
  })

  it('shows nothing when no role has suggested anything', async () => {
    api.getJson.mockResolvedValue({ suggestions: [] })
    const wrapper = await mountSection()
    expect(wrapper.find('[data-role-suggestions]').exists()).toBe(false)
  })
})
