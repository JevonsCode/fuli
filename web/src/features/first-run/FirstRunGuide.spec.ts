import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'

import CaptureOnboardingDialog from '@/features/capture/CaptureOnboardingDialog.vue'
import { useConsoleStore } from '@/stores/console'
import type { CapturePolicy } from '@/types'

// The first-run guide inside the capture onboarding dialog. Synthetic clients and answers only.
const OFF: CapturePolicy = { enabled: false, projectMode: 'all', updatedAt: '2026-11-02T08:00:00.000Z' }
const client = (id: string, label: string, status: string, extra: Record<string, unknown> = {}) =>
  ({ id, label, status, detected: status !== 'not_detected', previouslyConnected: false, changes: [], ...extra })
const CLIENTS = [
  client('claude-code', 'Claude Code', 'not_connected'),
  client('codex', 'Codex', 'connected'),
  client('cursor', 'Cursor', 'not_connected'),
  client('antigravity', 'Antigravity', 'not_detected'),
  client('claude-desktop', 'Claude Desktop', 'removed'),
]

type Desktop = { fuliDesktopClient?: unknown, flutter_inappwebview?: unknown }

function mountGuide({ ask = true, guide = true, connect = async (id: string) => Response.json({ id, status: 'connected', restartRequired: false }) }: {
  ask?: boolean
  guide?: boolean
  connect?: (id: string) => Promise<Response>
} = {}) {
  const connects: string[] = []
  const guidePosts: unknown[] = []
  let clients = CLIENTS
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    if (input === '/api/system/client-connection/status') return Response.json({ observedAt: 'x', historySaved: true, available: true, clients })
    if (input === '/api/system/client-connection/connect') {
      const { clientId } = JSON.parse(String(init?.body))
      connects.push(clientId)
      const answer = await connect(clientId)
      const { status } = await answer.clone().json()
      if (status === 'connected') clients = clients.map(item => item.id === clientId ? { ...item, status: 'connected' } : item)
      return answer
    }
    if (input === '/api/first-run-guide') {
      guidePosts.push(JSON.parse(String(init?.body)))
      return Response.json({ open: false })
    }
    if (input === '/api/capture-onboarding' && init?.method === 'POST') {
      return Response.json({ status: 'answered', choice: 'all', capturePolicy: { ...OFF, enabled: true } })
    }
    return Response.json({}, { status: 404 })
  }))
  const pinia = createPinia()
  setActivePinia(pinia)
  const store = useConsoleStore()
  store.state = { mode: 'personal_only', personalSpaces: [{ id: 'space', name: '我' }], activePersonalSpaceId: 'space',
    projects: [], subscriptions: [], personalProjects: [], capturePolicy: OFF, captureOnboarding: { ask }, firstRunGuide: { open: guide } }
  const wrapper = mount(CaptureOnboardingDialog, { global: { plugins: [pinia] }, attachTo: document.body })
  return { wrapper, store, connects, guidePosts }
}

const find = (selector: string) => document.body.querySelector<HTMLElement>(selector)
const rows = () => [...document.body.querySelectorAll<HTMLElement>('[data-first-run-client]')]
async function click(selector: string) {
  find(selector)!.click()
  await flushPromises()
}

