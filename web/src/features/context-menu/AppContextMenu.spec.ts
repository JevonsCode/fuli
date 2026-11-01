import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { defineComponent, h } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu'
import AppContextMenu from './AppContextMenu.vue'

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
  h(ContextMenu, () => [
    h(ContextMenuTrigger, { asChild: true }, () => h('div', { id: 'own' }, 'Pinned FLA')),
    h(ContextMenuContent, { 'data-own-menu': '' }, () => h(ContextMenuItem, () => 'Unpin')),
  ]),
  h(AppContextMenu),
]))

async function setup() {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { render: () => null } }, { path: '/inbox', component: { render: () => null } }] })
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
