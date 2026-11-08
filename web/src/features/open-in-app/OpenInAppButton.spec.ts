import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setLocale } from '@/i18n'
import shellSource from '@/layouts/AppShell.vue?raw'
import OpenInAppButton from './OpenInAppButton.vue'
import { fuliLinkFor } from './open-in-app'

// Synthetic pages only: no FULI is called, nothing on this computer is read.
// The links must pass desktop/flutter FuliLink.parse (console_navigation_test.dart
// parses the same shapes).

function stubServer(opensLinks: boolean | 'fails') {
  const fetch = vi.fn(async (_url: string) => opensLinks === 'fails'
    ? new Response('{}', { status: 500 })
    : new Response(JSON.stringify({ opensLinks }), { status: 200, headers: { 'content-type': 'application/json' } }))
  vi.stubGlobal('fetch', fetch)
  return fetch
}

async function mountAt(path: string) {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:rest(.*)*', component: { template: '<div />' } }] })
  await router.push(path)
  const wrapper = mount(OpenInAppButton, { global: { plugins: [router] } })
  await flushPromises()
  return { wrapper, router }
}

beforeEach(() => setLocale('zh-CN', { persist: false }))
afterEach(() => {
  vi.unstubAllGlobals()
  delete (window as { fuliDesktopClient?: unknown }).fuliDesktopClient
})

describe('OpenInAppButton', () => {
  it('links the page this tab shows, without its hash, to the client', async () => {
    const fetch = stubServer(true)
    const { wrapper, router } = await mountAt('/knowledge/items?tab=recent#top')
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/system/desktop-client'])
    const link = wrapper.get('a[data-open-in-app]')
    expect(link.attributes('href')).toBe('fuli://knowledge/items?tab=recent')
    expect(link.attributes('aria-label')).toBe('在客户端打开')
    expect(link.attributes('title')).toBe('在客户端打开')
    expect(link.attributes('data-slot')).toBe('button')
    expect(link.attributes('data-size')).toBe('icon-md')
    await router.push('/settings?tab=system')
    expect(wrapper.get('a').attributes('href')).toBe('fuli://settings?tab=system')
    setLocale('en-US', { persist: false })
    await flushPromises()
    expect(wrapper.get('a').attributes('aria-label')).toBe('Open in app')
  })

  it('is not offered while the client does not open fuli:// links, or cannot say', async () => {
    stubServer(false)
    expect((await mountAt('/inbox')).wrapper.find('a').exists()).toBe(false)
    stubServer('fails')
    expect((await mountAt('/inbox')).wrapper.find('a').exists()).toBe(false)
  })

  it('is not offered inside the client, which never asks the server', async () => {
    const fetch = stubServer(true)
    ;(window as { fuliDesktopClient?: unknown }).fuliDesktopClient = Object.freeze({ platform: 'windows' })
    expect((await mountAt('/inbox')).wrapper.find('a').exists()).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('stands first among the top bar actions, so nothing moves when it appears', () => {
    expect(shellSource).toMatch(/<div class="app-actions">\s*(?:<!--[^]*?-->\s*)?<OpenInAppButton \/>/)
  })
})

describe('fuliLinkFor', () => {
  it('encodes each path segment and the query as plain link text', () => {
    expect(fuliLinkFor('/knowledge/%E9%A1%B9%E7%9B%AE', { q: 'a b', tag: ['x', 'y'], flag: null }))
      .toBe('fuli://knowledge/%E9%A1%B9%E7%9B%AE?q=a%20b&tag=x&tag=y&flag')
    expect(fuliLinkFor('/agents/space/agent-1/', {})).toBe('fuli://agents/space/agent-1')
    expect(fuliLinkFor('/', {})).toBe('fuli://')
  })

  it('gives no link the client would refuse', () => {
    expect(fuliLinkFor('/a%2Fb', {})).toBeNull()
    expect(fuliLinkFor('/%2E%2E/settings', {})).toBeNull()
    expect(fuliLinkFor('/%E0%A4%A', {})).toBeNull()
    expect(fuliLinkFor('/inbox', { q: 'x'.repeat(2100) })).toBeNull()
  })
})
