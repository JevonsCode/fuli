import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { defineComponent, h } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu'
import { useConsoleStore } from '@/stores/console'
import AppContextMenu from './AppContextMenu.vue'

const { getJson } = vi.hoisted(() => ({ getJson: vi.fn() }))
vi.mock('@/api/client', async (importOriginal) => ({ ...await importOriginal<typeof import('@/api/client')>(), getJson }))
vi.mock('@/features/agent-profile/agent-work-surfaces', () => ({
  readAgentWorkSurfaces: vi.fn(async () => ({ workbench: { path: '/agents/space/agent-1', query: { tab: 'workbench' } }, workflow: null })),
}))

const clipboard = { writeText: vi.fn(async (_text: string) => {}), readText: vi.fn(async () => 'there') }

beforeEach(() => {
  clipboard.writeText.mockClear()
  clipboard.readText.mockClear()
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard })
})
let mounted: { unmount: () => void } | null = null
afterEach(() => {
  mounted?.unmount()
  mounted = null
  window.getSelection()?.removeAllRanges()
  vi.restoreAllMocks()
})

// A page with plain text, a field, links, and a row that has its own right-click menu (like the dock's pins).
const Page = defineComponent(() => () => h('div', [
  h('p', { id: 'plain' }, [h('span', { id: 'words' }, 'Some words')]),
  h('input', { id: 'field', value: 'hello world' }),
  h('a', { id: 'inner', href: '/inbox' }, 'Inbox'),
  h('a', { id: 'outer', href: 'https://example.com/docs' }, 'Docs'),
  // An FLA portrait inside a link, as in the FLAs list.
  h('a', { id: 'card', href: '/inbox' }, [h('span', { id: 'face' }, [h('img', { id: 'portrait', 'data-agent-portrait': 'agent-1', alt: '' })]), ' Ada Vale']),
  // A portrait in a modal peek: the dialog's top layer covers anything outside it.
  h('dialog', { id: 'peek', open: true }, [h('img', { id: 'peek-portrait', 'data-agent-portrait': 'agent-1', alt: '' })]),
  h(ContextMenu, () => [
    h(ContextMenuTrigger, { asChild: true }, () => h('div', { id: 'own' }, 'Pinned FLA')),
    h(ContextMenuContent, { 'data-own-menu': '' }, () => h(ContextMenuItem, () => 'Unpin')),
  ]),
  h(AppContextMenu),
]))

async function setup() {
  setActivePinia(createPinia())
  getJson.mockResolvedValue({ agentId: 'agent-1', personalSpaceId: 'space', profile: { name: 'Ada Vale', displayName: 'Ada Vale', status: 'active', capabilities: [] } })
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { render: () => null } }, { path: '/agents/:spaceId/:agentId', component: { render: () => null } }, { path: '/inbox', component: { render: () => null } }] })
  await router.push('/')
  const wrapper = mount(Page, { global: { plugins: [router] }, attachTo: document.body })
  mounted = wrapper
  return { router, wrapper }
}

async function rightClick(selector: string, at = { clientX: 30, clientY: 40 }) {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, ...at })
  document.querySelector(selector)!.dispatchEvent(event)
  await flushPromises()
  return event
}

const menu = () => document.querySelector('[data-app-context-menu]')
const actions = () => [...document.querySelectorAll('[data-app-context-menu] [data-context-action]')].map(item => item.textContent?.trim())
const choose = async (action: string) => {
  document.querySelector<HTMLElement>(`[data-app-context-menu] [data-context-action="${action}"]`)!.click()
  await flushPromises()
}

