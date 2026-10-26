import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import manifest from '../../../../registry/client-links.json'
import ClientLinksSettings from './ClientLinksSettings.vue'

const state = (changes = {}) => ({ manifest, source: 'bundled', remoteUrl: 'https://raw.githubusercontent.com/JevonsCode/fuli/main/registry/client-links.json',
  autoUpdate: false, lastCheckedAt: null, history: [], ...changes })
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

// Answers by route, so a repeated read never shifts the other answers.
function server(routes: Record<string, unknown>) {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => json(routes[`${init?.method ?? 'GET'} ${url}`]))
  vi.stubGlobal('fetch', fetch)
  const body = (route: string) => {
    const call = fetch.mock.calls.find(([url, init]) => `${init?.method ?? 'GET'} ${url}` === route)
    return call ? JSON.parse(String(call[1]?.body)) : undefined
  }
  return { fetch, body }
}

async function open(wrapper: ReturnType<typeof mount>) {
  const details = wrapper.get('details')
  ;(details.element as HTMLDetailsElement).open = true
  await details.trigger('toggle')
  await flushPromises()
}

it('checks for an update, shows its diff by client and applies exactly that version', async () => {
  const diff = { fromVersion: 1, toVersion: 2, added: [{ id: 'synthetic', name: 'Synthetic Client' }],
    changed: [{ id: 'cursor', name: 'Cursor', fields: ['noSessionLink'] }], removed: [{ id: 'kiro', name: 'Kiro' }] }
  const { fetch, body } = server({
    'GET /api/client-links': state(),
    'POST /api/client-links/check': { status: 'update_available', checkedAt: '2026-10-27T08:00:00Z', digest: 'digest-2', updatedAt: '2026-10-28', diff },
    'POST /api/client-links/apply': state({ source: 'updated', history: [{ ...diff, appliedAt: '2026-10-27T08:01:00Z', automatic: false }] }),
  })
  const wrapper = mount(ClientLinksSettings)
  expect(fetch).not.toHaveBeenCalled()
  await open(wrapper)
  expect(wrapper.get('[data-client-link="cursor"]').text()).toContain('没有可核实的会话链接')
  expect(wrapper.get('[data-client-link="codex"]').text()).toContain('在 Codex 中打开')
  await wrapper.get('[data-client-links-check]').trigger('click')
  await flushPromises()
  expect(wrapper.get('[data-client-links-diff="added"]').text()).toContain('Synthetic Client')
  expect(wrapper.get('[data-client-links-diff="changed"]').text()).toContain('无链接说明')
  expect(wrapper.get('[data-client-links-diff="removed"]').text()).toContain('Kiro')
  await wrapper.get('[data-client-links-apply]').trigger('click')
  await flushPromises()
  expect(body('POST /api/client-links/apply')).toEqual({ digest: 'digest-2' })
  expect(wrapper.text()).toContain('已更新')
  expect(wrapper.text()).toContain('版本 1 → 2')
  expect(wrapper.find('[data-client-links-result]').exists()).toBe(false)
})

it('says an invalid online list was refused, offers nothing to apply and saves the auto-update switch', async () => {
  const { body } = server({
    'GET /api/client-links': state(),
    'POST /api/client-links/check': { status: 'invalid', checkedAt: '2026-10-27T08:00:00Z', reason: 'template uses a scheme FULI does not open (javascript)' },
    'PUT /api/client-links/auto-update': state({ autoUpdate: true }),
  })
  const wrapper = mount(ClientLinksSettings)
  await open(wrapper)
  await wrapper.get('[data-client-links-check]').trigger('click')
  await flushPromises()
  expect(wrapper.get('[data-client-links-result]').text()).toContain('已拒绝')
  expect(wrapper.find('[data-client-links-apply]').exists()).toBe(false)
  await wrapper.get('[data-client-links-auto]').trigger('click')
  await flushPromises()
  expect(body('PUT /api/client-links/auto-update')).toEqual({ enabled: true })
  expect(wrapper.get('[data-client-links-auto]').attributes('aria-checked')).toBe('true')
})
