import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useConsoleStore } from '@/stores/console'
import { optionSelectStubs } from '@/test-support/OptionSelectStub'
import { GUEST_KEY, PEER_KEY, stubServer } from './visit-request.spec-support'

enableAutoUnmount(afterEach)
// The modes are read once per page; each test starts from a fresh read.
beforeEach(() => { setActivePinia(createPinia()); vi.resetModules() })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

async function mountSelect(requesterKey: string) {
  // The fresh module graph has its own i18n, set to the language the specs read.
  const { setLocale } = await import('@/i18n')
  setLocale('zh-CN', { persist: false })
  const { default: RequesterModeSelect } = await import('./RequesterModeSelect.vue')
  const wrapper = mount(RequesterModeSelect, { props: { requesterKey, label: 'Synthetic laptop' }, global: { stubs: optionSelectStubs } })
  await flushPromises()
  return wrapper
}
const optionValues = (wrapper: Awaited<ReturnType<typeof mountSelect>>) =>
  wrapper.findAll('option').map(option => option.attributes('value')).filter(Boolean)

describe('the trust a requester gets', () => {
  it('offers four modes to a paired computer and shows the one it has', async () => {
    stubServer({ 'GET /api/visitor-access/requesters': { defaultMode: 'plan', requesters: [{ key: PEER_KEY, kind: 'peer',
      label: 'Synthetic laptop', mode: 'auto', ownDevice: false, modeUpdatedAt: '2026-11-14T08:00:00.000Z' }] } })
    const wrapper = await mountSelect(PEER_KEY)
    expect(optionValues(wrapper)).toEqual(['ask_only', 'plan', 'auto', 'trusted'])
    expect((wrapper.get('select').element as HTMLSelectElement).value).toBe('auto')
  })

  it('shows a guest link as 只能问 in words, with no control to change it', async () => {
    stubServer({ 'GET /api/visitor-access/requesters': { defaultMode: 'plan', requesters: [] } })
    const wrapper = await mountSelect(GUEST_KEY)
    expect(wrapper.find('select').exists()).toBe(false)
    expect(wrapper.get('[data-requester-mode-fixed]').text()).toBe('只能问')
  })

  it('shows 计划 for a paired computer whose mode was never set', async () => {
    stubServer({ 'GET /api/visitor-access/requesters': { defaultMode: 'plan', requesters: [] } })
    const wrapper = await mountSelect(PEER_KEY)
    expect((wrapper.get('select').element as HTMLSelectElement).value).toBe('plan')
  })

  it('applies a change at once and names the computer in the toast with what it did to open requests', async () => {
    const { calls } = stubServer({
      'GET /api/visitor-access/requesters': { defaultMode: 'plan', requesters: [] },
      [`PUT /api/visitor-access/requesters/${encodeURIComponent(PEER_KEY)}/mode`]: {
        requester: { key: PEER_KEY, kind: 'peer', label: 'Synthetic laptop', mode: 'ask_only', ownDevice: false, modeUpdatedAt: '2026-11-14T09:00:00.000Z' },
        effects: { cancelled: ['visit-1', 'visit-2'], returned: [] } },
      'GET /api/visit-requests': { requests: [], awaiting: { count: 0, newest: [] } },
    })
    const wrapper = await mountSelect(PEER_KEY)
    await wrapper.get('select').setValue('ask_only')
    await flushPromises()
    const [, init] = calls(`PUT /api/visitor-access/requesters/${encodeURIComponent(PEER_KEY)}/mode`)[0]!
    expect(JSON.parse(String(init?.body))).toEqual({ mode: 'ask_only', label: 'Synthetic laptop' })
    expect(useConsoleStore().feedback).toMatchObject({ tone: 'success', message: '已把 Synthetic laptop 改成「只能问」，取消了 2 件',
      link: { to: '/visit-requests' } })
    expect(wrapper.emitted('changed')).toHaveLength(1)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  const requesters = (mode: string) => ({ defaultMode: 'plan', requesters: [{ key: PEER_KEY, kind: 'peer',
    label: 'Synthetic laptop', mode, ownDevice: mode === 'trusted', modeUpdatedAt: '2026-11-14T08:00:00.000Z' }] })

  it('reads the modes again when the window is looked at again, so another window’s change shows', async () => {
    const routes: Record<string, unknown> = { 'GET /api/visitor-access/requesters': requesters('plan') }
    const { calls } = stubServer(routes)
    const wrapper = await mountSelect(PEER_KEY)
    expect((wrapper.get('select').element as HTMLSelectElement).value).toBe('plan')
    // Another window marked this computer 完全信任.
    routes['GET /api/visitor-access/requesters'] = requesters('trusted')
    window.dispatchEvent(new Event('focus'))
    await flushPromises()
    // (Earlier specs' module copies listen too, so only a lower bound is exact here.)
    expect(calls('GET /api/visitor-access/requesters').length).toBeGreaterThanOrEqual(2)
    expect((wrapper.get('select').element as HTMLSelectElement).value).toBe('trusted')
  })

  it('choosing the mode already shown reads the modes again instead of doing nothing', async () => {
    const routes: Record<string, unknown> = { 'GET /api/visitor-access/requesters': requesters('plan') }
    const { calls } = stubServer(routes)
    const wrapper = await mountSelect(PEER_KEY)
    // This window still shows 计划 while another one set 完全信任; the owner picks 计划 to be sure.
    routes['GET /api/visitor-access/requesters'] = requesters('trusted')
    await wrapper.get('select').setValue('plan')
    await flushPromises()
    expect(calls(`PUT /api/visitor-access/requesters/${encodeURIComponent(PEER_KEY)}/mode`)).toHaveLength(0)
    expect((wrapper.get('select').element as HTMLSelectElement).value).toBe('trusted')
    // Now the stale mode is gone, the same choice is a real change and is sent.
    routes[`PUT /api/visitor-access/requesters/${encodeURIComponent(PEER_KEY)}/mode`] = {
      requester: { key: PEER_KEY, kind: 'peer', label: 'Synthetic laptop', mode: 'plan', ownDevice: false, modeUpdatedAt: '2026-11-14T09:00:00.000Z' },
      effects: { cancelled: [], returned: [] } }
    await wrapper.get('select').setValue('plan')
    await flushPromises()
    expect(calls(`PUT /api/visitor-access/requesters/${encodeURIComponent(PEER_KEY)}/mode`)).toHaveLength(1)
    expect((wrapper.get('select').element as HTMLSelectElement).value).toBe('plan')
  })
})
