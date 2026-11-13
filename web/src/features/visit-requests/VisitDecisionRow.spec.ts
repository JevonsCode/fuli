import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useConsoleStore } from '@/stores/console'
import VisitDecisionRow from './VisitDecisionRow.vue'
import { stubServer, visitRequest } from './visit-request.spec-support'

enableAutoUnmount(afterEach)
beforeEach(() => setActivePinia(createPinia()))
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

const list = { requests: [], awaiting: { count: 0, newest: [] } }

describe('a request from another computer in 等你拍板', () => {
  it('shows who asks, the title and a small risk badge, and opens the card from the title', async () => {
    stubServer({})
    const wrapper = mount(VisitDecisionRow, { props: { item: visitRequest({ risk: { level: 'high', flags: ['network'] } }) } })
    expect(wrapper.get('[data-visit-open]').text()).toBe('Fix the sample typo')
    expect(wrapper.text()).toContain('Synthetic laptop 的 Sample lead')
    expect(wrapper.get('[data-visit-risk]').text()).toBe('风险高')
    await wrapper.get('[data-visit-open]').trigger('click')
    expect(wrapper.emitted('open')).toEqual([['visit-1']])
  })

  it('approves with one click, says so in the toast with a link, and reads 等你拍板 again', async () => {
    const { calls } = stubServer({ 'POST /api/visit-requests/visit-1/approve': { request: visitRequest({ state: 'approved' }) },
      'GET /api/visit-requests': list })
    const wrapper = mount(VisitDecisionRow, { props: { item: visitRequest() } })
    await wrapper.get('[data-visit-approve]').trigger('click')
    await flushPromises()
    expect(calls('POST /api/visit-requests/visit-1/approve')).toHaveLength(1)
    expect(useConsoleStore().feedback).toMatchObject({ tone: 'success', message: '已批准「Fix the sample typo」',
      link: { to: '/visit-requests?item=visit/visit-1' } })
    expect(calls('GET /api/visit-requests')).toHaveLength(1)
  })

  it('declines with one click and no reason, without a second confirmation', async () => {
    const { calls } = stubServer({ 'POST /api/visit-requests/visit-1/decline': { request: visitRequest({ state: 'declined' }) },
      'GET /api/visit-requests': list })
    const wrapper = mount(VisitDecisionRow, { props: { item: visitRequest() } })
    await wrapper.get('[data-visit-decline]').trigger('click')
    await flushPromises()
    const [, init] = calls('POST /api/visit-requests/visit-1/decline')[0]!
    expect(JSON.parse(String(init?.body))).toEqual({})
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(useConsoleStore().feedback?.message).toBe('已拒绝「Fix the sample typo」')
  })

  it('shows a held result as needing a look and opens its review instead of deciding', async () => {
    stubServer({})
    const wrapper = mount(VisitDecisionRow, { props: { item: visitRequest({ state: 'awaiting_review', review: 'held' }) } })
    expect(wrapper.get('[data-visit-review]').text()).toBe('需要你看一下')
    expect(wrapper.find('[data-visit-approve]').exists()).toBe(false)
    await wrapper.get('[data-visit-look]').trigger('click')
    expect(wrapper.emitted('open')).toEqual([['visit-1']])
  })
})
