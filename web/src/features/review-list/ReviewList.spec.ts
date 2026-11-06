import { flushPromises, mount, RouterLinkStub } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getJson, postJson, patchJson, putJson, push } = vi.hoisted(() => ({
  getJson: vi.fn(), postJson: vi.fn(), patchJson: vi.fn(), putJson: vi.fn(), push: vi.fn(),
}))
vi.mock('@/api/client', async importOriginal => ({ ...await importOriginal<typeof import('@/api/client')>(), getJson, postJson, patchJson, putJson }))
vi.mock('vue-router', async importOriginal => ({ ...await importOriginal<typeof import('vue-router')>(), useRouter: () => ({ push }) }))

import { useConsoleStore } from '@/stores/console'
import ReviewList from './ReviewList.vue'
import TonborgDelegationSwitch from './TonborgDelegationSwitch.vue'

// rec#96, synthetic data only.
const basis = { existence_reason: 'Synthetic.', quadrant_reason: 'Synthetic.', proposed_by: { kind: 'agent', label: 'Synthetic Agent' } }
const node = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: `Synthetic ${id}`, type: 'Fact', summary: `Synthetic ${id} statement`,
  confirmation_status: 'pending', confirmation_state_explicit: true, confirmation_basis: basis, preference_project_id: 'project-a', ...extra })
const tonborg = { ...basis, confirmed_by: { kind: 'agent', label: 'Tonborg' }, confirmed_at: '2026-11-06T00:00:00Z', agent_policy_version: 'tonborg-review-v1' }
const decision = (target: string, extra: Record<string, unknown> = {}) => ({ id: `decision-${target}`, createdAt: '2026-11-06T00:00:00Z',
  personalProjectId: 'project-a', target, title: null, summary: 'Synthetic reason', confidence: 0.6, guess: 'drop',
  question: 'I think you drop this. Right?', feedbackRevision: 0, ...extra })
let nodes: Array<ReturnType<typeof node>> = []
let delegated = { confirmed: [] as unknown[], questions: [] as unknown[] }
const projects = [{ project_id: 'project-a', personal_space_id: 'space-a', profile: { name: 'Synthetic project' } }]

beforeEach(() => {
  setActivePinia(createPinia())
  for (const mock of [getJson, postJson, patchJson, putJson, push]) mock.mockReset()
  nodes = [node('plain'), node('asked'), node('tonborg', { confirmation_status: 'agent_confirmed', confirmation_basis: tonborg })]
  delegated = { questions: [decision('entity:asked')], confirmed: [decision('entity:tonborg', { question: null, guess: 'keep' })] }
  getJson.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/graph?')) return { nodes, edges: [], truncated: false }
    if (url.startsWith('/api/judgment/delegated?')) return delegated
    if (url.startsWith('/api/judgment/delegation?')) return { enabled: false, changedAt: null, revision: 3,
      model: { connected: true, status: 'automatic', reason: null } }
    throw new Error(`Unexpected request: ${url}`)
  })
  patchJson.mockResolvedValue({})
  postJson.mockResolvedValue({})
})

const mountList = async () => {
  const wrapper = mount(ReviewList, { props: { personalSpaceId: 'space-a', projects: projects as never }, attachTo: document.body,
    global: { stubs: { RouterLink: RouterLinkStub } } })
  await flushPromises()
  return wrapper
}
const row = (wrapper: Awaited<ReturnType<typeof mountList>>, key: string) => wrapper.get(`[data-review-line="${key}"]`)
const button = (scope: { findAll: (selector: string) => Array<{ text: () => string; trigger: (event: string) => Promise<void> }> }, text: string) =>
  scope.findAll('button').find(candidate => candidate.text() === text)!

