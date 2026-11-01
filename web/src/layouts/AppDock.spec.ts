import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getJson } from '@/api/client'
import { POINTER_INTENT_MS } from '@/composables/usePointerPresence'
import AppDock from './AppDock.vue'
import { activeDestination, navDestinations } from './nav-destinations'

vi.mock('@/api/client', () => ({ getJson: vi.fn(), putJson: vi.fn(), patchJson: vi.fn(), postJson: vi.fn(), deleteJson: vi.fn() }))

const SPACE = 'synthetic-space'
const destinations = navDestinations({ spaceId: SPACE, publicProjects: false }).filter(item => item.placement === 'dock')

beforeEach(() => {
  vi.mocked(getJson).mockReset()
  vi.mocked(getJson).mockImplementation(async (url: string) => {
    if (url === `/api/agent-pins?personalSpaceId=${SPACE}`) return { revision: 1, agentIds: ['agent-a'] }
    if (url === `/api/project-agents/agent-a?personalSpaceId=${SPACE}`)
      return { agentId: 'agent-a', personalSpaceId: SPACE, profile: { name: 'Synthetic Ava', displayName: 'Synthetic Ava' } }
    if (url.startsWith('/api/project-agent-tasks?')) return { tasks: [] }
    if (url.startsWith('/api/agent-workflows?')) return { workflows: [] }
    throw new Error(`Unexpected request: ${url}`)
  })
})
afterEach(() => {
  document.body.innerHTML = ''
})

async function setup(path: string) {
  setActivePinia(createPinia())
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:any(.*)*', component: { template: '<div />' } }] })
  await router.push(path)
  const activeKey = () => activeDestination(destinations, router.currentRoute.value.path)?.key
  const wrapper = mount(AppDock, {
    props: { destinations, activeKey: activeKey(), spaceId: SPACE, folded: true },
    global: { plugins: [router] },
    attachTo: document.body,
  })
  router.afterEach(() => { void wrapper.setProps({ activeKey: activeKey() }) })
  await flushPromises()
  return { wrapper, router }
}

// The pointer somewhere on the page: over `target`, at a point.
function pointerAt(target: EventTarget, clientX: number, clientY: number) {
  target.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX, clientY }))
}
const FAR = 2000
// Real time: the menu's own outside-click and focus handling run on timers too.
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe('AppDock folding', () => {
  it('stays open after a click, onto another folding page, until the pointer has left for the intent delay', async () => {
    const { wrapper, router } = await setup('/knowledge')
    const dock = wrapper
    expect(dock.classes()).not.toContain('is-open')
    await dock.trigger('pointerenter')
    expect(dock.classes()).toContain('is-open')

    const projects = wrapper.get('[data-destination="projects"]')
    await projects.trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.path.startsWith('/personal/')).toBe(true)
    expect(dock.attributes('data-folded')).toBe('true')
    expect(dock.classes()).toContain('is-open')

    // Over the dock (or, while a page changes, anywhere in its box): still open.
    pointerAt(projects.element, 10, 10)
    await wait(POINTER_INTENT_MS * 2)
    await flushPromises()
    expect(dock.classes()).toContain('is-open')

    // Out, then back in before the delay: still open.
    pointerAt(document.body, FAR, FAR)
    await wait(POINTER_INTENT_MS / 2)
    pointerAt(projects.element, 10, 10)
    await wait(POINTER_INTENT_MS + 60)
    await flushPromises()
    expect(dock.classes()).toContain('is-open')

    // Out for the delay: folded.
    pointerAt(document.body, FAR, FAR)
    await wait(POINTER_INTENT_MS + 60)
    await flushPromises()
    expect(dock.classes()).not.toContain('is-open')
    wrapper.unmount()
  })

  it('opens on keyboard focus, folds on Esc keeping focus on the current link, and folds when focus leaves', async () => {
    const { wrapper } = await setup('/knowledge')
    const dock = wrapper
    const chat = wrapper.get<HTMLAnchorElement>('[data-destination="chat"]')
    // jsdom does not track the keyboard for :focus-visible; here every focus is the keyboard's.
    const matches = Element.prototype.matches
    const focusVisible = vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector: string) {
      return selector === ':focus-visible' ? this === document.activeElement : matches.call(this, selector)
    })
    chat.element.focus()
    await flushPromises()
    expect(dock.classes()).toContain('is-open')

    await chat.trigger('keydown', { key: 'Escape' })
    expect(dock.classes()).not.toContain('is-open')
    expect(document.activeElement).toBe(wrapper.get('[data-destination="memory"]').element)
    expect(dock.classes()).not.toContain('is-open')

    // The next keyboard move inside opens it again (never focus on a hidden link); focus leaving folds it.
    chat.element.focus()
    await flushPromises()
    expect(dock.classes()).toContain('is-open')
    const outside = document.body.appendChild(document.createElement('button'))
    outside.focus()
    await flushPromises()
    expect(dock.classes()).not.toContain('is-open')
    focusVisible.mockRestore()
    wrapper.unmount()
  })
})

