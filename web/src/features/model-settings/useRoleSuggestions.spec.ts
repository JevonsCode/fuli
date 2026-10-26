import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, effectScope, nextTick, ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
const getJson = vi.hoisted(() => vi.fn())
vi.mock('@/api/client', async original => ({ ...(await original<typeof import('@/api/client')>()), getJson }))
import { ApiError } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { setLocale, t } from '@/i18n'
import RoleSuggestions from './RoleSuggestions.vue'
import { useRoleSuggestions } from './useRoleSuggestions'
import type { RoleSuggestion } from './suggestions'
const entry: RoleSuggestion = { id: 1, at: '2026-10-24T00:00:00Z', role: 'assistant', operation: 'project_candidate',
  personalSpaceId: 'synthetic-space', personalProjectId: null, subject: {}, status: 'suggested', hint: 'SYNTHETIC PRIVATE SUGGESTION',
  requestId: 'synthetic', evidenceVersion: 'synthetic', gate: { status: 'suggestion_only', role: 'assistant', operation: 'project_candidate' },
  modelReceipt: { requestedModel: null, actualModel: null } }
const blocked = () => new ApiError('generic server error', 503, '{"code":"knowledge_recovery_pending"}')
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
beforeEach(() => { getJson.mockReset(); setLocale('zh-CN', { persist: false }) })

describe('role suggestions recovery fence', () => {
  it.each(['zh-CN', 'en-US'] as const)('clears cached text, ignores a late read, and retries with inline loading in %s', async locale => {
    setLocale(locale, { persist: false })
    const reader = useRoleSuggestions()
    const host = defineComponent({ components: { RoleSuggestions }, setup: () => reader,
      template: '<RoleSuggestions :entries="entries" :loading="loading" :error="error" @retry="load" />' })
    const wrapper = mount(host)
    getJson.mockResolvedValueOnce({ suggestions: [entry] })
    await reader.load(); await flushPromises()
    expect(wrapper.text()).toContain(entry.hint)
    const older = deferred<{ suggestions: RoleSuggestion[] }>()
    getJson.mockReturnValueOnce(older.promise).mockRejectedValueOnce(blocked())
    const oldRead = reader.load(); await reader.load(); await flushPromises()
    expect(wrapper.text()).not.toContain(entry.hint)
    expect(wrapper.text()).toContain(locale === 'zh-CN'
      ? '正在等待图谱确认删除记录，这部分内容暂时读不到。FULI 正在自动重新核对，请稍后再试。'
      : 'Waiting for the graph to confirm deletion records; this content cannot be read yet. FULI is checking again by itself; try again in a moment.')
    older.resolve({ suggestions: [entry] }); await oldRead; await flushPromises()
    expect(wrapper.text()).not.toContain(entry.hint)
    const retry = deferred<{ suggestions: RoleSuggestion[] }>()
    getJson.mockReturnValueOnce(retry.promise)
    await wrapper.get('button').trigger('click')
    expect(wrapper.getComponent(GrowthLoading).props('variant')).toBe('inline')
    expect(wrapper.text()).not.toContain(entry.hint)
    retry.resolve({ suggestions: [{ ...entry, hint: 'FRESH SAFE SUGGESTION' }] }); await flushPromises()
    expect(wrapper.text()).toContain('FRESH SAFE SUGGESTION')
    expect(wrapper.text()).not.toContain(t('common.errors.knowledgeRecoveryPending'))
    wrapper.unmount(); reader.stop()
  })
  it('ignores a late failure and completion after a newer read or stop', async () => {
    const reader = useRoleSuggestions()
    const older = deferred<{ suggestions: RoleSuggestion[] }>()
    getJson.mockReturnValueOnce(older.promise).mockResolvedValueOnce({ suggestions: [entry] })
    const oldRead = reader.load(); await reader.load(); older.reject(blocked()); await oldRead
    expect(reader.error.value).toBe('')
    expect(reader.entries.value).toEqual([entry])
    const late = deferred<{ suggestions: RoleSuggestion[] }>()
    getJson.mockReturnValueOnce(late.promise)
    const stoppedRead = reader.load(); reader.stop(); late.resolve({ suggestions: [] }); await stoppedRead
    expect(reader.entries.value).toEqual([entry])
    expect(reader.loading.value).toBe(false)
  })
})


