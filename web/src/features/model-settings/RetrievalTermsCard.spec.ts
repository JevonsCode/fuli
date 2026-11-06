import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ getJson: vi.fn(), postJson: vi.fn() }))
vi.mock('@/api/client', async (importOriginal) => ({ ...await importOriginal<typeof import('@/api/client')>(), ...api }))

import { setLocale } from '@/i18n'
import type { PersonalProject } from '@/types'
import RetrievalTermsCard from './RetrievalTermsCard.vue'

const projects = [{ project_id: 'synthetic-project', scope_type: 'project', profile: { name: 'Synthetic' } }] as unknown as PersonalProject[]
const stats = { items: 120, with_terms: 20, missing: 100, roughTokens: 9000 }

afterEach(() => { api.getJson.mockReset(); api.postJson.mockReset() })

async function mountCard(state: Record<string, unknown>) {
  setLocale('zh-CN')
  api.getJson.mockResolvedValue({ readiness: 'ready', stats, trial: null, run: null, busy: null, ...state })
  const wrapper = mount(RetrievalTermsCard, { props: { projects } })
  await flushPromises()
  return wrapper
}

describe('RetrievalTermsCard', () => {
  it('counts what lacks terms for free and offers the 20-item self-test first', async () => {
    const wrapper = await mountCard({})
    expect(wrapper.find('[data-terms-missing]').text()).toBe('100 条还没有检索词，粗估补完约 9000 tokens。')
    expect(wrapper.find('[data-terms-test]').attributes('disabled')).toBeUndefined()
    expect(wrapper.find('[data-terms-fill]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('shows the measured gain, the cost and the advice, and fills or skips', async () => {
    const trial = { status: 'tested', sample: 20, before: 8, after: 17, advice: 'fill', tokens: { trial: 4200, perItem: 110, projected: 11000 } }
    const wrapper = await mountCard({ trial })
    expect(wrapper.find('[data-terms-trial]').text()).toContain('换个问法能找到 8 → 17 条')
    expect(wrapper.find('[data-terms-trial]').text()).toContain('补剩下 100 条约 11000 tokens')
    expect(wrapper.find('[data-advice="fill"]').text()).toBe('建议补')
    api.postJson.mockResolvedValue({ status: 'running', written: 0, tokens: 0 })
    await wrapper.find('[data-terms-fill]').trigger('click')
    await flushPromises()
    expect(api.postJson).toHaveBeenCalledWith('/api/retrieval-terms/fill', { personalProjectId: 'synthetic-project' }, expect.anything())
    await wrapper.find('[data-terms-decline]').trigger('click')
    expect(wrapper.find('[data-terms-trial]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('shows a running fill with a stop button and points to the switch when it is off', async () => {
    const running = await mountCard({ run: { status: 'running', written: 32, tokens: 3500 } })
    expect(running.find('[data-terms-filling]').text()).toBe('正在补：32/132 条，已用 3500 tokens')
    expect(running.find('[data-terms-stop]').exists()).toBe(true)
    running.unmount()
    const off = await mountCard({ readiness: 'not_allowed' })
    expect(off.find('[data-terms-note]').text()).toContain('打开「补检索词」')
    await off.find('[data-terms-open]').trigger('click')
    expect(off.emitted('edit')).toHaveLength(1)
    off.unmount()
  })
})
