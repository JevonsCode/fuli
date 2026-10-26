import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'

const { getJson, postJson } = vi.hoisted(() => ({ getJson: vi.fn(), postJson: vi.fn() }))
vi.mock('@/api/client', async original => ({ ...(await original<typeof import('@/api/client')>()), getJson, postJson }))

import { ApiError } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { t } from '@/i18n'
import JudgmentWorkbench from './JudgmentWorkbench.vue'
import { provideWorkbenchToolbarActions } from '@/features/employees/workbench-toolbar'

function record(overrides: Record<string, unknown> = {}) {
  return {
    id: 'decision-a',
    createdAt: '2026-10-11T08:00:00.000Z',
    personalProjectId: 'project-a',
    kind: 'review',
    target: 'relationship:synthetic-id',
    title: 'release checklist',
    summary: 'Needs a human release decision.',
    outcome: 'escalate',
    evidence: ['release owner is missing'],
    policy: { mode: 'manual', quality: 'quality' },
    client: 'codex',
    model: null,
    sessionId: 'session-a',
    selection: null,
    execution: { status: 'not_applied' },
    feedback: { revision: 2, vote: null, reason: '' },
    feedbackHistory: [],
    executionHistory: [],
    ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

describe('JudgmentWorkbench', () => {
  beforeEach(() => {
    getJson.mockReset().mockResolvedValue({ records: [record(), record({
      id: 'decision-b', outcome: 'approve', summary: 'Safe to continue.', execution: { status: 'applied' },
    })] })
    postJson.mockReset().mockImplementation(async (url: string, body: Record<string, unknown>) => {
      if (url === '/api/judgment/review') return { records: [record({ id: 'decision-c', outcome: 'recommend' })], remaining: 0 }
      return { ...record(), ...body, feedback: { revision: 3, vote: body.vote, reason: body.reason ?? '' } }
    })
  })

  it('loads recent records and filters human-needed decisions', async () => {
    const wrapper = mount(JudgmentWorkbench, { props: { personalSpaceId: 'space-a' } })
    await flushPromises()

    expect(getJson).toHaveBeenCalledWith('/api/judgment/records?personalSpaceId=space-a')
    expect(wrapper.findAll('[data-decision-card]')).toHaveLength(1)
    await wrapper.get('.judgment-filter [data-value="all"]').trigger('click')
    expect(wrapper.findAll('[data-decision-card]')).toHaveLength(2)
    await wrapper.get('.judgment-filter [data-value="human"]').trigger('click')
    expect(wrapper.findAll('[data-decision-card]')).toHaveLength(1)
    expect(wrapper.text()).toContain('release checklist')
    expect(wrapper.get('[data-decision-card] h3').text()).toBe('release checklist')
  })

  it('requests a bounded review with a fresh request ID and shows the result', async () => {
    const wrapper = mount(JudgmentWorkbench, { props: { personalSpaceId: 'space-a' } })
    await flushPromises()
    await wrapper.get('.judgment-filter [data-value="all"]').trigger('click')
    await wrapper.get('[data-action="review"]').trigger('click')
    await flushPromises()

    const [url, body] = postJson.mock.calls.find(([calledUrl]) => calledUrl === '/api/judgment/review')!
    expect(url).toBe('/api/judgment/review')
    expect(body).toMatchObject({ personalSpaceId: 'space-a', limit: 10 })
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(wrapper.findAll('[data-decision-card]')).toHaveLength(3)
  })

  it('shows a gated review as a suggestion with the model conclusion, and undoes an applied one', async () => {
    const gate = { status: 'not_passed', reason: 'suggestions_only', modelId: 'synthetic-model' }
    getJson.mockResolvedValue({ records: [
      record({ aiReview: { state: 'ai_suggested', modelOutcome: 'approve', interceptions: ['gate_not_passed'], gate } }),
      record({ id: 'decision-b', outcome: 'approve', execution: { status: 'applied' },
        aiReview: { state: 'ai_reviewed', modelOutcome: 'approve', interceptions: [], gate: { ...gate, status: 'passed', reason: null } } }),
    ] })
    postJson.mockImplementation(async (url: string) => url === '/api/judgment/undo'
      ? record({ id: 'decision-b', outcome: 'approve', execution: { status: 'undone' } })
      : {})
    const wrapper = mount(JudgmentWorkbench, { props: { personalSpaceId: 'space-a' } })
    await flushPromises()
    await wrapper.get('.judgment-filter [data-value="all"]').trigger('click')

    const cards = wrapper.findAll('[data-decision-card]')
    const suggestion = cards.find(card => card.text().includes('AI 建议，待你确认'))!
    expect(suggestion.text()).toContain('模型结论')
    expect(suggestion.text()).toContain('通过')
    expect(suggestion.find('[data-action="undo"]').exists()).toBe(false)
    const reviewed = cards.find(card => card.text().includes('由 synthetic-model 自动执行'))!
    await reviewed.get('[data-action="undo"]').trigger('click')
    await flushPromises()

    expect(postJson).toHaveBeenCalledWith('/api/judgment/undo', { personalSpaceId: 'space-a', decisionId: 'decision-b' })
    expect(wrapper.text()).toContain('已撤回')
    expect(wrapper.find('[data-action="undo"]').exists()).toBe(false)
  })

  it('names the host pre-check signals of an injection-shaped candidate beside the model conclusion (rec#26)', async () => {
    const gate = { status: 'passed', reason: null, modelId: 'synthetic-model' }
    getJson.mockResolvedValue({ records: [
      record({ aiReview: { state: 'ai_suggested', modelOutcome: 'approve', interceptions: ['injection_suspected'], gate,
        injectionSignals: ['authority_claim', 'outcome_directive'] } }),
      record({ id: 'decision-b', aiReview: { state: 'ai_suggested', modelOutcome: 'escalate', interceptions: [], gate } }),
      record({ id: 'decision-c', aiReview: { state: 'ai_suggested', modelOutcome: 'approve', interceptions: ['batch_contaminated'], gate,
        injectionInBatch: true } }),
    ] })
    const wrapper = mount(JudgmentWorkbench, { props: { personalSpaceId: 'space-a' } })
    await flushPromises()
    await wrapper.get('.judgment-filter [data-value="all"]').trigger('click')
    const notes = wrapper.findAll('[data-injection-precheck]').map(note => note.text())
    expect(notes.sort()).toEqual(['已知注入格式冒称已获批准 · 试图指定审核结果', '已知注入格式同批另一候选匹配'])
  })

  it('says honestly when an undo is refused, and offers none for permanently deleted knowledge (D-36.12)', async () => {
    const applied = { state: 'ai_reviewed', modelOutcome: 'approve', interceptions: [], gate: { status: 'passed', reason: null, modelId: 'synthetic-model' } }
    getJson.mockResolvedValue({ records: [
      record({ id: 'edited', outcome: 'approve', execution: { status: 'applied' }, aiReview: applied }),
      record({ id: 'deleted', outcome: 'approve', execution: { status: 'applied' }, aiReview: applied, hard_deleted: true, title: null }),
    ] })
    postJson.mockRejectedValue(new ApiError('refused', 409, JSON.stringify({ error: 'the item changed', code: 'ai_review_changed' })))
    const wrapper = mount(JudgmentWorkbench, { props: { personalSpaceId: 'space-a' } })
    await flushPromises()
    await wrapper.get('.judgment-filter [data-value="all"]').trigger('click')
    const [edited, deleted] = ['edited', 'deleted'].map(id => wrapper.findAll('[data-decision-card]')
      .find(card => card.find('[data-action="undo"]').exists() === (id === 'edited'))!)
    expect(deleted.find('[data-action="undo"]').exists()).toBe(false)
    await edited.get('[data-action="undo"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-undo-refused]').text()).toBe('无法撤回：已被修改')
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('已撤回')
  })

  it('shows the trust warning on a receipt the model could not execute because it was not read yet (D-36.11)', async () => {
    getJson.mockResolvedValue({ records: [record({ outcome: 'approve', aiReview: { state: 'ai_suggested', modelOutcome: 'approve',
      interceptions: ['gate_not_passed'], gate: { status: 'not_passed', reason: 'warning_not_seen', modelId: 'synthetic-model' } } })] })
    const wrapper = mount(JudgmentWorkbench, { props: { personalSpaceId: 'space-a' }, global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } } })
    await flushPromises()
    const warning = wrapper.get('[data-trust-warning]')
    expect(warning.text()).toContain('模型可能判断错，它的判断会直接生效；你可以随时改成「只给建议」，部分写入可在回执里撤回。')
    expect(warning.text()).toContain('你还没看过这条提示，所以这次只作为建议。')
    expect(warning.text()).toContain('去模型设置确认')
    // Showing the receipt sends nothing: only the settings page acknowledges the warning.
    expect(postJson).not.toHaveBeenCalled()
  })

  it('keeps autonomous runtime recommendations out of the human-needed queue', async () => {
    getJson.mockResolvedValueOnce({ records: [record({
      kind: 'routing', outcome: 'recommend', disposition: 'continue_current', policy: { mode: 'autonomous' },
    })] })
    const wrapper = mount(JudgmentWorkbench, { props: { personalSpaceId: 'space-a' } })
    await flushPromises()
    expect(wrapper.findAll('[data-decision-card]')).toHaveLength(0)
    await wrapper.get('.judgment-filter [data-value="all"]').trigger('click')
    expect(wrapper.findAll('[data-decision-card]')).toHaveLength(1)
  })

  it('sends feedback with the current revision and recovers from a stale revision', async () => {
    const wrapper = mount(JudgmentWorkbench, { props: { personalSpaceId: 'space-a' } })
    await flushPromises()
    await wrapper.get('[data-feedback-reason]').setValue('Keep the owner in the loop.')
    await wrapper.get('[data-feedback="up"]').trigger('click')
    await flushPromises()

    expect(postJson).toHaveBeenCalledWith('/api/judgment/feedback', {
      personalSpaceId: 'space-a', decisionId: 'decision-a', vote: 'up',
      reason: 'Keep the owner in the loop.', expectedRevision: 2,
    })

    postJson.mockRejectedValueOnce({ status: 409 })
    await wrapper.get('[data-feedback="down"]').trigger('click')
    await flushPromises()
    expect(getJson.mock.calls.length).toBeGreaterThan(1)
    expect(wrapper.get('[role="alert"]').text()).toMatch(/changed|更新|重试/i)
  })

  it('has no title row of its own and puts refresh and review in the workbench toolbar', async () => {
    const target = document.createElement('div')
    document.body.append(target)
    const Host = defineComponent({ setup() {
      provideWorkbenchToolbarActions(ref(target))
      return () => h(JudgmentWorkbench, { personalSpaceId: 'space-a' })
    } })
    const wrapper = mount(Host)
    await flushPromises()

    expect(wrapper.find('h2').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('判断工作台')
    expect(wrapper.find('[data-action="review"]').exists()).toBe(false)
    const review = target.querySelector<HTMLButtonElement>('[data-action="review"]')!
    expect(review.textContent).toContain('运行一次判断')
    review.click()
    await flushPromises()
    expect(postJson).toHaveBeenCalledWith('/api/judgment/review', expect.objectContaining({ personalSpaceId: 'space-a' }))
    wrapper.unmount()
    target.remove()
  })

  it('offers 运行一次判断 as the one primary action of an empty workbench', async () => {
    getJson.mockReset().mockResolvedValue({ records: [] })
    const pending = deferred<{ records: unknown[]; remaining: number }>()
    postJson.mockReset().mockReturnValueOnce(pending.promise)
    const wrapper = mount(JudgmentWorkbench, { props: { personalSpaceId: 'space-a' } })
    await flushPromises()

    const empty = wrapper.get('[data-judgment-empty]')
    expect(empty.classes()).toContain('ui-empty')
    expect(empty.text()).toContain('没有需要人工处理的判断')
    expect(wrapper.findAll('[data-action="review"]')).toHaveLength(1)
    await empty.get('[data-action="review"]').trigger('click')
    expect(empty.get('[data-action="review"]').attributes('aria-busy')).toBe('true')
    expect(empty.text()).toContain('正在分析待处理事项')
    pending.resolve({ records: [record({ id: 'decision-new' })], remaining: 0 })
    await flushPromises()
    expect(wrapper.find('[data-judgment-empty]').exists()).toBe(false)
    expect(wrapper.findAll('[data-decision-card]')).toHaveLength(1)
    expect(wrapper.findAll('[data-action="review"]')).toHaveLength(1)
  })

  it('keeps the filter above a pending read or an error, so only the list is replaced', async () => {
    const pending = deferred<{ records: unknown[] }>()
    getJson.mockReset().mockReturnValueOnce(pending.promise)
    const wrapper = mount(JudgmentWorkbench, { props: { personalSpaceId: 'space-a' } })
    const order = (selector: string) => {
      const filter = wrapper.get('.judgment-filter').element
      return Boolean(filter.compareDocumentPosition(wrapper.get(selector).element) & Node.DOCUMENT_POSITION_FOLLOWING)
    }
    expect(order('.growth-loading')).toBe(true)
    pending.reject(new Error('Records are unavailable'))
    await flushPromises()
    expect(order('[role="alert"]')).toBe(true)
  })

  it('does not load or review without a real personal space', async () => {
    const wrapper = mount(JudgmentWorkbench, { props: { personalSpaceId: '' } })
    await flushPromises()
    expect(getJson).not.toHaveBeenCalled()
    expect(postJson).not.toHaveBeenCalled()
    expect(wrapper.get('[data-action="review"]').attributes('disabled')).toBeDefined()
  })

  it('clears private records and drafts immediately when the personal space changes', async () => {
    const first = deferred<{ records: unknown[] }>()
    const second = deferred<{ records: unknown[] }>()
    getJson.mockReset().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const wrapper = mount(JudgmentWorkbench, { props: { personalSpaceId: 'space-a' } })
    first.resolve({ records: [record({ id: 'private-a', title: 'Space A decision' })] })
    await flushPromises()
    expect(wrapper.text()).toContain('Space A decision')

    await wrapper.setProps({ personalSpaceId: 'space-b' })
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).not.toContain('Space A decision')
    second.reject(new Error('Space B is unavailable'))
    await flushPromises()

    expect(wrapper.text()).not.toContain('Space A decision')
    expect(wrapper.get('[role="alert"]').text()).toContain('Space B is unavailable')
  })

  it('ignores a feedback response from a previous personal space', async () => {
    const oldResponse = deferred<ReturnType<typeof record>>()
    getJson.mockReset().mockResolvedValue({ records: [record({ id: 'private-a', title: 'Space A decision' })] })
    postJson.mockReset().mockReturnValueOnce(oldResponse.promise)
    const wrapper = mount(JudgmentWorkbench, { props: { personalSpaceId: 'space-a' } })
    await flushPromises()
    await wrapper.get('[data-feedback="up"]').trigger('click')
    await wrapper.setProps({ personalSpaceId: 'space-b' })
    await wrapper.vm.$nextTick()
    oldResponse.resolve(record({ id: 'private-a', title: 'Space A response' }))
    await flushPromises()

    expect(wrapper.text()).not.toContain('Space A response')
    expect(wrapper.find('[data-feedback-saving]').exists()).toBe(false)
  })

  it('seeds persisted feedback reasons, preserves them on vote, and saves edits without changing the vote', async () => {
    const persisted = record({ feedback: { revision: 2, vote: 'up', reason: 'Keep context' } })
    getJson.mockReset().mockResolvedValue({ records: [persisted] })
    postJson.mockReset().mockImplementation(async (_url: string, body: Record<string, unknown>) => ({
      ...persisted,
      feedback: { revision: 3, vote: body.vote, reason: body.reason ?? '' },
    }))
    const wrapper = mount(JudgmentWorkbench, { props: { personalSpaceId: 'space-a' } })
    await flushPromises()

    await wrapper.get('[data-feedback="up"]').trigger('click')
    expect(postJson).toHaveBeenCalledWith('/api/judgment/feedback', expect.objectContaining({ vote: null, reason: 'Keep context' }))

    const editor = wrapper.get('[data-feedback-editor]')
    expect((editor.element as HTMLDetailsElement).open).toBe(false)
    await editor.get('[data-feedback-toggle]').trigger('click')
    await editor.get('[data-feedback-reason]').setValue('Use the current owner.')
    await editor.get('[data-save-reason]').trigger('click')
    await flushPromises()
    expect(postJson).toHaveBeenLastCalledWith('/api/judgment/feedback', expect.objectContaining({ vote: null, reason: 'Use the current owner.' }))

    await editor.get('[data-feedback-reason]').setValue('')
    await editor.get('[data-save-reason]').trigger('click')
    await flushPromises()
    expect(postJson).toHaveBeenLastCalledWith('/api/judgment/feedback', expect.objectContaining({ vote: null, reason: '' }))
  })

  it('shows actual source selection and keeps receipts and session IDs behind disclosure', async () => {
    getJson.mockReset().mockResolvedValue({ records: [record({
      client: 'claude_code', model: 'claude-3', selection: { executorId: 'executor-a', model: 'claude-3', client: 'claude_code' },
      execution: { status: 'failed', receipt: { reason: 'Permission required', detail: 'private detail' } },
      sessionId: '12345678-1234-1234-1234-123456789012', error: 'Permission required',
    })] })
    const wrapper = mount(JudgmentWorkbench, { props: { personalSpaceId: 'space-a' } })
    await flushPromises()

    expect(wrapper.text()).toContain('Claude Code')
    expect(wrapper.text()).toContain('claude-3')
    expect(wrapper.text()).toContain('executor-a')
    expect(wrapper.get('.judgment-record-meta').text()).not.toContain('12345678-1234-1234-1234-123456789012')
    const details = wrapper.get('[data-judgment-details]')
    expect((details.element as HTMLDetailsElement).open).toBe(false)
    await details.get('summary').trigger('click')
    expect(details.text()).toContain('Permission required')
    expect(details.text()).toContain('12345678-1234-1234-1234-123456789012')
  })

  it('uses familiar thumbs-up and thumbs-down feedback icons', async () => {
    const wrapper = mount(JudgmentWorkbench, { props: { personalSpaceId: 'space-a' } })
    await flushPromises()
    expect(wrapper.get('[data-feedback="up"]').text()).toContain('👍')
    expect(wrapper.get('[data-feedback="down"]').text()).toContain('👎')
    expect(wrapper.get('[data-feedback="up"]').attributes('aria-label')).toBeTruthy()
    expect(wrapper.get('[data-feedback="down"]').attributes('title')).toBeTruthy()
  })
})


