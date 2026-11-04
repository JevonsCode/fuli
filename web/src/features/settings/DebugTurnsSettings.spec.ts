import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import DebugTurnsSettings from './DebugTurnsSettings.vue'

// Settings › 系统 › 调试记录, against a synthetic list route.
const totals = { person: 10, fuli: 30, ai: 40, host: 20, not_visible: 0 }

afterEach(() => vi.unstubAllGlobals())

async function mountCard(records: unknown[]) {
  const fetch = vi.fn(async () => Response.json({ records }))
  vi.stubGlobal('fetch', fetch)
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:any(.*)', component: { template: '<div />' } }] })
  const wrapper = mount(DebugTurnsSettings, { global: { plugins: [router] } })
  await flushPromises()
  return { fetch, wrapper }
}

it('shows nothing while there is no debug record', async () => {
  const { fetch, wrapper } = await mountCard([])
  expect(fetch).toHaveBeenCalledWith('/api/debug-turns', expect.anything())
  expect(wrapper.find('[data-debug-turns-card]').exists()).toBe(false)
})

it('shows one headline and a 查看 link to the records once one exists', async () => {
  const { wrapper } = await mountCard([{ id: 'r1', createdAt: '2026-11-04T08:00:00.000Z', sourceApplication: 'codex',
    promptLine: '#debug synthetic', totals }])
  const card = wrapper.get('[data-debug-turns-card]')
  expect(card.findAll('h2').map(heading => heading.text())).toEqual(['调试记录'])
  const open = card.get('[data-open-debug-turns]')
  expect([open.text(), open.attributes('href')]).toEqual(['查看', '/settings/debug-turns'])
})
