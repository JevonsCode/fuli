import { enableAutoUnmount, flushPromises, mount, RouterLinkStub } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import VisitRequestsPage from './VisitRequestsPage.vue'
import { stubServer, visitRequest } from './visit-request.spec-support'

enableAutoUnmount(afterEach)
beforeEach(() => setActivePinia(createPinia()))
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

const mountPage = () => mount(VisitRequestsPage, { global: { stubs: { RouterLink: RouterLinkStub, Breadcrumb: true } } })

describe('every request another computer sent', () => {
  it('says one plain sentence when there is none', async () => {
    stubServer({ 'GET /api/visit-requests': { requests: [], awaiting: { count: 0, newest: [] } } })
    const wrapper = mountPage()
    await flushPromises()
    expect(wrapper.get('[data-visit-list-empty]').text()).toBe('还没有另一台电脑请你做事。')
    expect(wrapper.get('.visit-list-card').classes()).not.toContain('is-filled')
    expect(wrapper.find('[data-visit-list-row]').exists()).toBe(false)
  })

  it('reads every state, not only the waiting ones', async () => {
    const { calls } = stubServer({ 'GET /api/visit-requests': { requests: [visitRequest({ state: 'kept' })], awaiting: { count: 0, newest: [] } } })
    const wrapper = mountPage()
    await flushPromises()
    const [url] = calls('GET /api/visit-requests')[0]!
    expect(new URL(String(url), 'http://console.invalid').searchParams.get('state')).toBeNull()
    expect(wrapper.find('[data-visit-list-empty]').exists()).toBe(false)
    expect(wrapper.get('.visit-list-card').classes()).toContain('is-filled')
    expect(wrapper.find('[data-visit-list-cut]').exists()).toBe(false)
  })

  it('says on the row why a request did not work', async () => {
    stubServer({ 'GET /api/visit-requests': { requests: [visitRequest({ state: 'failed', error: 'no_repository', reason: 'no_repository' })],
      awaiting: { count: 0, newest: [] } } })
    const wrapper = mountPage()
    await flushPromises()
    expect(wrapper.get('[data-visit-list-meta]').text())
      .toBe('Synthetic laptop 的 Sample lead · 这个项目共享的文件夹不是 Git 仓库，没法在副本里做。把共享的文件夹改成仓库所在的目录。')
  })

  it('says so when the read was cut at the newest 200', async () => {
    const requests = Array.from({ length: 200 }, (_, index) => visitRequest({ id: `visit-${index}`, state: 'kept' }))
    stubServer({ 'GET /api/visit-requests': { requests, awaiting: { count: 0, newest: [] } } })
    const wrapper = mountPage()
    await flushPromises()
    expect(wrapper.get('[data-visit-list-cut]').text()).toBe('只列出最近 200 条。')
  })
})
