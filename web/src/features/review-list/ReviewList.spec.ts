import { enableAutoUnmount, flushPromises, mount, RouterLinkStub } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
// A question as the server lists it: its one sentence and two choices, the guess first.
const asking = (target: string, guess: 'keep' | 'drop' | 'edit' = 'drop', extra: Record<string, unknown> = {}) => decision(target, { guess,
  ask: { keep: '「Synthetic asked」像是只说了这一次，保留吗？', drop: '「Synthetic asked」像是只说了这一次，丢掉吗？', edit: '「Synthetic asked」说得不够清楚，先改一下再留吗？' }[guess],
  answers: [guess, guess === 'keep' ? 'drop' : 'keep'], doubt: 'one_off', ...extra })
let nodes: Array<ReturnType<typeof node>> = []
let delegated = { confirmed: [] as unknown[], questions: [] as unknown[] }
const projects = [{ project_id: 'project-a', personal_space_id: 'space-a', profile: { name: 'Synthetic project' } }]

enableAutoUnmount(afterEach)

beforeEach(() => {
  setActivePinia(createPinia())
  for (const mock of [getJson, postJson, patchJson, putJson, push]) mock.mockReset()
  nodes = [node('plain'), node('asked'), node('tonborg', { confirmation_status: 'agent_confirmed', confirmation_basis: tonborg })]
  delegated = { questions: [asking('entity:asked')], confirmed: [decision('entity:tonborg', { question: null, guess: 'keep' })] }
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
const button = (scope: { findAll: (selector: string) => Array<{ text: () => string; trigger: (event: string) => Promise<void>; attributes: (name: string) => string | undefined }> }, text: string) =>
  scope.findAll('button').find(candidate => candidate.text() === text)!

describe('ReviewList', () => {
  it('shows each waiting item as one line in its group, Tonborg\'s guess as the filled button', async () => {
    const wrapper = await mountList()
    expect(wrapper.findAll('[data-review-group]').map(group => group.attributes('data-review-group'))).toEqual(['questions', 'pending', 'confirmed'])
    // A Tonborg row is one plain question that quotes the item; the whole item is on hover.
    expect(row(wrapper, 'entity:asked').get('.review-row__text').text()).toBe('「Synthetic asked」像是只说了这一次，丢掉吗？')
    expect(row(wrapper, 'entity:asked').get('.review-row__text').attributes('title')).toBe('Synthetic asked：Synthetic asked statement')
    expect(row(wrapper, 'entity:asked').text()).not.toContain('I think you drop this. Right?')
    expect(row(wrapper, 'entity:plain').text()).toContain('Synthetic project · Synthetic Agent · 还没人看过')
    // Its guess is the filled first button, the opposite the second, then 其他.
    const asked = row(wrapper, 'entity:asked')
    expect(asked.findAll('button').map(candidate => [candidate.text(), candidate.attributes('data-variant')])).toEqual(
      [['不要', 'default'], ['保留', 'outline'], ['其他', 'ghost'], ['', 'ghost']])
    // Every row of a group offers the same actions in the same places.
    expect(row(wrapper, 'entity:plain').findAll('button').map(candidate => candidate.text())).toEqual(['确认', '不要', '改一下', ''])
  })

  it("sets Tonborg's questions apart: its face and name, and how many need the person", async () => {
    const wrapper = await mountList()
    const asks = wrapper.get('[data-review-group=questions]')
    expect(asks.classes()).toContain('review-group--asks')
    expect(asks.find('img.review-group__avatar').exists()).toBe(true)
    expect([asks.get('.review-group__name').text(), asks.get('.review-group__count').text()]).toEqual(['Tonborg 拿不准，要你定', '· 1'])
    // The meta line says where it is from; the reason is in 查看详情, not squeezed in here.
    expect(row(wrapper, 'entity:asked').get('.review-row__meta').text()).toBe('Synthetic project · Synthetic Agent')
    // Plain pending items keep their own group and look.
    expect(wrapper.get('[data-review-group=pending]').classes()).not.toContain('review-group--asks')
  })

  it('every kind of question keeps two choices and 其他 in the same places; the reason is in 查看详情', async () => {
    const long = 'Synthetic long reason '.repeat(10)
    nodes = [...nodes, node('kept'), node('vague')]
    delegated = { questions: [asking('entity:asked'), asking('entity:kept', 'keep'), asking('entity:vague', 'edit', { summary: long })],
      confirmed: [decision('entity:tonborg', { question: null, guess: 'keep', summary: 'Synthetic confirmed reason' })] }
    const wrapper = await mountList()
    const labels = (key: string) => row(wrapper, key).findAll('button').map(candidate => candidate.text())
    expect([labels('entity:asked'), labels('entity:kept'), labels('entity:vague')]).toEqual(
      [['不要', '保留', '其他', ''], ['保留', '不要', '其他', ''], ['改一下', '原样保留', '其他', '']])
    for (const key of ['entity:asked', 'entity:kept', 'entity:vague']) {
      expect(row(wrapper, key).findAll('button').map(candidate => candidate.attributes('data-variant'))).toEqual(['default', 'outline', 'ghost', 'ghost'])
    }
    const vague = row(wrapper, 'entity:vague')
    expect(vague.get('[data-review-ask]').text()).toBe('「Synthetic asked」说得不够清楚，先改一下再留吗？')
    await button(vague, '改一下').trigger('click'); await flushPromises()
    expect(push).toHaveBeenCalledWith('/knowledge/item/space-a/entity/vague')
    // Tonborg's whole reason and what it asks are in 查看详情.
    await button(vague, '').trigger('click'); await flushPromises()
    expect(document.body.textContent).toContain(long.trim())
    expect(document.body.textContent).toContain('Tonborg 问你')
    const confirmed = row(wrapper, 'entity:tonborg')
    expect(confirmed.get('.review-row__text').text()).toBe('Synthetic tonborg：Synthetic tonborg statement')
    expect(confirmed.get('.review-row__meta').text()).toBe('Synthetic project · Tonborg 替你确认 · Synthetic confirmed reason')
  })

  it('confirms as the person, and answering Tonborg\'s question is the vote on its guess', async () => {
    const wrapper = await mountList()
    await button(row(wrapper, 'entity:plain'), '确认').trigger('click'); await flushPromises()
    expect(patchJson).toHaveBeenCalledWith('/api/knowledge/entity/plain', expect.objectContaining({ action: 'confirm',
      confirmationStatus: 'confirmed', confirmationBasis: expect.objectContaining({ confirmedBy: expect.objectContaining({ kind: 'user' }) }) }))
    expect(wrapper.find('[data-review-line="entity:plain"]').exists()).toBe(false)
    expect(useConsoleStore().feedback?.message).toContain('已确认')

    await button(row(wrapper, 'entity:asked'), '保留').trigger('click'); await flushPromises()
    // Tonborg guessed drop; the person kept it with one click: their confirmation, and a 👎 with their choice as the reason.
    expect(patchJson).toHaveBeenCalledWith('/api/knowledge/entity/asked', expect.objectContaining({ action: 'confirm' }))
    expect(postJson).toHaveBeenCalledWith('/api/judgment/feedback', { personalSpaceId: 'space-a', decisionId: 'decision-entity:asked',
      vote: 'down', reason: '你选了「保留」', expectedRevision: 0 })
  })

  it('其他 opens a short field: the person\'s own words are recorded as said and the item goes back to pending knowledge', async () => {
    const wrapper = await mountList()
    await row(wrapper, 'entity:asked').get('[data-review-other]').trigger('click'); await flushPromises()
    const dialog = wrapper.get('[data-review-other-dialog]')
    // The question again, one field, and the third way to answer that the row does not show.
    expect(dialog.text()).toContain('「Synthetic asked」像是只说了这一次，丢掉吗？')
    expect(dialog.findAll('textarea')).toHaveLength(1)
    expect(dialog.get('[data-review-other-rest]').text()).toBe('改一下')
    const submit = dialog.get('button[type=submit]')
    expect(submit.attributes('disabled')).toBeDefined()
    await dialog.get('textarea').setValue('  这条先放着，下周发版后再定  ')
    expect(submit.attributes('disabled')).toBeUndefined()
    await dialog.get('form').trigger('submit'); await flushPromises()
    expect(postJson).toHaveBeenCalledWith('/api/judgment/feedback', { personalSpaceId: 'space-a', decisionId: 'decision-entity:asked',
      vote: 'down', reason: '你说：「这条先放着，下周发版后再定」', expectedRevision: 0 })
    // Nothing about the item changed: it leaves Tonborg's questions and waits with the pending knowledge.
    expect(patchJson).not.toHaveBeenCalled()
    expect(wrapper.find('[data-review-other-dialog]').exists()).toBe(false)
    expect(wrapper.find('[data-review-group=questions]').exists()).toBe(false)
    expect(wrapper.get('[data-review-group=pending]').find('[data-review-line="entity:asked"]').exists()).toBe(true)
    expect(useConsoleStore().feedback?.message).toBe('已记下你的话，这条回到「待确认的知识」')
  })

  it('asks for the questions in the console\'s language', async () => {
    await mountList()
    expect(getJson.mock.calls.map(([url]) => String(url)).filter(url => url.startsWith('/api/judgment/delegated?')))
      .toEqual(['/api/judgment/delegated?personalSpaceId=space-a&language=zh-CN'])
  })

  it('drops the earlier Agent replies together without asking, and 撤销 in the toast brings them back', async () => {
    nodes = [...nodes, node('echo', { name: 'I moved the notice', summary: 'I moved the notice; PR #842 is not merged yet.' })]
    const graphRead = getJson.getMockImplementation()!
    getJson.mockImplementation(async (url: string) => url.startsWith('/api/knowledge/reply-echoes?')
      ? { total: 1, items: [{ itemKind: 'entity', itemId: 'echo', signals: ['progress_narration', 'status_report'] }] } : graphRead(url))
    postJson.mockImplementation(async (url: string) => url.endsWith('/drop')
      ? { dropped: [{ itemKind: 'entity', itemId: 'echo' }], failed: [], skipped: [] }
      : { restored: [{ itemKind: 'entity', itemId: 'echo' }], failed: [] })
    const wrapper = await mountList()
    expect(wrapper.findAll('[data-review-group]').map(group => group.attributes('data-review-group')))
      .toEqual(['echoes', 'questions', 'pending', 'confirmed'])
    const echoes = wrapper.get('[data-review-group=echoes]')
    expect(echoes.get('h2').text()).toBe('之前误存的 Agent 回复 · 1')
    // Each row still shows the item itself.
    expect(row(wrapper, 'entity:echo').get('.review-row__text').text()).toBe('I moved the notice：I moved the notice; PR #842 is not merged yet.')
    expect(wrapper.find('[data-review-group=pending] [data-review-line="entity:echo"]').exists()).toBe(false)

    await echoes.get('[data-review-drop-echoes]').trigger('click'); await flushPromises()
    expect(postJson).toHaveBeenCalledWith('/api/knowledge/reply-echoes/drop',
      { personalSpaceId: 'space-a', items: [{ itemKind: 'entity', itemId: 'echo' }] }, expect.anything())
    expect(wrapper.find('[data-review-group=echoes]').exists()).toBe(false)
    const store = useConsoleStore()
    expect(store.feedback?.message).toBe('已丢掉 1 条误存的 Agent 回复')
    expect(store.feedback?.action?.label).toBe('撤销')

    await store.feedback!.action!.run(); await flushPromises()
    expect(postJson).toHaveBeenCalledWith('/api/knowledge/reply-echoes/restore',
      { personalSpaceId: 'space-a', items: [{ itemKind: 'entity', itemId: 'echo' }] }, expect.anything())
    expect(store.feedback?.message).toBe('已恢复 1 条，回到待决策')
    expect(wrapper.find('[data-review-group=echoes]').exists()).toBe(true)
  })

  it('drops without a second question, and accepting all guesses applies them', async () => {
    const wrapper = await mountList()
    await button(wrapper.get('[data-review-group=questions]'), '全按猜的办').trigger('click'); await flushPromises()
    expect(patchJson).toHaveBeenCalledWith('/api/knowledge/entity/asked', expect.objectContaining({ action: 'invalidate' }))
    expect(postJson).toHaveBeenCalledWith('/api/judgment/feedback', expect.objectContaining({ decisionId: 'decision-entity:asked', vote: 'up' }))
  })

  describe('全部确认 (Jevons 11-06: 75 items were extremely slow)', () => {
    const many = (count: number) => Array.from({ length: count }, (_, index) => node(`bulk-${String(index).padStart(3, '0')}`))
    const batches = () => postJson.mock.calls.filter(([url]) => url === '/api/knowledge/batch-confirmation')
    const graphReads = () => getJson.mock.calls.filter(([url]) => String(url).startsWith('/api/graph?')).length

    it('confirms in batches of one request each, without a request or a list read per item', async () => {
      nodes = many(60)
      delegated = { questions: [], confirmed: [] }
      const wrapper = await mountList()
      const reads = graphReads()
      await button(wrapper.get('[data-review-group=pending]'), '全部确认').trigger('click'); await flushPromises()
      expect(batches().map(([, body]) => body.items.length)).toEqual([25, 25, 10])
      expect(batches()[0]![1]).toEqual(expect.objectContaining({ personalSpaceId: 'space-a', groupKind: 'review', groupValue: 'pending',
        confirmer: expect.objectContaining({ kind: 'user' }) }))
      expect(batches()[0]![1].items[0]).toEqual(expect.objectContaining({ itemId: 'bulk-000', itemKind: 'entity', existenceReason: 'Synthetic.' }))
      expect(patchJson).not.toHaveBeenCalled()
      expect(graphReads()).toBe(reads)
      expect(wrapper.find('[data-review-group=pending]').exists()).toBe(false)
      expect(useConsoleStore().feedback).toEqual(expect.objectContaining({ message: '已确认 60 条知识', link: { to: '/knowledge' } }))
    })

    it('draws only the rows near the screen in a long group, names each group for the page outline, and still confirms all', async () => {
      nodes = many(60)
      delegated = { questions: [], confirmed: [decision('entity:bulk-059', { question: null, guess: 'keep' })] }
      nodes[59] = node('bulk-059', { confirmation_status: 'agent_confirmed', confirmation_basis: tonborg })
      const wrapper = await mountList()
      const pending = wrapper.get('[data-review-group=pending]')
      expect(pending.get('[data-review-rows]').attributes('data-review-rows')).toBe('virtual')
      const drawn = pending.findAll('[data-review-line]').length
      expect(drawn).toBeGreaterThan(0)
      expect(drawn).toBeLessThan(59)
      // A short group stays a plain list.
      expect(wrapper.get('[data-review-group=confirmed] [data-review-rows]').attributes('data-review-rows')).toBe('list')
      const title = pending.get('h2')
      expect([title.attributes('data-outline-label'), title.attributes('data-outline-count')]).toEqual(['待确认的知识', '59'])
      await button(pending, '全部确认').trigger('click'); await flushPromises()
      expect(batches().reduce((sum, [, body]) => sum + body.items.length, 0)).toBe(59)
      expect(wrapper.find('[data-review-group=pending]').exists()).toBe(false)
    })

    it('shows one short progress line counted from the batches that came back, and holds the rows meanwhile', async () => {
      nodes = many(30)
      delegated = { questions: [], confirmed: [] }
      const answers: Array<() => void> = []
      postJson.mockImplementation((url: string) => url === '/api/knowledge/batch-confirmation'
        ? new Promise(resolve => answers.push(() => resolve({}))) : Promise.resolve({}))
      const wrapper = await mountList()
      const group = () => wrapper.get('[data-review-group=pending]')
      await button(group(), '全部确认').trigger('click'); await flushPromises()
      const label = () => group().get('.review-busy--progress [role=status]').attributes('aria-label')
      expect(label()).toBe('正在确认 0/30')
      expect(group().findAll('.review-busy--progress [role=status]')).toHaveLength(1)
      expect(button(group(), '全部确认').attributes('disabled')).toBeDefined()
      expect(button(row(wrapper, 'entity:bulk-005'), '确认').attributes('disabled')).toBeDefined()
      answers.shift()!(); await flushPromises()
      expect(label()).toBe('正在确认 25/30')
      expect(wrapper.find('[data-review-line="entity:bulk-000"]').exists()).toBe(false)
      expect(wrapper.find('[data-review-line="entity:bulk-029"]').exists()).toBe(true)
      answers.shift()!(); await flushPromises()
      expect(wrapper.find('.review-busy--progress [role=status]').exists()).toBe(false)
    })

    it('goes item by item through a batch refused because one moved, and keeps the one that failed', async () => {
      nodes = many(3)
      delegated = { questions: [], confirmed: [] }
      const { ApiError } = await import('@/api/client')
      postJson.mockImplementation(async (url: string) => {
        if (url === '/api/knowledge/batch-confirmation') throw new ApiError('changed since read', 409)
        return {}
      })
      patchJson.mockImplementation(async (url: string) => {
        if (url.endsWith('/bulk-001')) throw new ApiError('already confirmed', 409)
        return {}
      })
      const wrapper = await mountList()
      await button(wrapper.get('[data-review-group=pending]'), '全部确认').trigger('click')
      nodes = [nodes[1]!]
      await flushPromises()
      expect(patchJson.mock.calls.map(([url]) => url)).toEqual(['/api/knowledge/entity/bulk-000', '/api/knowledge/entity/bulk-001',
        '/api/knowledge/entity/bulk-002'])
      expect(useConsoleStore().feedback?.message).toBe('已处理 2 条，1 条没成功，还在列表里')
      expect(wrapper.findAll('[data-review-line]').map(line => line.attributes('data-review-line'))).toEqual(['entity:bulk-001'])
    })
  })

  it('undoes one of Tonborg\'s confirmations, and 都对 records the person agrees', async () => {
    const wrapper = await mountList()
    await button(row(wrapper, 'entity:tonborg'), '撤销').trigger('click'); await flushPromises()
    expect(postJson).toHaveBeenCalledWith('/api/judgment/undo', { personalSpaceId: 'space-a', decisionId: 'decision-entity:tonborg' })
    postJson.mockClear()
    await button(wrapper.get('[data-review-group=confirmed]'), '都对').trigger('click'); await flushPromises()
    expect(postJson).toHaveBeenCalledWith('/api/judgment/feedback', expect.objectContaining({ decisionId: 'decision-entity:tonborg', vote: 'up' }))
  })

  it('reads the list again when coming back to the page only if Tonborg decided something meanwhile', async () => {
    delegated = { questions: [], confirmed: [] }
    const wrapper = await mountList()
    const reads = () => getJson.mock.calls.filter(([url]) => String(url).startsWith('/api/graph?')).length
    const before = reads()
    document.dispatchEvent(new Event('visibilitychange')); await flushPromises()
    expect(reads()).toBe(before)
    delegated = { questions: [decision('entity:asked')], confirmed: [] }
    document.dispatchEvent(new Event('visibilitychange')); await flushPromises()
    expect(reads()).toBe(before + 1)
    expect(wrapper.find('[data-review-group=questions]').exists()).toBe(true)
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
  it("saves the console's language again while on, so Tonborg asks in it", async () => {
    getJson.mockResolvedValue({ enabled: true, changedAt: '2026-11-06T00:00:00Z', revision: 5, language: null,
      model: { connected: true, status: 'automatic', reason: null } })
    putJson.mockResolvedValue({ enabled: true, changedAt: '2026-11-06T00:00:00Z', revision: 6, language: 'zh-CN',
      model: { connected: true, status: 'automatic', reason: null } })
    mount(TonborgDelegationSwitch, { props: { personalSpaceId: 'space-a' }, global: { stubs: { RouterLink: RouterLinkStub } } })
    await flushPromises()
    expect(putJson).toHaveBeenCalledTimes(1)
    expect(putJson).toHaveBeenCalledWith('/api/judgment/delegation', { personalSpaceId: 'space-a', enabled: true, expectedRevision: 5,
      language: 'zh-CN' }, expect.anything())
  })

  it("links from the list to Tonborg's confirmation settings, and only there", async () => {
    getJson.mockResolvedValue({ enabled: true, changedAt: null, revision: 2, language: 'zh-CN', model: { connected: true, status: 'automatic', reason: null } })
    const onList = mount(TonborgDelegationSwitch, { props: { personalSpaceId: 'space-a', settingsLink: true }, global: { stubs: { RouterLink: RouterLinkStub } } })
    await flushPromises()
    const link = onList.getComponent(RouterLinkStub)
    expect(link.text()).toBe('设置')
    expect(link.props('to')).toEqual({ path: '/models', query: { details: 'tonborg' }, hash: '#delegation' })
    const inSettings = mount(TonborgDelegationSwitch, { props: { personalSpaceId: 'space-a' }, global: { stubs: { RouterLink: RouterLinkStub } } })
    await flushPromises()
    expect(inSettings.findComponent(RouterLinkStub).exists()).toBe(false)
  })

  it('cannot be turned on without Tonborg\'s own model and says where to connect one', async () => {
    getJson.mockResolvedValue({ enabled: false, changedAt: null, revision: 0, model: { connected: false, status: 'suggestion', reason: 'not_configured' } })
    const wrapper = mount(TonborgDelegationSwitch, { props: { personalSpaceId: 'space-a' }, global: { stubs: { RouterLink: RouterLinkStub } } })
    await flushPromises()
    expect(wrapper.get('[data-slot=switch]').attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('需要先给 Tonborg 接一个模型')
    expect(wrapper.getComponent(RouterLinkStub).props('to')).toBe('/models')
  })

  it('turns on with the revision it read and reports the change', async () => {
    getJson.mockResolvedValue({ enabled: false, changedAt: null, revision: 3, model: { connected: true, status: 'automatic', reason: null } })
    putJson.mockResolvedValue({ enabled: true, changedAt: '2026-11-06T00:00:00Z', revision: 4, model: { connected: true, status: 'automatic', reason: null } })
    const wrapper = mount(TonborgDelegationSwitch, { props: { personalSpaceId: 'space-a' }, global: { stubs: { RouterLink: RouterLinkStub } } })
    await flushPromises()
    await wrapper.get('[data-slot=switch]').trigger('click'); await flushPromises()
    expect(putJson).toHaveBeenCalledWith('/api/judgment/delegation', { personalSpaceId: 'space-a', enabled: true, expectedRevision: 3,
      language: 'zh-CN' }, expect.anything())
    expect(wrapper.emitted('changed')).toEqual([[true]])
    expect(wrapper.text()).toContain('Tonborg 正在替你确认')
  })
})
