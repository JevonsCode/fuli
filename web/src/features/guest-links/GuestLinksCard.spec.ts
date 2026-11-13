import { DOMWrapper, flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getJson = vi.hoisted(() => vi.fn())
const postJson = vi.hoisted(() => vi.fn())
const deleteJson = vi.hoisted(() => vi.fn())
vi.mock('@/api/client', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/api/client')>()), getJson, postJson, deleteJson }))

import { setLocale } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import GuestLinksCard from './GuestLinksCard.vue'

// Synthetic links and an invented token; nothing here is a real address or secret.
const TOKEN = `fgl_${'x'.repeat(43)}`
const link = (id: string, lastUsedAt: string | null = null) => ({ id, projectId: 'project-a', label: `guest-${id}`,
  createdAt: '2026-11-01T08:00:00.000Z', expiresAt: '2026-11-08T08:00:00.000Z', lastUsedAt })
const status = { listening: true, addresses: ['192.168.31.8:2729'], problem: null }

function mountCard() {
  return mount(GuestLinksCard, { attachTo: document.body, props: { projectId: 'project-a' } })
}

const dialog = () => new DOMWrapper(document.querySelector<HTMLElement>('[data-guest-link-created]')!)

describe('GuestLinksCard', () => {
  beforeEach(() => {
    setLocale('zh-CN')
    setActivePinia(createPinia())
    for (const mock of [getJson, postJson, deleteJson]) mock.mockReset()
  })

  afterEach(() => { document.body.innerHTML = '' })

  it('lists live links with expiry and last use, and says the link stays on this network unencrypted', async () => {
    getJson.mockResolvedValue({ links: [link('aaaaaaaaaaaa', '2026-11-02T09:00:00.000Z'), link('bbbbbbbbbbbb')], ...status })
    const wrapper = mountCard()
    await flushPromises()
    expect(getJson.mock.calls[0][0]).toBe('/api/visitor-access/guest-links?projectId=project-a')
    const rows = wrapper.findAll('[data-guest-link]')
    expect(rows).toHaveLength(2)
    expect(rows[0].text()).toContain('上次使用')
    expect(rows[1].text()).toContain('还没用过')
    expect(wrapper.get('[data-guest-links-network]').text()).toBe('只在同一网络里能用；链接在这个网络里不加密传输。')
    wrapper.unmount()
  })

  it('creates a 7-day link in one click and offers its token only in the open dialog', async () => {
    getJson.mockResolvedValue({ links: [], ...status })
    postJson.mockResolvedValue({ link: link('cccccccccccc'), token: TOKEN, ...status })
    const wrapper = mountCard()
    await flushPromises()
    await wrapper.get('[data-guest-link-create]').trigger('click')
    await flushPromises()
    expect(postJson.mock.calls[0].slice(0, 2)).toEqual(['/api/visitor-access/guest-links', { projectId: 'project-a', days: 7 }])
    const sentence = dialog().get('[data-guest-link-sentence]').text()
    expect(sentence).toContain('http://192.168.31.8:2729/guest/1/search')
    expect(sentence).toContain(`Authorization: Bearer ${TOKEN}`)
    expect(sentence).toContain('先 GET http://192.168.31.8:2729/guest/1/card')
    expect(wrapper.text()).not.toContain(TOKEN)
    document.querySelector<HTMLElement>('[data-guest-link-created] button[aria-label]')?.click()
    await flushPromises()
    expect(document.body.textContent).not.toContain(TOKEN)
    wrapper.unmount()
  })

  it('says why a created link cannot be used yet instead of an address', async () => {
    getJson.mockResolvedValue({ links: [], listening: false, addresses: [], problem: null })
    postJson.mockResolvedValue({ link: link('dddddddddddd'), token: TOKEN, listening: false, addresses: [], problem: 'no_network' })
    const wrapper = mountCard()
    await flushPromises()
    await wrapper.get('[data-guest-link-create]').trigger('click')
    await flushPromises()
    expect(dialog().text()).toContain('这台电脑现在没连到局域网')
    expect(dialog().find('[data-guest-link-sentence]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('revokes in one click and confirms it in a toast', async () => {
    getJson.mockResolvedValueOnce({ links: [link('eeeeeeeeeeee')], ...status }).mockResolvedValueOnce({ links: [], ...status })
    deleteJson.mockResolvedValue({})
    const wrapper = mountCard()
    await flushPromises()
    await wrapper.get('[data-guest-link-revoke]').trigger('click')
    await flushPromises()
    expect(deleteJson.mock.calls[0][0]).toBe('/api/visitor-access/guest-links/eeeeeeeeeeee')
    expect(useConsoleStore().feedback?.message).toBe('已撤销访客链接，它马上失效')
    expect(wrapper.findAll('[data-guest-link]')).toHaveLength(0)
    wrapper.unmount()
  })
})
