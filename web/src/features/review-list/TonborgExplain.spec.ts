import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { getJson } = vi.hoisted(() => ({ getJson: vi.fn() }))
vi.mock('@/api/client', async importOriginal => ({ ...await importOriginal<typeof import('@/api/client')>(), getJson }))

import { useConsoleStore } from '@/stores/console'
import TonborgExplain from './TonborgExplain.vue'

// 「让 AI 解释」 on the Tonborg card (Jevons 11-07), synthetic data only.
const link = (id: string, template: string, parameter: string) => ({ id, opens: 'App', template,
  parameters: { [parameter]: { format: parameter === 'prompt' ? 'any' : 'uuid' } }, platforms: ['windows'], notes: 'Synthetic.', source: 'https://example.test/docs' })
const manifest = { format: 'fuli-client-links', formatVersion: 1, manifestVersion: 2, updatedAt: '2026-11-07', clients: [
  { id: 'codex', name: 'Codex', noSessionLink: null, sessionLinks: [link('codex-thread', 'codex://threads/{sessionId}', 'sessionId'),
    link('codex-new', 'codex://new?prompt={prompt}', 'prompt')] },
  { id: 'claude_code', name: 'Claude Code', noSessionLink: null, sessionLinks: [link('vscode-new', 'vscode://anthropic.claude-code/open?prompt={prompt}', 'prompt')] },
  { id: 'cursor', name: 'Cursor', noSessionLink: 'Synthetic: no link.', sessionLinks: [] },
] }
let clients: Array<{ id: string; status: string }> = []
const writeText = vi.fn(async (_text: string) => {})

enableAutoUnmount(afterEach)

beforeEach(() => {
  setActivePinia(createPinia())
  getJson.mockReset()
  writeText.mockReset()
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  clients = [{ id: 'codex', status: 'connected' }, { id: 'claude-code', status: 'not_detected' }, { id: 'cursor', status: 'connected' }]
  getJson.mockImplementation(async (url: string) => {
    if (url === '/api/client-links') return { manifest, source: 'bundled', remoteUrl: 'https://example.test', autoUpdate: false, lastCheckedAt: null, history: [] }
    if (url === '/api/system/client-connection/status') return { available: true, clients }
    throw new Error(`Unexpected request: ${url}`)
  })
})

async function opened(count: number) {
  const wrapper = mount(TonborgExplain, { props: { count }, attachTo: document.body })
  await wrapper.get('[data-tonborg-explain]').trigger('click')
  await flushPromises()
  return wrapper
}
const panel = () => document.querySelector('[data-tonborg-explain-panel]') as HTMLElement

describe('TonborgExplain', () => {
  it('offers copy and a new chat only in connected clients whose link takes a prompt', async () => {
    await opened(7)
    const openers = [...panel().querySelectorAll<HTMLAnchorElement>('[data-tonborg-explain-open]')]
    // Codex is connected with a prompt link; Claude Code is not installed; Cursor documents no link.
    expect(openers.map(item => item.dataset.tonborgExplainOpen)).toEqual(['codex'])
    expect(openers[0].href.startsWith('codex://new?prompt=')).toBe(true)
    expect(decodeURIComponent(openers[0].href.split('prompt=')[1])).toContain('一共 7 条，想先听几条，还是一次全部解释？')
    expect(panel().textContent).toContain('共 7 条，AI 会先问你想听几条。')
    expect(panel().closest('.ui-popover')?.classList.contains('ui-popover--glass')).toBe(true)
  })

  it('copies the prompt and names what was copied in a toast', async () => {
    await opened(3)
    expect(panel().textContent).not.toContain('想听几条')
    panel().querySelector<HTMLButtonElement>('[data-tonborg-explain-copy]')!.click()
    await flushPromises()
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText.mock.calls[0][0]).toContain('list_tonborg_questions')
    expect(writeText.mock.calls[0][0]).not.toContain('想先听几条')
    expect(useConsoleStore().feedback?.message).toMatch(/已复制.*3 条/)
    expect(panel()).toBeNull()
  })

  it('shows only copy when no client can open a chat, and the text when the clipboard refuses', async () => {
    clients = []
    writeText.mockRejectedValueOnce(new Error('denied'))
    await opened(2)
    expect(panel().querySelectorAll('[data-tonborg-explain-open]')).toHaveLength(0)
    panel().querySelector<HTMLButtonElement>('[data-tonborg-explain-copy]')!.click()
    await flushPromises()
    const text = panel().querySelector<HTMLTextAreaElement>('[data-tonborg-explain-text]')!
    expect(text.value).toContain('answer_tonborg_question')
  })
})
