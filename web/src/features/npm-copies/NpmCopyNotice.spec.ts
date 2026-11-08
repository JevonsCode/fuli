import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { useConsoleStore } from '@/stores/console'
import NpmCopyNotice from './NpmCopyNotice.vue'
import { npmCopies } from './npm-copies'

// Synthetic copies only: no npm is run, nothing on this computer is read.
const copy = { packageRoot: '/synthetic/lib/node_modules/fuli-context', version: '0.20.0-beta.6', shellCommands: ['fl'],
  removeCommand: "npm uninstall --global fuli-context --prefix '/synthetic'", noticeDismissed: false }
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

function server(routes: Record<string, unknown>) {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => json(routes[`${init?.method ?? 'GET'} ${url}`]))
  vi.stubGlobal('fetch', fetch)
  return fetch
}

beforeEach(() => {
  setActivePinia(createPinia())
  Object.assign(npmCopies, { copies: [], loaded: false, removing: null, failed: {} })
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('names the old npm copy and removes it on one click, without a second confirmation', async () => {
  const fetch = server({ 'GET /api/system/npm-copies': { copies: [copy] },
    'POST /api/system/npm-copies/uninstall': { status: 'uninstalled', version: copy.version, manualCommand: copy.removeCommand } })
  const wrapper = mount(NpmCopyNotice)
  await flushPromises()
  expect(wrapper.get('[data-npm-copy-notice]').text()).toContain('旧的 npm 版 FULI（v0.20.0-beta.6）')
  await wrapper.get('[data-npm-copy-remove]').trigger('click')
  await flushPromises()
  const removal = fetch.mock.calls.find(([url]) => url === '/api/system/npm-copies/uninstall')
  expect(JSON.parse(String(removal?.[1]?.body))).toEqual({ packageRoot: copy.packageRoot })
  expect(useConsoleStore().feedback?.message).toBe('已卸载 npm 版 FULI v0.20.0-beta.6，数据没动。')
  expect(wrapper.find('[data-npm-copy-notice]').exists()).toBe(false)
})

it('shows the command to run by hand when the removal fails', async () => {
  server({ 'GET /api/system/npm-copies': { copies: [copy] },
    'POST /api/system/npm-copies/uninstall': { status: 'failed', version: copy.version, manualCommand: copy.removeCommand, error: 'npm_not_found' } })
  const wrapper = mount(NpmCopyNotice)
  await flushPromises()
  await wrapper.get('[data-npm-copy-remove]').trigger('click')
  await flushPromises()
  expect(wrapper.get('[data-npm-copy-notice]').text()).toContain('找不到装它的 npm')
  expect(wrapper.get('[data-npm-copy-command]').text()).toBe(copy.removeCommand)
})

it('closes for good: a closed notice is not shown again', async () => {
  const fetch = server({ 'GET /api/system/npm-copies': { copies: [copy] },
    'PUT /api/system/npm-copies/notice': { copies: [{ ...copy, noticeDismissed: true }] } })
  const wrapper = mount(NpmCopyNotice)
  await flushPromises()
  await wrapper.get('[data-npm-copy-close]').trigger('click')
  await flushPromises()
  const put = fetch.mock.calls.find(([url]) => url === '/api/system/npm-copies/notice')
  expect(JSON.parse(String(put?.[1]?.body))).toEqual({ packageRoot: copy.packageRoot, dismissed: true })
  expect(wrapper.find('[data-npm-copy-notice]').exists()).toBe(false)
})

it('says nothing when there is no npm copy', async () => {
  server({ 'GET /api/system/npm-copies': { copies: [] } })
  const wrapper = mount(NpmCopyNotice)
  await flushPromises()
  expect(wrapper.find('[data-npm-copy-notice]').exists()).toBe(false)
})
