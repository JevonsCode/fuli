import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { setLocale } from '@/i18n'
import CornerNotices from '@/layouts/CornerNotices.vue'
import cornerSource from '@/layouts/CornerNotices.vue?raw'
import { npmCopies } from '@/features/npm-copies/npm-copies'
import noticeSource from './WhatsNewNotice.vue?raw'
import WhatsNewNotice from './WhatsNewNotice.vue'
import { whatsNew } from './whats-new'

// Synthetic versions and lines only: no FULI is called, nothing on this computer is read.
const status = (notice: { skipped: number } | null, lines: { zh: string[]; en: string[] } | null = {
  zh: ['记忆会自己长大了，你只管干活。', '按钮不再乱跑。'],
  en: ['Memory grows by itself now; you just work.', 'Buttons stop wandering.'],
}) => ({
  version: '0.30.0', lines, releaseUrl: 'https://github.com/JevonsCode/fuli/releases/tag/v0.30.0',
  notice: notice && { ...notice, releasesUrl: 'https://github.com/JevonsCode/fuli/releases' },
})
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

function server(current: ReturnType<typeof status>) {
  const fetch = vi.fn(async (url: string, init?: RequestInit) =>
    json(init?.method === 'PUT' ? { ...current, notice: null } : current))
  vi.stubGlobal('fetch', fetch)
  return fetch
}

beforeEach(() => { Object.assign(whatsNew, { shown: null, closed: false }); setLocale('zh-CN', { persist: false }) })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.innerHTML = '' })

it('says once what is new: the title, the first line, and it marks the version seen right away', async () => {
  const fetch = server(status({ skipped: 0 }))
  const wrapper = mount(WhatsNewNotice, { attachTo: document.body })
  await flushPromises()
  expect(wrapper.get('[data-whats-new-title]').text()).toBe('更新到 0.30.0 了')
  expect(wrapper.get('[data-whats-new-text]').text()).toBe('记忆会自己长大了，你只管干活。')
  expect(wrapper.find('[data-whats-new-skipped]').exists()).toBe(false)
  const put = fetch.mock.calls.find(([, init]) => init?.method === 'PUT')
  expect(put?.[0]).toBe('/api/system/whats-new/seen')
  expect(JSON.parse(String(put?.[1]?.body))).toEqual({ version: '0.30.0' })
})

it('speaks the console language', async () => {
  setLocale('en-US', { persist: false })
  server(status({ skipped: 0 }))
  const wrapper = mount(WhatsNewNotice, { attachTo: document.body })
  await flushPromises()
  expect(wrapper.get('[data-whats-new-title]').text()).toBe('Updated to 0.30.0')
  expect(wrapper.get('[data-whats-new-text]').text()).toBe('Memory grows by itself now; you just work.')
})

it('查看详情 opens every line and the GitHub release; ✕ closes the notice', async () => {
  server(status({ skipped: 0 }))
  const wrapper = mount(WhatsNewNotice, { attachTo: document.body })
  await flushPromises()
  await wrapper.get('[data-whats-new-details]').trigger('click')
  const lines = document.querySelectorAll('[data-whats-new-lines] li')
  expect([...lines].map(line => line.textContent)).toEqual(['记忆会自己长大了，你只管干活。', '按钮不再乱跑。'])
  const release = document.querySelector<HTMLAnchorElement>('[data-whats-new-release]')
  expect(release?.getAttribute('href')).toBe('https://github.com/JevonsCode/fuli/releases/tag/v0.30.0')
  expect(release?.textContent?.trim()).toBe('在 GitHub 上看这个版本')
  await wrapper.get('[data-whats-new-close]').trigger('click')
  expect(wrapper.find('[data-whats-new]').exists()).toBe(false)
})

it('skipped versions: only the latest lines, with a link saying how many came between', async () => {
  server(status({ skipped: 3 }))
  const wrapper = mount(WhatsNewNotice, { attachTo: document.body })
  await flushPromises()
  const link = wrapper.get('[data-whats-new-skipped]')
  expect(link.text()).toBe('中间还有 3 个版本')
  expect(link.attributes('href')).toBe('https://github.com/JevonsCode/fuli/releases')
})

it('says nothing when it was seen, on a new installation, or for a version without lines', async () => {
  for (const current of [status(null), status({ skipped: 0 }, null)]) {
    Object.assign(whatsNew, { shown: null, closed: false })
    const fetch = server(current)
    const wrapper = mount(WhatsNewNotice)
    await flushPromises()
    expect(wrapper.find('[data-whats-new]').exists()).toBe(false)
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false)
    wrapper.unmount()
  }
})

it('stacks above the npm copy notice in one column over the dock, never at the top', async () => {
  setActivePinia(createPinia())
  Object.assign(npmCopies, { copies: [], loaded: false, removing: null, failed: {} })
  const copy = { packageRoot: '/synthetic/lib/node_modules/fuli-context', version: '0.20.0', shellCommands: ['fl'],
    removeCommand: 'npm uninstall --global fuli-context', noticeDismissed: false, otherDataDir: null, newer: false }
  vi.stubGlobal('fetch', vi.fn(async (url: string) => json(url === '/api/system/npm-copies' ? { copies: [copy] } : status({ skipped: 0 }))))
  const wrapper = mount(CornerNotices, { global: { stubs: { RouterLink: true } } })
  await flushPromises()
  const column = wrapper.get('[data-corner-notices]').element
  // Both notices are in the one column, what is new above the npm copy.
  const order = [...column.querySelectorAll('[data-whats-new], [data-npm-copy-notice]')].map(node => node.hasAttribute('data-whats-new') ? 'whats-new' : 'npm')
  expect(order).toEqual(['whats-new', 'npm'])
  // The column is placed once, above the dock; the notices in it never position themselves.
  expect(cornerSource).toMatch(/position: fixed; bottom: var\(--dock-clearance\)/)
  expect(noticeSource).not.toMatch(/position:\s*fixed/)
  expect(noticeSource).toMatch(/var\(--surface-dock\)/)
  expect(noticeSource).toMatch(/var\(--shadow-glass\)/)
  expect(noticeSource).toMatch(/\.whats-new-link \{[^}]*user-select: none/)
})
