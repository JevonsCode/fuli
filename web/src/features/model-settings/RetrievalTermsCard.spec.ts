import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ getJson: vi.fn(), postJson: vi.fn() }))
vi.mock('@/api/client', async (importOriginal) => ({ ...await importOriginal<typeof import('@/api/client')>(), ...api }))

import { setLocale } from '@/i18n'
import type { PersonalProject } from '@/types'
import RetrievalTermsCard from './RetrievalTermsCard.vue'

const projects = [{ project_id: 'synthetic-project', scope_type: 'project', profile: { name: 'Synthetic' } }] as unknown as PersonalProject[]
const stats = { items: 120, with_terms: 20, missing: 100, roughTokens: 9000 }
const tested = { status: 'tested', sample: 20, before: 8, after: 17, advice: 'fill', tokens: { trial: 4200, perItem: 110, projected: 11000 } }

const mounted: ReturnType<typeof mount>[] = []
afterEach(() => { mounted.splice(0).forEach(wrapper => wrapper.unmount()); api.getJson.mockReset(); api.postJson.mockReset() })

const answer = (state: Record<string, unknown>) => ({ readiness: 'ready', stats, trial: null, run: null, busy: null, ...state })
async function mountCard(state: Record<string, unknown>) {
  setLocale('zh-CN')
  api.getJson.mockResolvedValue(answer(state))
  const wrapper = mount(RetrievalTermsCard, { props: { projects, model: 'synthetic-chat', status: 'enabled' as const }, attachTo: document.body })
  mounted.push(wrapper)
  await flushPromises()
  return wrapper
}
const card = (wrapper: ReturnType<typeof mount>) => wrapper.get('[data-retrieval-terms]')

describe('RetrievalTermsCard', () => {
  it('says in one line what the project lacks, for free, and offers the 20-item self-test first', async () => {
    const wrapper = await mountCard({})
    expect(wrapper.get('[data-terms-summary]').text()).toBe('Synthetic · 100 条还没有检索词，粗估补完约 9000 tokens。')
    expect(card(wrapper).findAll('footer button').map(button => button.text())).toEqual(['查看详情', '先试 20 条'])
    expect(wrapper.get('[data-terms-test]').attributes('disabled')).toBeUndefined()
    // The card holds no project picker and no result: they are in the details.
    expect(card(wrapper).find('[data-terms-project]').exists()).toBe(false)
    expect(wrapper.find('[data-terms-dialog]').exists()).toBe(false)
  })

  it('runs the self-test from the card and opens the details with the measured gain, the cost and the advice; fills or skips there', async () => {
    const wrapper = await mountCard({})
    api.postJson.mockResolvedValue(tested)
    api.getJson.mockResolvedValue(answer({ trial: tested }))
    await wrapper.get('[data-terms-test]').trigger('click')
    await flushPromises()
    expect(api.postJson).toHaveBeenCalledWith('/api/retrieval-terms/trial', { personalProjectId: 'synthetic-project' }, expect.anything())
    const dialog = wrapper.get('[data-terms-dialog]')
    expect(dialog.get('[data-terms-trial]').text()).toContain('换个问法能找到 8 → 17 条')
    expect(dialog.get('[data-terms-trial]').text()).toContain('补剩下 100 条约 11000 tokens')
    expect(dialog.get('[data-advice="fill"]').text()).toBe('建议补')
    api.postJson.mockResolvedValue({ status: 'running', written: 0, tokens: 0 })
    await dialog.get('[data-terms-fill]').trigger('click')
    await flushPromises()
    expect(api.postJson).toHaveBeenCalledWith('/api/retrieval-terms/fill', { personalProjectId: 'synthetic-project' }, expect.anything())
    await dialog.get('[data-terms-decline]').trigger('click')
    expect(dialog.find('[data-terms-trial]').exists()).toBe(false)
  })

  it('shows a running fill with a stop button and points to the switch when it is off', async () => {
    const running = await mountCard({ run: { status: 'running', written: 32, tokens: 3500 } })
    expect(running.get('[data-terms-summary]').text()).toBe('Synthetic · 正在补：32/132 条，已用 3500 tokens')
    expect(card(running).findAll('footer button').map(button => button.text())).toEqual(['查看详情', '停止'])
    const off = await mountCard({ readiness: 'not_allowed' })
    expect(off.get('[data-terms-note]').text()).toContain('打开「补检索词」')
    expect(off.find('[data-terms-details]').exists()).toBe(false)
    await off.get('[data-terms-open]').trigger('click')
    expect(off.emitted('edit')).toHaveLength(1)
  })

  it('a fill the model stopped answering says so, with 测试连接 for Astro and 重试 that fills again', async () => {
    const wrapper = await mountCard({ run: { status: 'model_failed', written: 12, tokens: 900 } })
    const failure = wrapper.get('[data-terms-failed]')
    expect(failure.get('[data-model-failure-text]').text()).toBe('Synthetic · 上次补到 12 条时模型没回答，停了。')
    expect(card(wrapper).findAll('footer button').map(button => button.text())).toEqual(['查看详情', '重试'])
    api.postJson.mockResolvedValue({ ok: true, receipt: { status: 'completed', actualModel: 'synthetic-chat' } })
    await failure.get('[data-model-check]').trigger('click')
    await flushPromises()
    expect(api.postJson).toHaveBeenCalledWith('/api/model-backends/roles/assistant/check', {})
    expect(failure.get('[data-model-failure-text]').text()).toBe('连接正常，synthetic-chat 回答了。')
    expect(wrapper.emitted('checked')).toHaveLength(1)
    api.postJson.mockResolvedValue({ status: 'running', written: 12, tokens: 900 })
    await wrapper.get('[data-terms-retry]').trigger('click')
    await flushPromises()
    expect(api.postJson).toHaveBeenLastCalledWith('/api/retrieval-terms/fill', { personalProjectId: 'synthetic-project' }, expect.anything())
  })

  it('a read that failed says why and reads again on 重试', async () => {
    setLocale('zh-CN')
    api.getJson.mockRejectedValueOnce(new Error('synthetic failure')).mockResolvedValue(answer({}))
    const wrapper = mount(RetrievalTermsCard, { props: { projects, model: 'synthetic-chat', status: 'enabled' as const } })
    mounted.push(wrapper)
    await flushPromises()
    expect(wrapper.get('[data-terms-error]').text()).toBe('synthetic failure')
    await wrapper.get('[data-terms-reload]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-terms-error]').exists()).toBe(false)
    expect(wrapper.get('[data-terms-summary]').text()).toContain('100 条还没有检索词')
  })
})
