import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, withDirectives } from 'vue'

import { connectDesktopClient, DESKTOP_WINDOW_HANDLER, readLaunchAtLogin, saveLaunchAtLogin, vWindowDrag } from './desktop-client'

type Desktop = {
  fuliDesktopClient?: unknown
  flutter_inappwebview?: { callHandler: (...args: unknown[]) => Promise<unknown> }
}

const TopBar = defineComponent({
  render: () => withDirectives(h('header', { 'data-bar': '' }, [h('h1', { 'data-title': '' }, 'Synthetic'), h('button', { 'data-control': '' }, 'Refresh')]), [[vWindowDrag]]),
})

function inClient(platform = 'windows', captionStart = 0, captionEnd = 138, answer: (...args: unknown[]) => unknown = () => undefined) {
  const callHandler = vi.fn(async (...args: unknown[]) => answer(...args))
  Object.assign(window as Desktop, { fuliDesktopClient: { platform, captionStart, captionEnd }, flutter_inappwebview: { callHandler } })
  return callHandler
}

function press(target: Element, type: string, init: Record<string, number | string> = {}) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init })
  Object.defineProperty(event, 'pointerType', { value: 'mouse' })
  target.dispatchEvent(event)
  return event
}

afterEach(() => {
  delete (window as Desktop).fuliDesktopClient
  delete (window as Desktop).flutter_inappwebview
})

describe('connectDesktopClient', () => {
  it('marks the page and keeps room for the window controls inside the desktop client', () => {
    inClient('windows', 0, 138)
    const root = document.createElement('html')
    connectDesktopClient(root)
    expect(root.dataset.desktopClient).toBe('windows')
    expect(root.style.getPropertyValue('--desktop-caption-start')).toBe('0px')
    expect(root.style.getPropertyValue('--desktop-caption-end')).toBe('146px')
  })

  it('reserves the traffic lights on macOS', () => {
    inClient('macos', 78, 0)
    const root = document.createElement('html')
    connectDesktopClient(root)
    expect(root.dataset.desktopClient).toBe('macos')
    expect(root.style.getPropertyValue('--desktop-caption-start')).toBe('86px')
    expect(root.style.getPropertyValue('--desktop-caption-end')).toBe('0px')
  })

  it('changes nothing in a browser or for a malformed global', () => {
    for (const client of [undefined, { platform: 'linux', captionStart: 0, captionEnd: 0 }, { platform: 'windows', captionStart: -1, captionEnd: 'x' }]) {
      ;(window as Desktop).fuliDesktopClient = client
      const root = document.createElement('html')
      connectDesktopClient(root)
      expect(root.dataset.desktopClient).toBeUndefined()
      expect(root.getAttribute('style')).toBeNull()
    }
  })
})

describe('v-window-drag', () => {
  it('moves the window once the pointer leaves the press on the empty bar, and a double click maximises', () => {
    const callHandler = inClient()
    const bar = mount(TopBar, { attachTo: document.body })
    const title = bar.get('[data-title]').element

    const down = press(title, 'pointerdown', { clientX: 10, clientY: 10 })
    expect(down.defaultPrevented).toBe(true)
    press(title, 'pointermove', { clientX: 11, clientY: 11, buttons: 1 })
    expect(callHandler).not.toHaveBeenCalled()
    press(title, 'pointermove', { clientX: 30, clientY: 12, buttons: 1 })
    press(title, 'pointermove', { clientX: 60, clientY: 14, buttons: 1 })
    expect(callHandler.mock.calls).toEqual([[DESKTOP_WINDOW_HANDLER, 'drag']])

    press(bar.get('[data-bar]').element, 'dblclick')
    expect(callHandler.mock.calls.at(-1)).toEqual([DESKTOP_WINDOW_HANDLER, 'toggleMaximize'])
    bar.unmount()
  })

  it("leaves the bar's own controls alone", () => {
    const callHandler = inClient()
    const bar = mount(TopBar, { attachTo: document.body })
    const control = bar.get('[data-control]').element

    const down = press(control, 'pointerdown', { clientX: 10, clientY: 10 })
    press(control, 'pointermove', { clientX: 60, clientY: 10, buttons: 1 })
    press(control, 'dblclick')
    expect(down.defaultPrevented).toBe(false)
    expect(callHandler).not.toHaveBeenCalled()
    bar.unmount()
  })

  it('does nothing in a browser', () => {
    const bar = mount(TopBar, { attachTo: document.body })
    const title = bar.get('[data-title]').element
    const down = press(title, 'pointerdown', { clientX: 10, clientY: 10 })
    press(title, 'pointermove', { clientX: 60, clientY: 10, buttons: 1 })
    expect(down.defaultPrevented).toBe(false)
    bar.unmount()
  })
})

describe('launch at login', () => {
  it("reads and saves the Windows client's setting through its bridge", async () => {
    let held = true
    const callHandler = inClient('windows', 0, 138, (_name, request) => {
      const { enabled } = request as { enabled?: boolean }
      if (enabled !== undefined) held = enabled
      return { available: true, enabled: held }
    })
    expect(await readLaunchAtLogin()).toBe(true)
    expect(await saveLaunchAtLogin(false)).toBe(false)
    expect(callHandler.mock.calls).toEqual([['fuliLaunchAtLogin', {}], ['fuliLaunchAtLogin', { enabled: false }]])
  })

  it('is not offered in a browser, on macOS, by a client without it, or when the client fails', async () => {
    expect(await readLaunchAtLogin()).toBeNull()
    const mac = inClient('macos', 78, 0, () => ({ available: true, enabled: true }))
    expect(await readLaunchAtLogin()).toBeNull()
    expect(mac).not.toHaveBeenCalled()
    inClient('windows', 0, 138, () => ({ available: false }))
    expect(await readLaunchAtLogin()).toBeNull()
    inClient('windows', 0, 138, () => { throw new Error('reg.exe did not run') })
    expect(await saveLaunchAtLogin(true)).toBeNull()
  })
})
