import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import IssueLogPanel from './IssueLogPanel.vue'

afterEach(() => vi.unstubAllGlobals())

it('copies exactly the visible Markdown and preserves a dated report when refresh fails', async () => {
  const markdown = '## FULI 故障日志\nGET spaces | provider_http_5xx | HTTP 503'
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({ markdown }))
    .mockResolvedValueOnce(new Response('private failure body', { status: 503 }))
  const writeText = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('fetch', fetch)
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  const panel = mount(IssueLogPanel)
  await flushPromises()
  expect(fetch.mock.calls[0]?.[0]).toBe('/api/diagnostics/issue-report?locale=zh-CN')
  const preview = () => (panel.get('textarea').element as HTMLTextAreaElement).value
  expect(preview()).toBe(markdown)
  await panel.get('[data-issue-copy]').trigger('click')
  await flushPromises()
  expect(writeText).toHaveBeenLastCalledWith(preview())
  expect(panel.text()).toContain('已复制')
  await panel.get('[data-issue-refresh]').trigger('click')
  await flushPromises()
  expect(preview()).toContain('HTTP 503')
  expect(preview()).toContain('上次成功读取')
  expect(preview()).toContain(markdown)
  expect(preview()).not.toContain('private failure body')
  await panel.get('[data-issue-copy]').trigger('click')
  await flushPromises()
  expect(writeText).toHaveBeenLastCalledWith(preview())
  panel.unmount()
})

it('offers a copyable offline result and selects the text if clipboard access fails', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('private remote hostname')))
  vi.stubGlobal('navigator', {})
  const panel = mount(IssueLogPanel, { attachTo: document.body })
  await flushPromises()
  await panel.get('[data-issue-copy]').trigger('click')
  await flushPromises()
  const preview = panel.get('textarea').element as HTMLTextAreaElement
  expect(preview.value).toContain('diagnostics_unreachable')
  expect(preview.value).not.toContain('private remote hostname')
  expect(preview.selectionEnd - preview.selectionStart).toBe(preview.value.length)
  expect(panel.text()).toContain('手动复制')
  panel.unmount()
})