describe('first-run guide', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    delete (window as Desktop).fuliDesktopClient
    delete (window as Desktop).flutter_inappwebview
    document.body.innerHTML = ''
  })

  it('lists only the detected clients, ticks every one not connected yet, and keeps the capture choice in the same flow', async () => {
    const { wrapper } = mountGuide()
    await flushPromises()
    expect(find('[data-capture-onboarding] h2')?.textContent).toBe('开始使用 FULI')
    expect(rows().map(row => [row.dataset.firstRunClient, row.querySelector('.first-run-client__status')?.textContent]))
      .toEqual([['claude-code', '未接入'], ['codex', '已接入'], ['cursor', '未接入'], ['claude-desktop', '未接入']])
    const ticked = rows().map(row => row.querySelector('[role="checkbox"]')?.getAttribute('aria-checked') ?? null)
    expect(ticked).toEqual(['true', null, 'true', 'true'])
    expect(find('[data-first-run-clients]')?.textContent).toContain('没列出的客户端，装好后可以在 设置 › 客户端 里接入。')
    expect(find('[data-first-run-capture] [data-capture-scope="all"]')).not.toBeNull()
    // Outside the desktop client there is no start-at-login step.
    expect(find('[data-first-run-login]')).toBeNull()
    wrapper.unmount()
  })

  it('「一键接入」 connects each ticked client in turn and shows its progress and result', async () => {
    const answers: Record<string, (response: Response) => void> = {}
    const { wrapper, connects } = mountGuide({ connect: id => new Promise(resolve => { answers[id] = resolve }) })
    await flushPromises()
    await click('[data-first-run-client="cursor"] [role="checkbox"]')
    await click('[data-first-run-connect]')
    expect(connects).toEqual(['claude-code'])
    expect(find('[data-first-run-connect] [aria-label="正在接入 Claude Code"]')).not.toBeNull()
    expect(find('[data-first-run-client="claude-code"] [aria-label="正在接入 Claude Code"]')).not.toBeNull()
    expect(find('[data-capture-scope-save]')!.hasAttribute('disabled')).toBe(true)
    answers['claude-code']!(Response.json({ id: 'claude-code', status: 'connected', restartRequired: true }))
    await flushPromises()
    expect(connects).toEqual(['claude-code', 'claude-desktop'])
    answers['claude-desktop']!(Response.json({ id: 'claude-desktop', status: 'connected', restartRequired: false }))
    await flushPromises()
    expect(connects).toEqual(['claude-code', 'claude-desktop'])
    expect(find('[data-first-run-client="claude-code"] [data-first-run-outcome]')?.textContent?.trim()).toBe('已接入，重启 Claude Code 后生效。')
    expect(find('[data-first-run-client="claude-desktop"]')?.dataset.clientStatus).toBe('connected')
    expect(find('[data-first-run-client="cursor"]')?.dataset.clientStatus).toBe('not_connected')
    wrapper.unmount()
  })

  it("shows one client's failure without hiding the others' success", async () => {
    const { wrapper, connects } = mountGuide({ connect: async id => id === 'cursor'
      ? Response.json({ id, status: 'partial', restartRequired: false })
      : Response.json({ id, status: 'connected', restartRequired: false }) })
    await flushPromises()
    await click('[data-first-run-connect]')
    expect(connects).toEqual(['claude-code', 'cursor', 'claude-desktop'])
    const failed = find('[data-first-run-client="cursor"] [data-first-run-outcome]')!
    expect([failed.dataset.firstRunOutcome, failed.getAttribute('role')]).toEqual(['failed', 'alert'])
    expect(find('[data-first-run-client="claude-code"] [data-first-run-outcome]')?.textContent?.trim()).toBe('已接入。')
    // The failed client stays ticked for another try.
    expect(find('[data-first-run-client="cursor"] [role="checkbox"]')?.getAttribute('aria-checked')).toBe('true')
    wrapper.unmount()
  })

  it('「跳过」 closes the guide for good and leaves the capture question for the next visit', async () => {
    const { wrapper, store, connects, guidePosts } = mountGuide()
    await flushPromises()
    await click('[data-first-run-skip]')
    expect(find('[data-capture-onboarding]')).toBeNull()
    expect(connects).toEqual([])
    expect(guidePosts).toEqual([{ outcome: 'skipped' }])
    expect(store.state?.firstRunGuide).toEqual({ open: false })
    expect(store.state?.captureOnboarding).toEqual({ ask: true })
    wrapper.unmount()
  })

  it('finishing saves the capture answer, then closes the guide', async () => {
    const { wrapper, store, guidePosts } = mountGuide()
    await flushPromises()
    await click('[data-capture-scope="all"] [role="radio"]')
    await click('[data-capture-scope-save]')
    expect(guidePosts).toEqual([{ outcome: 'finished' }])
    expect(store.state?.captureOnboarding).toEqual({ ask: false })
    expect(find('[data-capture-onboarding]')).toBeNull()
    wrapper.unmount()
  })

  it('opened again from 设置 › 客户端 without a capture question: 「完成」 closes it, nothing is recorded', async () => {
    const { wrapper, store, guidePosts } = mountGuide({ ask: false, guide: false })
    await flushPromises()
    expect(find('[data-capture-onboarding]')).toBeNull()
    store.reopenFirstRunGuide()
    await flushPromises()
    expect(find('[data-first-run-capture]')).toBeNull()
    expect(find('[data-capture-scope-save]')?.textContent?.trim()).toBe('完成')
    await click('[data-capture-scope-save]')
    expect(find('[data-capture-onboarding]')).toBeNull()
    expect(guidePosts).toEqual([])
    wrapper.unmount()
  })

  it('in the Windows desktop client, offers start at login, on by default, and saves a change through the bridge', async () => {
    let held = true
    const callHandler = vi.fn(async (_name: string, request: { enabled?: boolean }) => {
      if (request.enabled !== undefined) held = request.enabled
      return { available: true, enabled: held }
    })
    Object.assign(window as Desktop, { fuliDesktopClient: { platform: 'windows', captionStart: 0, captionEnd: 138 }, flutter_inappwebview: { callHandler } })
    const { wrapper } = mountGuide()
    await flushPromises()
    const toggle = find('[data-first-run-login-switch]')!
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    await click('[data-first-run-login-switch]')
    expect(callHandler.mock.calls.at(-1)).toEqual(['fuliLaunchAtLogin', { enabled: false }])
    expect(find('[data-first-run-login-switch]')!.getAttribute('aria-checked')).toBe('false')
    wrapper.unmount()
  })
})