describe('AppContextMenu', () => {
  it('keeps the native menu away everywhere and opens nothing where no action makes sense', async () => {
    await setup()
    const event = await rightClick('#words')
    expect(event.defaultPrevented).toBe(true)
    expect(menu()).toBeNull()
  })

  it('copies the selected text it was opened on', async () => {
    await setup()
    const range = document.createRange()
    range.selectNodeContents(document.querySelector('#words')!)
    window.getSelection()!.addRange(range)
    await rightClick('#words')
    expect(actions()).toEqual(['复制'])
    await choose('copy')
    expect(clipboard.writeText).toHaveBeenCalledWith('Some words')
    expect(menu()).toBeNull()
  })

  it('edits a text field: cut, copy, paste and select all, pasting over the selection', async () => {
    await setup()
    const field = document.querySelector<HTMLInputElement>('#field')!
    const typed = vi.fn()
    field.addEventListener('input', typed)
    field.focus()
    field.setSelectionRange(6, 11)
    await rightClick('#field')
    expect(actions()).toEqual(['剪切', '复制', '粘贴', '全选'])
    await choose('paste')
    expect(clipboard.readText).toHaveBeenCalled()
    expect(field.value).toBe('hello there')
    expect(typed).toHaveBeenCalled()
    expect(document.activeElement).toBe(field)

    field.setSelectionRange(0, 6)
    await rightClick('#field')
    await choose('cut')
    expect(clipboard.writeText).toHaveBeenCalledWith('hello ')
    expect(field.value).toBe('there')
  })

  it('hides 粘贴 where the clipboard cannot be read, or reading it was refused', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: clipboard.writeText } })
    await setup()
    document.querySelector<HTMLInputElement>('#field')!.setSelectionRange(0, 5)
    await rightClick('#field')
    expect(actions()).toEqual(['剪切', '复制', '全选'])
    mounted?.unmount()

    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard })
    Object.defineProperty(navigator, 'permissions', { configurable: true, value: { query: vi.fn(async () => ({ state: 'denied' })) } })
    await setup()
    await flushPromises()
    await rightClick('#field')
    expect(actions()).toEqual(['全选'])
    Reflect.deleteProperty(navigator, 'permissions')
  })

  it('opens the console’s own links in the app and outside links in a new window, and copies either', async () => {
    const { router } = await setup()
    await rightClick('#inner')
    expect(actions()).toEqual(['打开', '复制链接'])
    await choose('open')
    expect(router.currentRoute.value.fullPath).toBe('/inbox')

    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    await rightClick('#outer')
    await choose('open')
    expect(open).toHaveBeenCalledWith('https://example.com/docs', '_blank', 'noopener,noreferrer')
    await rightClick('#outer')
    await choose('copyLink')
    expect(clipboard.writeText).toHaveBeenCalledWith('https://example.com/docs')
  })

  it('gives an FLA portrait the dock pins menu, read from its record, even inside a link', async () => {
    await setup()
    await rightClick('#portrait')
    await flushPromises()
    expect(document.querySelector('[data-app-context-menu]')?.textContent).toContain('Ada Vale')
    expect([...document.querySelectorAll('[data-app-context-menu] [data-portrait-action]')].map(item => item.getAttribute('data-portrait-action'))).toEqual(['home', 'workbench', 'copy-mention'])
    expect(actions()).toEqual([])
    expect(document.querySelector('[data-app-context-menu]')?.textContent).not.toContain('取消置顶')
    // 复制 #FLA, as on the FLAs list.
    document.querySelector<HTMLElement>('[data-app-context-menu] [data-portrait-action="copy-mention"]')!.click()
    await flushPromises()
    expect(clipboard.writeText).toHaveBeenCalledWith('#FLA Ada Vale ')
  })

  it('names a built-in role it cannot read by its current name, with nothing to copy', async () => {
    await setup()
    getJson.mockRejectedValue(new Error('not found'))
    document.querySelector('#portrait')!.setAttribute('data-agent-portrait', 'employee.tonborg')
    await rightClick('#portrait')
    await flushPromises()
    expect(menu()?.querySelector('[role="group"], [data-slot="context-menu-label"]')?.textContent ?? menu()?.textContent).toContain('Tonborg')
    expect(menu()?.querySelector('[data-portrait-action="copy-mention"]')).toBeNull()
  })

  it("opens the FLA's page from a face that is its own link, never from its own page", async () => {
    const { router } = await setup()
    useConsoleStore().state = { mode: 'personal_only', personalSpaces: [{ id: 'space', name: 'Synthetic' }], activePersonalSpaceId: 'space' } as never
    const face = document.querySelector<HTMLElement>('#peek-portrait')!
    face.click()
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/')
    face.setAttribute('data-agent-link', 'true')
    face.click()
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/agents/space/agent-1?tab=overview')
    await router.push('/agents/space/agent-1?tab=workbench')
    face.click()
    await flushPromises()
    expect(router.currentRoute.value.query.tab).toBe('workbench')
  })

  it('opens a portrait menu inside the dialog it was opened from', async () => {
    await setup()
    await rightClick('#peek-portrait')
    expect(document.querySelector('#peek [data-app-context-menu]')).not.toBeNull()
  })

  it('offers nothing on an FLA portrait on that FLA own page', async () => {
    const { router } = await setup()
    await router.push('/agents/space/agent-1')
    await flushPromises()
    await rightClick('#portrait')
    expect(menu()).toBeNull()
    await router.push('/agents/space/agent-2')
    await flushPromises()
    await rightClick('#portrait')
    expect(menu()).not.toBeNull()
  })

  it('stays open through a moment of lost window focus, and closes when the focus stays away', async () => {
    await setup()
    await rightClick('#portrait')
    vi.useFakeTimers()
    try {
      const focused = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
      window.dispatchEvent(new Event('blur'))
      await vi.advanceTimersByTimeAsync(400)
      expect(menu()).not.toBeNull()
      focused.mockReturnValue(false)
      window.dispatchEvent(new Event('blur'))
      await vi.advanceTimersByTimeAsync(400)
    } finally { vi.useRealTimers() }
    await flushPromises()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(document.querySelector('[data-app-context-menu][data-state="open"]')).toBeNull()
  })

  it('shakes the face of a clicked FLA portrait, and not under reduced motion', async () => {
    await setup()
    const face = document.querySelector<HTMLElement>('#face')!
    document.querySelector<HTMLElement>('#portrait')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(face.classList.contains('agent-portrait-shake')).toBe(true)
  })

  it('lets a component with its own right-click menu keep it', async () => {
    await setup()
    const event = await rightClick('#own')
    expect(event.defaultPrevented).toBe(true)
    expect(document.querySelector('[data-own-menu]')).not.toBeNull()
    expect(menu()).toBeNull()
  })

  it('opens where the right-click landed and closes on Escape and on scroll', async () => {
    await setup()
    await rightClick('#inner', { clientX: 120, clientY: 80 })
    const anchor = document.querySelector<HTMLElement>('.app-context-anchor')!
    expect([anchor.style.left, anchor.style.top]).toEqual(['120px', '80px'])
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(menu()).toBeNull()

    await rightClick('#inner')
    expect(menu()).not.toBeNull()
    document.querySelector('#plain')!.dispatchEvent(new Event('scroll'))
    await flushPromises()
    expect(menu()).toBeNull()
  })
})
