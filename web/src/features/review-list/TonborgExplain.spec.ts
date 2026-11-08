import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { getJson, postJson } = vi.hoisted(() => ({ getJson: vi.fn(), postJson: vi.fn() }))
vi.mock('@/api/client', async importOriginal => ({ ...await importOriginal<typeof import('@/api/client')>(), getJson, postJson }))

import { useConsoleStore } from '@/stores/console'
import TonborgExplain from './TonborgExplain.vue'

// 「让 Tonborg 给你解释」 on the Tonborg card (Jevons 11-07), synthetic data only.
// The real popover: its rows are actions, so keyboard use is part of the contract.
const link = (id: string, template: string, parameter: string) => ({ id, opens: 'App', template,
  parameters: { [parameter]: { format: parameter === 'prompt' ? 'any' : 'uuid' } }, platforms: ['windows'], notes: 'Synthetic.', source: 'https://example.test/docs' })
const manifest = { format: 'fuli-client-links', formatVersion: 1, manifestVersion: 2, updatedAt: '2026-11-07', clients: [
  { id: 'codex', name: 'Codex', noSessionLink: null, sessionLinks: [link('codex-thread', 'codex://threads/{sessionId}', 'sessionId'),
    link('codex-new', 'codex://new?prompt={prompt}', 'prompt')] },
  { id: 'claude_code', name: 'Claude Code', noSessionLink: null, sessionLinks: [link('vscode-new', 'vscode://anthropic.claude-code/open?prompt={prompt}', 'prompt')] },
  { id: 'claude', name: 'Claude', noSessionLink: null, sessionLinks: [link('claude-new', 'claude://claude.ai/new?q={prompt}', 'prompt')] },
  { id: 'opencode', name: 'OpenCode', noSessionLink: 'Synthetic: no link.', sessionLinks: [] },
] }
type SyntheticClient = { id: string; label: string; status: string; sourceApplication: string | null }
let clients: SyntheticClient[] = []
let customClients: SyntheticClient[] = []
const client = (id: string, label: string, sourceApplication: string | null, status = 'connected') => ({ id, label, status, sourceApplication })
const writeText = vi.fn(async (_text: string) => {})

enableAutoUnmount(afterEach)