it('a score-card gate refusal clears suggestions and invalidates an overlapping parent read', async () => {
  const bole: RoleSuggestion = { ...entry, role: 'bole', subject: { agentId: 'synthetic-agent' }, suggestion: { action: 'coach', reason: 'SYNTHETIC SCORE REASON' } }
  const late = deferred<{ suggestions: RoleSuggestion[] }>()
  let suggestionReads = 0
  getJson.mockImplementation(async (url: string) => {
    if (url.includes('/score-card')) throw blocked()
    if (url === '/api/model-backends/suggestions') return ++suggestionReads === 1 ? { suggestions: [bole] } : late.promise
    return { agentId: 'synthetic-agent', personalSpaceId: 'synthetic-space', profile: { name: 'Synthetic Agent' } }
  })
  const reader = useRoleSuggestions()
  const host = defineComponent({ components: { RoleSuggestions }, setup: () => reader,
    template: '<RoleSuggestions :entries="entries" :loading="loading" :error="error" @retry="load" @recovery-pending="blockForRecovery" />' })
  const wrapper = mount(host, { global: { stubs: { RouterLink: { template: '<span><slot /></span>' } } } })
  await reader.load(); await flushPromises()
  expect(wrapper.text()).toContain('SYNTHETIC SCORE REASON')
  const pendingRead = reader.load()
  await wrapper.get('[data-suggestion-action]').trigger('click'); await flushPromises()
  expect(wrapper.text()).not.toContain('SYNTHETIC SCORE REASON')
  expect(wrapper.text()).toContain(t('common.errors.knowledgeRecoveryPending'))
  late.resolve({ suggestions: [bole] }); await pendingRead; await flushPromises()
  expect(wrapper.text()).not.toContain('SYNTHETIC SCORE REASON')
  expect(wrapper.text()).toContain(t('common.errors.knowledgeRecoveryPending'))
  wrapper.unmount(); reader.stop()
})

describe('Tonborg suggestions follow the proof and the space', () => {
  const review = { id: 'synthetic-judgment', createdAt: '2026-10-24T00:00:00Z', personalSpaceId: 'space-a', personalProjectId: null,
    target: 'entity:synthetic', title: 'SYNTHETIC PRIVATE TITLE', summary: 'SYNTHETIC PRIVATE SUMMARY', confidence: 0.5,
    aiReview: { state: 'ai_suggested' as const, modelOutcome: 'approve' as const, interceptions: [], gate: { status: 'not_passed' as const, reason: null, modelId: null } },
    model: 'synthetic-model', client: null, judgedBy: null }
  const reads = () => getJson.mock.calls.map(([url, options]) => ({ url: String(url), signal: (options as { signal: AbortSignal }).signal }))
    .filter(call => call.url.startsWith('/api/judgment/suggestions'))
  const answer = (tonborg: () => Promise<unknown>) =>
    getJson.mockImplementation((url: string) => url.startsWith('/api/judgment') ? tonborg() : Promise.resolve({ suggestions: [] }))

  it('drops a shown list when a refresh is refused or fails, and says so', async () => {
    answer(async () => ({ suggestions: [review] }))
    const reader = useRoleSuggestions('space-a')
    await reader.load()
    expect(reader.reviews.value).toEqual([review])
    answer(async () => { throw new ApiError('HTTP 403', 403, '{"code":"human_review_proof_required"}') })
    await reader.load()
    expect(reader.reviews.value).toBeNull()
    expect(reader.reviewsError.value).not.toBe('')
    // A transient failure in the same space drops the list too, with its error.
    answer(async () => ({ suggestions: [review] }))
    await reader.load()
    answer(async () => { throw new TypeError('Failed to fetch') })
    await reader.load()
    expect([reader.reviews.value, reader.reviewsError.value]).toEqual([null, 'Failed to fetch'])
    reader.stop()
  })

  it('cancels the read and drops the list when the space is lost or changes, and reads a new space', async () => {
    const space = ref('space-a')
    const pending = deferred<{ suggestions: unknown[] }>()
    answer(() => pending.promise)
    const scope = effectScope()
    const reader = scope.run(() => useRoleSuggestions(space))!
    const first = reader.load()
    expect(reads().map(call => call.url)).toEqual(['/api/judgment/suggestions?personalSpaceId=space-a'])
    space.value = ''
    await nextTick()
    expect(reads()[0]!.signal.aborted).toBe(true)
    expect([reader.reviews.value, reader.reviewsLoading.value]).toEqual([null, false])
    pending.resolve({ suggestions: [review] }); await first; await flushPromises()
    expect(reader.reviews.value).toBeNull()

    answer(async () => ({ suggestions: [{ ...review, personalSpaceId: 'space-b' }] }))
    space.value = 'space-b'
    await flushPromises()
    expect(reads().at(-1)!.url).toBe('/api/judgment/suggestions?personalSpaceId=space-b')
    expect(reader.reviews.value?.[0]?.personalSpaceId).toBe('space-b')
    answer(() => new Promise(() => {}))
    void reader.load()
    space.value = 'space-c'
    await nextTick()
    expect(reader.reviews.value).toBeNull()
    expect(reads().filter(call => call.url.endsWith('space-b')).at(-1)!.signal.aborted).toBe(true)
    scope.stop(); reader.stop()
  })
})
