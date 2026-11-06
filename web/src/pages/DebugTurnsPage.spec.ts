import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import DebugTurnsPage from './DebugTurnsPage.vue'

// The Debug page, against a synthetic list route.
afterEach(() => vi.unstubAllGlobals())

async function mountPage(records: unknown[]) {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ records })))
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:any(.*)', component: { template: '<div />' } }] })
  await router.push('/debug')
  const pinia = createPinia()
  setActivePinia(pinia)
  const wrapper = mount(DebugTurnsPage, { global: { plugins: [router, pinia] } })
  await flushPromises()
  return wrapper
}

it('lists each record by its first prompt line, client and FULI’s share, linking to the record', async () => {
  const wrapper = await mountPage([{ id: 'r 1', createdAt: '2026-11-04T08:00:00.000Z', sourceApplication: 'codex',
    promptLine: '#fulidebug synthetic ask', totals: { person: 50, fuli: 25, ai: 25, host: 0, not_visible: 0 } }])
  const row = wrapper.get('[data-debug-turn-row]')
  expect(row.attributes('href')).toBe('/debug/r%201')
  expect(row.text()).toContain('#fulidebug synthetic ask')
  expect(row.text()).toContain('Codex')
  expect(row.text()).toContain('25%')
})

it('says how to make one when there is none', async () => {
  const wrapper = await mountPage([])
  expect(wrapper.find('[data-debug-turn-row]').exists()).toBe(false)
  expect(wrapper.text()).toContain('以 #fulidebug 开头提问')
})

it('deletes the selected records after a second click in place', async () => {
  const row = (id: string) => ({ id, createdAt: '2026-11-04T08:00:00.000Z', sourceApplication: 'codex', promptLine: '#fulidebug ' + id,
    totals: { person: 1, fuli: 1, ai: 1, host: 0, not_visible: 0 } })
  const wrapper = await mountPage([row('a'), row('b'), row('c')])
  const fetch = vi.mocked(globalThis.fetch)
  fetch.mockImplementation(async (url, init) => init?.method === 'POST'
    ? Response.json({ deleted: JSON.parse(String(init.body)).ids }) : Response.json({ records: [row('c')] }))
  expect(wrapper.find('[data-debug-turn-delete]').exists()).toBe(false)
  const boxes = wrapper.findAll('[data-debug-turn-select]')
  await boxes[0]!.trigger('click')
  await boxes[1]!.trigger('click')
  await wrapper.get('[data-debug-turn-delete]').trigger('click')
  expect(wrapper.get('[data-debug-turn-delete]').text()).toContain('确认删除 2 条')
  expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0)
  await wrapper.get('[data-debug-turn-delete]').trigger('click')
  await flushPromises()
  const [, init] = fetch.mock.calls.find(([, call]) => call?.method === 'POST')!
  expect(JSON.parse(String(init?.body))).toEqual({ ids: ['a', 'b'] })
  expect(wrapper.findAll('[data-debug-turn-row]')).toHaveLength(1)
  expect(wrapper.find('[data-debug-turn-delete]').exists()).toBe(false)
})