describe('AppDock pinned FLA menu', () => {
  async function openMenu(by: 'pointer' | 'keyboard') {
    const context = await setup('/project-agents')
    const pin = context.wrapper.get<HTMLAnchorElement>('[data-pinned-agent="agent-a"]')
    // A right press focuses the portrait in Chromium, as keyboard focus does.
    pin.element.focus()
    await context.wrapper.trigger('pointerenter')
    if (by === 'pointer') pin.element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 2 }))
    else pin.element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ContextMenu' }))
    await pin.trigger('contextmenu', { clientX: 40, clientY: 600 })
    await flushPromises()
    return { ...context, pin, capsule: () => context.wrapper.get('.dock-pins') }
  }
  const menu = () => document.querySelector('[data-pin-menu]')
  const escape = async () => {
    (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }))
    await flushPromises()
    // The menu hands focus back a moment after it closes.
    await wait(20)
  }

  it('heads the pinned capsule with the button name, above the first portrait', async () => {
    const { wrapper } = await setup('/project-agents')
    const pins = wrapper.get('.app-dock-pins')
    expect(pins.element.firstElementChild?.matches('[data-pins-label]')).toBe(true)
    expect(pins.get('[data-pins-label]').text()).toBe('FLAs')
    wrapper.unmount()
  })

  it('holds the capsule from the right press, and the open menu leaves the page under the pointer', async () => {
    const { wrapper } = await setup('/project-agents')
    const pin = wrapper.get<HTMLAnchorElement>('[data-pinned-agent="agent-a"]')
    pin.element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 2 }))
    await flushPromises()
    // Held before the menu opens, so the capsule never starts to fold in between.
    expect(wrapper.get('.dock-pins').classes()).toContain('is-holding')
    await pin.trigger('contextmenu', { clientX: 40, clientY: 600 })
    await flushPromises()
    expect(document.querySelector('[data-pin-menu]')).not.toBeNull()
    // Not modal: the page keeps its pointer, so the capsule keeps its hover.
    expect(document.body.style.pointerEvents).not.toBe('none')
    expect(wrapper.get('.dock-pins').classes()).toContain('is-holding')
    wrapper.unmount()
  })

  it('keeps the capsule open while the menu is, then closes both once the pointer has left both', async () => {
    const { wrapper, pin, capsule } = await openMenu('pointer')
    expect(menu()).not.toBeNull()
    expect(capsule().classes()).toContain('is-holding')
    // The dock stays open while its pin menu is.
    pointerAt(document.body, FAR, FAR)
    // Inside the capsule's box or the gap above it (the bridge): nothing closes.
    pointerAt(document.documentElement, 5, 5)
    await wait(POINTER_INTENT_MS * 2)
    await flushPromises()
    expect(menu()).not.toBeNull()
    expect(capsule().classes()).toContain('is-holding')
    expect(wrapper.classes()).toContain('is-open')

    pointerAt(document.documentElement, FAR, FAR)
    await wait(POINTER_INTENT_MS + 60)
    await flushPromises()
    expect(menu()).toBeNull()
    expect(capsule().classes()).not.toContain('is-holding')
    // Focus did not go back to the portrait, where it would latch the capsule open.
    expect(document.activeElement).not.toBe(pin.element)
    wrapper.unmount()
  })

  it('closes the menu and the capsule together on Esc, even under the pointer, until the pointer leaves', async () => {
    const { wrapper, pin, capsule } = await openMenu('pointer')
    await escape()
    expect(menu()).toBeNull()
    expect(capsule().classes()).toContain('is-dismissed')
    expect(capsule().classes()).not.toContain('is-holding')
    expect(document.activeElement).not.toBe(pin.element)
    pointerAt(document.documentElement, FAR, FAR)
    await wait(POINTER_INTENT_MS + 60)
    await flushPromises()
    expect(capsule().classes()).not.toContain('is-dismissed')
    wrapper.unmount()
  })

  it('closes both on a click elsewhere', async () => {
    const { wrapper, capsule } = await openMenu('pointer')
    const outside = document.body.appendChild(document.createElement('div'))
    outside.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    await flushPromises()
    expect(menu()).toBeNull()
    expect(capsule().classes()).toContain('is-dismissed')
    wrapper.unmount()
  })

  it('closes both after choosing an item', async () => {
    const { wrapper, router, capsule } = await openMenu('pointer')
    const home = document.querySelector<HTMLElement>('[data-pin-action="home"]')!
    home.click()
    await flushPromises()
    expect(router.currentRoute.value.path).toBe(`/agents/${SPACE}/agent-a`)
    expect(menu()).toBeNull()
    expect(capsule().classes()).not.toContain('is-holding')
    expect(capsule().classes()).toContain('is-dismissed')
    wrapper.unmount()
  })

  it('gives focus back to the portrait when the menu was opened from the keyboard', async () => {
    const { wrapper, pin, capsule } = await openMenu('keyboard')
    await escape()
    expect(menu()).toBeNull()
    expect(document.activeElement).toBe(pin.element)
    expect(capsule().classes()).not.toContain('is-dismissed')
    wrapper.unmount()
  })
})
