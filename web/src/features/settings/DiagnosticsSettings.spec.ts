import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, expect, it, vi } from 'vitest'
import type { ConsoleState } from '@/types'
import { useConsoleStore } from '@/stores/console'
import { saveFile } from '@/lib/save-file'
import DiagnosticsSettings from './DiagnosticsSettings.vue'

vi.mock('@/lib/save-file', () => ({ saveFile: vi.fn() }))

// A synthetic bundle as the console route answers it (src/system/diagnostics-bundle.js).
const BUNDLE = {
  generatedAt: '2026-11-01T08:00:00.000Z',
  files: [
    { name: 'about.json', content: '{\n  "fuli": { "version": "0.0.0-synthetic" }\n}\n' },
    { name: 'logs/runtime.log', content: 'started at ~\\work by <user>\n' },
  ],
  redactions: { home_directory: 3, username: 1, email: 0, synthetic_kind: 2 },
}

afterEach(() => { vi.unstubAllGlobals(); vi.mocked(saveFile).mockReset() })

function mountCard() {
  const fetch = vi.fn(async (_url: string) => Response.json(BUNDLE))
  vi.stubGlobal('fetch', fetch)
  const pinia = createPinia()
  setActivePinia(pinia)
  useConsoleStore().state = { mode: 'personal_only', personalSpaces: [{ id: 'space a', name: '我' }], projects: [], subscriptions: [] } as unknown as ConsoleState
  return { fetch, wrapper: mount(DiagnosticsSettings, { global: { plugins: [pinia] } }) }
}

it('previews every file and what was hidden, then exports exactly that bundle with saveFile', async () => {
  vi.mocked(saveFile).mockResolvedValue('C:\\Users\\synthetic\\Downloads\\fuli-diagnostics.json')
  const { fetch, wrapper } = mountCard()
  expect(fetch).not.toHaveBeenCalled()
  expect(wrapper.find('[data-diagnostics-export]').exists()).toBe(false)

  await wrapper.get('[data-diagnostics-generate]').trigger('click')
  expect(wrapper.get('[data-diagnostics-generate]').attributes('aria-busy')).toBe('true')
  expect(wrapper.text()).toContain('正在生成诊断包')
  await flushPromises()
  expect(fetch.mock.calls[0][0]).toBe('/api/system/diagnostics?personalSpaceId=space%20a')
  expect(wrapper.get('[data-diagnostics-redactions]').text()).toBe('已隐藏用户目录 3 处synthetic_kind 2 处用户名 1 处')
  const files = wrapper.findAll('[data-diagnostics-file]')
  expect(files.map(file => file.get('code').text())).toEqual(['about.json', 'logs/runtime.log'])
  expect(files.every(file => !(file.element as HTMLDetailsElement).open)).toBe(true)
  expect(files[1].get('pre').text()).toBe('started at ~\\work by <user>')
  expect(saveFile).not.toHaveBeenCalled()

  await wrapper.get('[data-diagnostics-export]').trigger('click')
  await flushPromises()
  expect(saveFile).toHaveBeenCalledOnce()
  const [name, content, type] = vi.mocked(saveFile).mock.calls[0]
  expect(name).toBe('fuli-diagnostics-2026-11-01T08-00-00Z.json')
  expect(JSON.parse(content)).toEqual(BUNDLE)
  expect(type).toBe('application/json;charset=utf-8')
  expect(wrapper.text()).toContain('已导出诊断包：C:\\Users\\synthetic\\Downloads\\fuli-diagnostics.json')
})

it('says when the export could not be saved and keeps the preview', async () => {
  vi.mocked(saveFile).mockRejectedValue(new Error('disk full'))
  const { wrapper } = mountCard()
  await wrapper.get('[data-diagnostics-generate]').trigger('click')
  await flushPromises()
  await wrapper.get('[data-diagnostics-export]').trigger('click')
  await flushPromises()
  expect(wrapper.get('[role="alert"]').text()).toBe('无法导出诊断包：disk full')
  expect(wrapper.findAll('[data-diagnostics-file]')).toHaveLength(2)
})
