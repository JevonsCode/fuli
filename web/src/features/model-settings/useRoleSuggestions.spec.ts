import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
const getJson = vi.hoisted(() => vi.fn())
vi.mock('@/api/client', async original => ({ ...(await original<typeof import('@/api/client')>()), getJson }))
import { ApiError } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { setLocale } from '@/i18n'
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
      ? '正在等待图谱确认删除记录，这部分内容暂时读不到。请稍后重试；如果一直这样，运行 `fuli migrate reconcile-knowledge`。'
      : 'Waiting for the graph to confirm deletion records; this content cannot be read yet. Try again later; if it stays this way, run `fuli migrate reconcile-knowledge`.')
    older.resolve({ suggestions: [entry] }); await oldRead; await flushPromises()
    expect(wrapper.text()).not.toContain(entry.hint)
    const retry = deferred<{ suggestions: RoleSuggestion[] }>()
    getJson.mockReturnValueOnce(retry.promise)
    await wrapper.get('button').trigger('click')
    expect(wrapper.getComponent(GrowthLoading).props('variant')).toBe('inline')
    expect(wrapper.text()).not.toContain(entry.hint)
    retry.resolve({ suggestions: [{ ...entry, hint: 'FRESH SAFE SUGGESTION' }] }); await flushPromises()
    expect(wrapper.text()).toContain('FRESH SAFE SUGGESTION')
    expect(wrapper.text()).not.toContain('fuli migrate reconcile-knowledge')
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
  expect(wrapper.text()).toContain('fuli migrate reconcile-knowledge')
  late.resolve({ suggestions: [bole] }); await pendingRead; await flushPromises()
  expect(wrapper.text()).not.toContain('SYNTHETIC SCORE REASON')
  expect(wrapper.text()).toContain('fuli migrate reconcile-knowledge')
  wrapper.unmount(); reader.stop()
})