describe('ReviewList', () => {
  it('shows each waiting item as one line in its group, Tonborg\'s guess as the filled button', async () => {
    const wrapper = await mountList()
    expect(wrapper.findAll('[data-review-group]').map(group => group.attributes('data-review-group'))).toEqual(['questions', 'pending', 'confirmed'])
    expect(row(wrapper, 'entity:asked').text()).toContain('I think you drop this. Right?')
    expect(row(wrapper, 'entity:plain').text()).toContain('Synthetic project · Synthetic Agent · 还没人看过')
    const asked = row(wrapper, 'entity:asked')
    expect(asked.findAll('button').map(candidate => candidate.attributes('data-variant'))).toEqual(['outline', 'default', 'ghost', 'ghost'])
    // Every row of a group offers the same actions in the same places.
    expect(row(wrapper, 'entity:plain').findAll('button').map(candidate => candidate.text())).toEqual(['确认', '不要', '改一下', ''])
  })

  it('confirms as the person, and answering Tonborg\'s question is the vote on its guess', async () => {
    const wrapper = await mountList()
    await button(row(wrapper, 'entity:plain'), '确认').trigger('click'); await flushPromises()
    expect(patchJson).toHaveBeenCalledWith('/api/knowledge/entity/plain', expect.objectContaining({ action: 'confirm',
      confirmationStatus: 'confirmed', confirmationBasis: expect.objectContaining({ confirmedBy: expect.objectContaining({ kind: 'user' }) }) }))
    expect(wrapper.find('[data-review-line="entity:plain"]').exists()).toBe(false)
    expect(useConsoleStore().feedback?.message).toContain('已确认')

    await button(row(wrapper, 'entity:asked'), '确认').trigger('click'); await flushPromises()
    // Tonborg guessed drop; the person kept it: a 👎 with their choice as the reason.
    expect(postJson).toHaveBeenCalledWith('/api/judgment/feedback', { personalSpaceId: 'space-a', decisionId: 'decision-entity:asked',
      vote: 'down', reason: '你选了「确认」', expectedRevision: 0 })
  })

  it('drops without a second question, and accepting all guesses applies them', async () => {
    const wrapper = await mountList()
    await button(wrapper.get('[data-review-group=questions]'), '全按猜的办').trigger('click'); await flushPromises()
    expect(patchJson).toHaveBeenCalledWith('/api/knowledge/entity/asked', expect.objectContaining({ action: 'invalidate' }))
    expect(postJson).toHaveBeenCalledWith('/api/judgment/feedback', expect.objectContaining({ decisionId: 'decision-entity:asked', vote: 'up' }))
  })

  it('undoes one of Tonborg\'s confirmations, and 都对 records the person agrees', async () => {
    const wrapper = await mountList()
    await button(row(wrapper, 'entity:tonborg'), '撤销').trigger('click'); await flushPromises()
    expect(postJson).toHaveBeenCalledWith('/api/judgment/undo', { personalSpaceId: 'space-a', decisionId: 'decision-entity:tonborg' })
    postJson.mockClear()
    await button(wrapper.get('[data-review-group=confirmed]'), '都对').trigger('click'); await flushPromises()
    expect(postJson).toHaveBeenCalledWith('/api/judgment/feedback', expect.objectContaining({ decisionId: 'decision-entity:tonborg', vote: 'up' }))
  })

  it('改一下 opens the item\'s own page', async () => {
    const wrapper = await mountList()
    await button(row(wrapper, 'entity:plain'), '改一下').trigger('click'); await flushPromises()
    expect(push).toHaveBeenCalledWith('/knowledge/item/space-a/entity/plain')
  })

  it('says nothing at all when nothing waits', async () => {
    nodes = []
    delegated = { confirmed: [], questions: [] }
    const wrapper = await mountList()
    expect(wrapper.text()).toBe('')
  })
})

describe('交给 Tonborg 确认', () => {
  it('cannot be turned on without Tonborg\'s own model and says where to connect one', async () => {
    getJson.mockResolvedValue({ enabled: false, changedAt: null, revision: 0, model: { connected: false, status: 'suggestion', reason: 'not_configured' } })
    const wrapper = mount(TonborgDelegationSwitch, { props: { personalSpaceId: 'space-a' }, global: { stubs: { RouterLink: RouterLinkStub } } })
    await flushPromises()
    expect(wrapper.get('[data-slot=switch]').attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('需要先给 Tonborg 接一个模型')
    expect(wrapper.getComponent(RouterLinkStub).props('to')).toBe('/settings/models')
  })

  it('turns on with the revision it read and reports the change', async () => {
    getJson.mockResolvedValue({ enabled: false, changedAt: null, revision: 3, model: { connected: true, status: 'automatic', reason: null } })
    putJson.mockResolvedValue({ enabled: true, changedAt: '2026-11-06T00:00:00Z', revision: 4, model: { connected: true, status: 'automatic', reason: null } })
    const wrapper = mount(TonborgDelegationSwitch, { props: { personalSpaceId: 'space-a' }, global: { stubs: { RouterLink: RouterLinkStub } } })
    await flushPromises()
    await wrapper.get('[data-slot=switch]').trigger('click'); await flushPromises()
    expect(putJson).toHaveBeenCalledWith('/api/judgment/delegation', { personalSpaceId: 'space-a', enabled: true, expectedRevision: 3 }, expect.anything())
    expect(wrapper.emitted('changed')).toEqual([[true]])
    expect(wrapper.text()).toContain('Tonborg 正在替你确认')
  })
})
