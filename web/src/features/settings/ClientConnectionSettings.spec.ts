import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import ClientConnectionSettings from './ClientConnectionSettings.vue'

const server = { type: 'stdio', command: 'node', args: ['mcp-server.js'] }
const configuration = { standard: { mcpServers: { fuli: server } }, vscode: { servers: { fuli: server } }, server }
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

async function open(wrapper: ReturnType<typeof mount>) {
  const details = wrapper.get('details')
  ;(details.element as HTMLDetailsElement).open = true
  await details.trigger('toggle')
  await flushPromises()
}

it('loads only when opened and copies configuration without modifying a client', async () => {
  const fetch = vi.fn(async () => Response.json(configuration))
  vi.stubGlobal('fetch', fetch)
  const writeText = vi.fn(async (_text: string) => {})
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  const wrapper = mount(ClientConnectionSettings)
  expect(fetch).not.toHaveBeenCalled()
  await open(wrapper)
  expect(fetch).toHaveBeenCalledTimes(1)
  await wrapper.get('[data-copy-connection]').trigger('click')
  expect(JSON.parse(writeText.mock.calls[0]![0] as string)).toEqual(configuration.standard)
  expect(wrapper.text()).toContain('已复制')
  expect(fetch).toHaveBeenCalledTimes(1)
  wrapper.unmount()
})

it('retains selectable configuration when clipboard access is unavailable', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(configuration)))
  vi.stubGlobal('navigator', {})
  const wrapper = mount(ClientConnectionSettings)
  await open(wrapper)
  await wrapper.get('[data-copy-connection]').trigger('click')
  expect(wrapper.text()).toContain('手动复制')
  expect(wrapper.get('textarea').element.value).toContain('mcpServers')
  wrapper.unmount()
})

it('can retry a failed configuration request', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({ error: { message: 'Unavailable' } }, { status: 503 }))
    .mockResolvedValueOnce(Response.json(configuration))
  vi.stubGlobal('fetch', fetch)
  const wrapper = mount(ClientConnectionSettings)
  await open(wrapper)
  expect(wrapper.find('[data-copy-connection]').exists()).toBe(false)
  await wrapper.get('[data-retry-connection]').trigger('click')
  await flushPromises()
  expect(wrapper.find('[data-copy-connection]').exists()).toBe(true)
  wrapper.unmount()
})
