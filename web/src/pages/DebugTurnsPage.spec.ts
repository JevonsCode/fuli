import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import DebugTurnsPage from './DebugTurnsPage.vue'

// Settings › 系统 › 调试记录, against a synthetic list route.
afterEach(() => vi.unstubAllGlobals())

async function mountPage(records: unknown[]) {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ records })))
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:any(.*)', component: { template: '<div />' } }] })
  await router.push('/settings/debug-turns')
  const wrapper = mount(DebugTurnsPage, { global: { plugins: [router] } })
  await flushPromises()
  return wrapper
}

it('lists each record by its first prompt line, client and FULI’s share, linking to the record', async () => {
  const wrapper = await mountPage([{ id: 'r 1', createdAt: '2026-11-04T08:00:00.000Z', sourceApplication: 'codex',
    promptLine: '#debug synthetic ask', totals: { person: 50, fuli: 25, ai: 25, host: 0, not_visible: 0 } }])
  const row = wrapper.get('[data-debug-turn-row]')
  expect(row.attributes('href')).toBe('/settings/debug-turns/r%201')
  expect(row.text()).toContain('#debug synthetic ask')
  expect(row.text()).toContain('Codex')
  expect(row.text()).toContain('25%')
})

it('says how to make one when there is none', async () => {
  const wrapper = await mountPage([])
  expect(wrapper.find('[data-debug-turn-row]').exists()).toBe(false)
  expect(wrapper.text()).toContain('以 #debug 开头提问')
})