describe('knowledge recovery fence in the workbench', () => {
  it.each(['read', 'review', 'feedback', 'undo'])('clears cached bodies after a %s refusal and retries only the read with inline loading', async operation => {
    getJson.mockReset().mockResolvedValue({ records: [record({ outcome: 'escalate', execution: { status: 'applied', receipt: { text: 'SYNTHETIC RECEIPT BODY' } },
      aiReview: { state: 'ai_reviewed', modelOutcome: 'approve', interceptions: [], gate: { status: 'passed', modelId: 'synthetic' } } })] })
    const failure = new ApiError('503', 503, JSON.stringify({ code: 'knowledge_recovery_pending' }))
    postJson.mockReset().mockRejectedValue(failure)
    const wrapper = mount(JudgmentWorkbench, { props: { personalSpaceId: 'space-a' } })
    await flushPromises()
    expect(wrapper.text()).toContain('SYNTHETIC RECEIPT BODY')
    if (operation === 'read') {
      getJson.mockRejectedValueOnce(failure)
      await wrapper.get('.judgment-workbench-actions button').trigger('click')
    } else await wrapper.get(operation === 'review' ? '[data-action="review"]' : operation === 'feedback' ? '[data-feedback="up"]' : '[data-action="undo"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain(t('common.errors.knowledgeRecoveryPending'))
    expect(wrapper.text()).not.toContain('SYNTHETIC RECEIPT BODY')
    expect(wrapper.find('[data-decision-card]').exists()).toBe(false)
    const pending = deferred<{ records: unknown[] }>()
    getJson.mockReturnValueOnce(pending.promise)
    await wrapper.get('.judgment-workbench-error button').trigger('click')
    expect(wrapper.getComponent(GrowthLoading).props('variant')).toBe('inline')
    pending.resolve({ records: [] }); await flushPromises()
    expect(wrapper.text()).not.toContain(t('common.errors.knowledgeRecoveryPending'))
    expect(postJson).toHaveBeenCalledTimes(operation === 'read' ? 0 : 1)
    wrapper.unmount()
  })
})


it('never restores receipt bodies from an older feedback response after a recovery refusal', async () => {
  getJson.mockReset().mockResolvedValueOnce({ records: [record()] })
    .mockRejectedValueOnce(new ApiError('503', 503, '{"code":"knowledge_recovery_pending"}'))
  const pendingFeedback = deferred<unknown>()
  postJson.mockReset().mockReturnValueOnce(pendingFeedback.promise)
  const wrapper = mount(JudgmentWorkbench, { props: { personalSpaceId: 'space-a' } })
  await flushPromises()
  await wrapper.get('[data-feedback="up"]').trigger('click')
  await wrapper.get('.judgment-workbench-actions button').trigger('click')
  await flushPromises()
  pendingFeedback.resolve(record({ summary: 'LATE SYNTHETIC BODY' }))
  await flushPromises()
  expect(wrapper.text()).not.toContain('LATE SYNTHETIC BODY')
  expect(wrapper.find('[data-decision-card]').exists()).toBe(false)
  expect(wrapper.text()).toContain(t('common.errors.knowledgeRecoveryPending'))
  wrapper.unmount()
})