beforeEach(() => {
  setActivePinia(createPinia())
  getJson.mockReset()
  postJson.mockReset()
  writeText.mockReset()
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  // As 设置 › 客户端接入 lists them: Claude Code is not installed; OpenCode has no prompt link.
  clients = [client('codex', 'Codex', 'codex'), client('claude-code', 'Claude Code', 'claude_code', 'not_detected'),
    client('claude-desktop', 'Claude Desktop', 'claude'), client('opencode', 'OpenCode', 'opencode')]
  customClients = []
  getJson.mockImplementation(async (url: string) => {
    if (url === '/api/client-links') return { manifest, source: 'bundled', remoteUrl: 'https://example.test', autoUpdate: false, lastCheckedAt: null, history: [] }
    if (url === '/api/system/client-connection/status') return { available: true, clients, customClients }
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

const trigger = () => document.querySelector<HTMLButtonElement>('[data-tonborg-explain]')!

describe('TonborgExplain', () => {
  it('is used with the keyboard: every action is tabbable, and Escape closes it back on the 「?」', async () => {
    mount(TonborgExplain, { props: { count: 3 }, attachTo: document.body })
    trigger().focus()
    trigger().click()
    await flushPromises()
    const actions = [...panel().querySelectorAll<HTMLElement>('a, button')]
    expect(actions.map(item => item.dataset.tonborgExplainOpen ?? item.dataset.tonborgExplainPaste ?? 'copy'))
      .toEqual(['codex', 'claude-desktop', 'opencode', 'copy'])
    // A hover card would set tabindex=-1 on these; a popover keeps them in the Tab order.
    for (const action of actions) expect(action.getAttribute('tabindex')).not.toBe('-1')
    actions[1].focus()
    expect(document.activeElement).toBe(actions[1])
    actions[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(panel()).toBeNull()
    expect(document.activeElement).toBe(trigger())
  })

  it('opens on hover after a short delay without taking focus, and a click then keeps it open', async () => {
    vi.useFakeTimers()
    try {
      mount(TonborgExplain, { props: { count: 3 }, attachTo: document.body })
      const before = document.activeElement
      trigger().dispatchEvent(new PointerEvent('pointerenter'))
      expect(panel()).toBeNull()
      await vi.advanceTimersByTimeAsync(300)
      expect(panel()).not.toBeNull()
      expect(document.activeElement).toBe(before)
      // A click on the 「?」 after hover keeps it open; the next click closes it.
      trigger().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
      trigger().click()
      await vi.advanceTimersByTimeAsync(10)
      expect(panel()).not.toBeNull()
      trigger().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
      trigger().click()
      await vi.advanceTimersByTimeAsync(10)
      expect(panel()).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('lists each connected client whose new-chat link takes a prompt; a click opens it and says where', async () => {
    await opened(7)
    const openers = [...panel().querySelectorAll<HTMLAnchorElement>('[data-tonborg-explain-open]')]
    // Codex and Claude Desktop are connected with prompt links; Claude Code is not installed; OpenCode documents no link.
    expect(openers.map(item => item.dataset.tonborgExplainOpen)).toEqual(['codex', 'claude-desktop'])
    expect(openers[0].href.startsWith('codex://new?prompt=')).toBe(true)
    // The client has FULI: one sentence naming Tonborg, nothing about tools.
    expect(decodeURIComponent(openers[0].href.split('prompt=')[1])).toBe('#FLA Tonborg 给我讲讲待决策里你拿不准的事')
    expect(decodeURIComponent(openers[1].href.split('q=')[1])).toBe('#FLA Tonborg 给我讲讲待决策里你拿不准的事')
    // No link takes a model, so no model name is shown.
    expect(panel().querySelector('.tonborg-explain__model')).toBeNull()
    expect(panel().textContent).toContain('复制给其他 AI')
    openers[1].addEventListener('click', event => event.preventDefault())
    openers[1].click()
    await flushPromises()
    expect(useConsoleStore().feedback?.message).toBe('已在 Claude Desktop 打开 Tonborg 的解释')
    expect(panel()).toBeNull()
  })

  it('a connected client without a prompt link copies the one sentence and says where to paste it', async () => {
    await opened(3)
    const row = panel().querySelector<HTMLButtonElement>('[data-tonborg-explain-paste="opencode"]')!
    // The same row as the others, with only a small 复制 on the right.
    expect(row.classList.contains('tonborg-explain__row')).toBe(true)
    expect(row.querySelector('.tonborg-explain__tag')?.textContent).toBe('复制')
    row.click()
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith('#FLA Tonborg 给我讲讲待决策里你拿不准的事')
    expect(useConsoleStore().feedback?.message).toBe('已复制，在 OpenCode 里粘贴发送')
    expect(panel()).toBeNull()
  })

  it('lists every connected client in the page\'s order, hand-described ones last, at most 7', async () => {
    clients = [client('codex', 'Codex', 'codex'), client('opencode', 'OpenCode', 'opencode'), client('cursor', 'Cursor', 'cursor'),
      client('kiro', 'Kiro', 'kiro', 'not_connected'), client('claude-desktop', 'Claude Desktop', 'claude'),
      client('gemini', 'Gemini CLI', null), client('qwen-code', 'Qwen Code', null)]
    customClients = [client('mine', 'My Agent', null), client('second', 'Second Agent', null), client('third', 'Third Agent', null)]
    await opened(3)
    const names = [...panel().querySelectorAll('.tonborg-explain__clients .tonborg-explain__name')].map(item => item.textContent)
    expect(names).toEqual(['Codex', 'OpenCode', 'Cursor', 'Claude Desktop', 'Gemini CLI', 'Qwen Code', 'My Agent'])
    expect(panel().textContent).toContain('复制给其他 AI')
  })

  it('shows the cheap model only where the link carries it', async () => {
    manifest.clients[0].sessionLinks[1] = link('codex-new', 'codex://new?prompt={prompt}&model={model}', 'prompt')
    manifest.clients[0].sessionLinks[1].parameters.model = { format: 'any' }
    try {
      await opened(2)
      const codex = panel().querySelector<HTMLAnchorElement>('[data-tonborg-explain-open="codex"]')!
      expect(codex.href).toContain('&model=medium')
      expect(codex.textContent).toContain('medium')
    } finally {
      manifest.clients[0].sessionLinks[1] = link('codex-new', 'codex://new?prompt={prompt}', 'prompt')
    }
  })

  it('copies the prompt and names what was copied in a toast', async () => {
    await opened(3)
    expect(panel().textContent).not.toContain('先听几条')
    panel().querySelector<HTMLButtonElement>('[data-tonborg-explain-copy]')!.click()
    await flushPromises()
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText.mock.calls[0][0]).toContain('list_tonborg_questions')
    expect(writeText.mock.calls[0][0]).not.toContain('想先听几条')
    expect(useConsoleStore().feedback?.message).toMatch(/已复制 Tonborg 的解释/)
    expect(panel()).toBeNull()
  })

  it('shows only copy when no client can open a chat, and the text when the clipboard refuses', async () => {
    clients = []
    writeText.mockRejectedValueOnce(new Error('denied'))
    await opened(2)
    expect(panel().querySelectorAll('[data-tonborg-explain-open]')).toHaveLength(0)
    expect(panel().textContent).toContain('复制给你的 AI')
    panel().querySelector<HTMLButtonElement>('[data-tonborg-explain-copy]')!.click()
    await flushPromises()
    const text = panel().querySelector<HTMLTextAreaElement>('[data-tonborg-explain-text]')!
    expect(text.value).toContain('answer_tonborg_question')
  })

  it('opens a connected CLI in a terminal when the client has no prompt link, and copies when that fails', async () => {
    const asked: unknown[] = []
    let opens = true
    postJson.mockImplementation(async (url: string, body: unknown) => {
      if (url === '/api/session-launch/new-session/ways') {
        asked.push(body)
        return { launcher: 'available', ways: { opencode: { prompt: 'send', environment: 'wsl' }, codex: { prompt: 'send' } } }
      }
      if (url === '/api/session-launch/new-session') {
        if (!opens) throw new Error('not installed any more')
        return { status: 'launch_requested' }
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    await opened(3)
    expect(asked).toEqual([{ clients: ['codex', 'claude-desktop', 'opencode'] }])
    // Codex keeps its documented app link; OpenCode, without one, opens in a terminal.
    expect(panel().querySelector('[data-tonborg-explain-open="codex"]')).not.toBeNull()
    const terminal = panel().querySelector<HTMLButtonElement>('[data-tonborg-explain-terminal="opencode"]')!
    expect(terminal.textContent).toContain('新窗口')
    terminal.click()
    await flushPromises()
    expect(postJson).toHaveBeenCalledWith('/api/session-launch/new-session',
      { client: 'opencode', prompt: expect.stringContaining('Tonborg') }, expect.anything())
    expect(useConsoleStore().feedback?.message).toMatch(/已在 OpenCode 打开/)
    expect(panel()).toBeNull()

    opens = false
    await opened(3)
    panel().querySelector<HTMLButtonElement>('[data-tonborg-explain-terminal="opencode"]')!.click()
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('Tonborg'))
    expect(useConsoleStore().feedback?.message).toMatch(/在 OpenCode 里粘贴发送/)
  })
})
