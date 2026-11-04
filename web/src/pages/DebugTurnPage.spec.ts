import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import DebugTurnPage from './DebugTurnPage.vue'

// One synthetic #debug turn record, as GET /api/debug-turns/:id answers it.
const RECORD = {
  version: 1, id: 'record-1', createdAt: '2026-11-04T08:00:00.000Z', sourceApplication: 'claude_code', transcript: 'read',
  parts: [
    { source: 'not_visible', kind: 'system_prompt', label: '', text: 'The client’s own system prompt is not visible to FULI.', bytes: 55 },
    { source: 'fuli', kind: 'mcp_tools', label: '6', text: 'x'.repeat(900), bytes: 900 },
    { source: 'person', kind: 'prompt', label: '', text: '#debug synthetic ask', bytes: 20 },
    { source: 'ai', kind: 'assistant_message', label: '', text: 'Synthetic answer.', bytes: 17 },
    { source: 'host', kind: 'tool_call', label: 'Bash', text: '{"name":"Bash"}', bytes: 8 },
  ],
  totals: { person: 20, fuli: 900, ai: 17, host: 8, not_visible: 55 },
  cut: { historyMessages: 3, historyBytes: 2048, parts: [] },
}

afterEach(() => vi.unstubAllGlobals())

async function mountPage(answer: (url: string, init?: RequestInit) => Response) {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => answer(url, init))
  vi.stubGlobal('fetch', fetch)
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/debug', component: { template: '<div data-list />' } },
    { path: '/debug/:id', component: DebugTurnPage },
  ] })
  await router.push('/debug/record-1')
  const wrapper = mount(DebugTurnPage, { attachTo: document.body, global: { plugins: [router] } })
  await flushPromises()
  return { fetch, router, wrapper }
}

it('stacks the parts in order, coloured by source, under how much FULI added', async () => {
  const writeText = vi.fn(async () => {})
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  const { fetch, wrapper } = await mountPage(() => Response.json(RECORD))
  expect(fetch.mock.calls[0]![0]).toBe('/api/debug-turns/record-1')

  expect(wrapper.get('[data-debug-turn-share]').text()).toMatch(/^FULI 加了 900 B，占这一轮 1,000 B 的 90%。$/)
  expect(wrapper.findAll('[data-debug-turn-legend] li').map(item => item.attributes('data-source')))
    .toEqual(['person', 'fuli', 'ai', 'host', 'not_visible'])
  expect(wrapper.text()).toContain('删去了更早的 3 条消息')

  const parts = wrapper.findAll('[data-debug-part]')
  expect(parts.map(part => part.attributes('data-source'))).toEqual(['not_visible', 'fuli', 'person', 'ai', 'host'])
  expect(parts.map(part => part.attributes('style'))).toEqual([
    '--source: var(--color-source-not-visible);', '--source: var(--color-source-fuli);', '--source: var(--color-source-person);',
    '--source: var(--color-source-ai);', '--source: var(--color-source-host);'])
  expect(parts.map(part => part.find('[data-debug-part-more]').exists())).toEqual([false, true, false, false, false])

  await parts[1]!.get('[data-debug-part-copy]').trigger('click')
  await flushPromises()
  expect(writeText).toHaveBeenCalledWith('x'.repeat(900))
  expect(parts[1]!.get('[data-debug-part-copy] .is-shown').text()).toBe('已复制')
  wrapper.unmount()
})

it('deletes the record only after the person confirms, then returns to the list', async () => {
  const { fetch, router, wrapper } = await mountPage((_url, init) => Response.json(init?.method === 'DELETE' ? { deleted: 'record-1' } : RECORD))
  await wrapper.get('[data-debug-turn-remove]').trigger('click')
  expect(fetch.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toEqual([])
  document.querySelector<HTMLButtonElement>('[data-debug-turn-remove-confirm]')!.click()
  await flushPromises()
  expect(fetch.mock.calls.filter(([, init]) => init?.method === 'DELETE').map(([url]) => url)).toEqual(['/api/debug-turns/record-1'])
  expect(router.currentRoute.value.path).toBe('/debug')
  wrapper.unmount()
})

it('says when the record no longer exists', async () => {
  const { wrapper } = await mountPage(() => Response.json({ error: 'gone', code: 'debug_turn_not_found' }, { status: 404 }))
  expect(wrapper.text()).toContain('这条调试记录已不存在。')
  expect(wrapper.find('[data-debug-turn-remove]').exists()).toBe(false)
  wrapper.unmount()
})

// What a real turn that fit whole looks like: the record says cut: null.
it('reads a record that nothing was cut from', async () => {
  const { wrapper } = await mountPage(() => Response.json({ ...RECORD, cut: null }))
  expect(wrapper.find('[data-debug-part]').exists() || wrapper.text().includes('#debug')).toBe(true)
  expect(wrapper.text()).not.toContain('没有读取成功')
  wrapper.unmount()
})

// Jevons 11-04: two lines on the page, the rest in a large dialog that scrolls.
it('opens a long part in a dialog with its whole text', async () => {
  const text = 'long line\n'.repeat(80)
  const { wrapper } = await mountPage(() => Response.json({ ...RECORD, cut: null,
    parts: [{ source: 'fuli', kind: 'mcp_tools', label: '6', text, bytes: text.length }] }))
  expect(wrapper.get('[data-debug-part-preview]').text()).toContain('long line')
  await wrapper.get('[data-debug-part-more]').trigger('click')
  await flushPromises()
  expect(document.querySelector('[data-debug-part-dialog] pre')?.textContent).toBe(text)
  wrapper.unmount()
})
