// The FULI desktop client (desktop/flutter) shows the console in its own window, which has
// no OS title bar: the console's top bar is the title bar. Before the page runs, the client
// sets `window.fuliDesktopClient` to its platform and the room its window controls take in
// the top corners (its minimise, maximise and close on Windows, the traffic lights on
// macOS). The page then keeps the top bar clear of them (`data-desktop-client` and the
// `--desktop-caption-*` widths) and asks the client to move or maximise the window from the
// bar's empty area (`v-window-drag`). In a browser there is no such global and nothing here
// does anything.

import type { ObjectDirective } from 'vue'

interface DesktopBridge { callHandler(name: string, ...args: unknown[]): Promise<unknown> }
interface DesktopClient { platform: 'windows' | 'macos', captionStart: number, captionEnd: number }

export const DESKTOP_WINDOW_HANDLER = 'fuliWindow'
// Room between the window's controls and the top bar's own.
const CAPTION_GAP = 8
// How far the pointer moves before a press on the bar becomes a window drag, so a click stays a click.
const DRAG_SLOP = 4
// What a press on the bar is for itself rather than for moving the window.
const BAR_CONTROLS = 'a, button, input, select, textarea, label, summary, [role="button"], [role="tab"], [role="link"], [role="menuitem"], [contenteditable], [tabindex]:not([tabindex="-1"])'

export function desktopBridge(): DesktopBridge | null {
  const bridge = (window as { flutter_inappwebview?: DesktopBridge }).flutter_inappwebview
  return typeof bridge?.callHandler === 'function' ? bridge : null
}

function room(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function desktopClient(): DesktopClient | null {
  const client = (window as { fuliDesktopClient?: Partial<DesktopClient> }).fuliDesktopClient
  if (client?.platform !== 'windows' && client?.platform !== 'macos') return null
  const captionStart = room(client.captionStart)
  const captionEnd = room(client.captionEnd)
  return captionStart === null || captionEnd === null ? null : { platform: client.platform, captionStart, captionEnd }
}

/** Marks the page as shown by the desktop client and keeps its top bar clear of the window's controls. */
export function connectDesktopClient(root: HTMLElement = document.documentElement): void {
  const client = desktopClient()
  if (!client) return
  root.dataset.desktopClient = client.platform
  root.style.setProperty('--desktop-caption-start', client.captionStart ? `${client.captionStart + CAPTION_GAP}px` : '0px')
  root.style.setProperty('--desktop-caption-end', client.captionEnd ? `${client.captionEnd + CAPTION_GAP}px` : '0px')
}

// Starting FULI when the person signs in to Windows: the client's own setting, shared with its tray menu
// 「开机时启动」. Null where it is not offered: in a browser, on macOS, for a client that is not an
// installed FULI, or when the client could not read or write it.
const LOGIN_LAUNCH_HANDLER = 'fuliLaunchAtLogin'

async function askLaunchAtLogin(request: { enabled?: boolean }): Promise<boolean | null> {
  const bridge = desktopBridge()
  if (desktopClient()?.platform !== 'windows' || !bridge) return null
  try {
    const answer = await bridge.callHandler(LOGIN_LAUNCH_HANDLER, request) as { available?: unknown, enabled?: unknown } | null
    return answer?.available === true && typeof answer.enabled === 'boolean' ? answer.enabled : null
  } catch {
    return null
  }
}

/** Whether FULI starts at login, or null where the desktop client does not offer it. */
export const readLaunchAtLogin = () => askLaunchAtLogin({})

/** Saves the choice; answers what the client holds afterwards, or null when it could not. */
export const saveLaunchAtLogin = (enabled: boolean) => askLaunchAtLogin({ enabled })

function askWindow(action: 'drag' | 'toggleMaximize'): void {
  void desktopBridge()?.callHandler(DESKTOP_WINDOW_HANDLER, action).catch(() => undefined)
}

function onBarControl(event: Event): boolean {
  return event.target instanceof Element && event.target.closest(BAR_CONTROLS) !== null
}

// Dragging the element's empty area moves the window; a double click maximises or restores it.
function windowDragArea(area: HTMLElement): () => void {
  if (!desktopClient()) return () => undefined
  let pressed: { x: number, y: number } | null = null
  const down = (event: PointerEvent) => {
    if (event.button !== 0 || event.pointerType !== 'mouse' || onBarControl(event)) return
    // Not a text selection: the press is the window's.
    event.preventDefault()
    pressed = { x: event.clientX, y: event.clientY }
  }
  const move = (event: PointerEvent) => {
    if (!pressed || (event.buttons & 1) === 0) { pressed = null; return }
    if (Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) < DRAG_SLOP) return
    pressed = null
    askWindow('drag')
  }
  const up = () => { pressed = null }
  const doubleClick = (event: MouseEvent) => {
    if (!onBarControl(event)) askWindow('toggleMaximize')
  }
  area.addEventListener('pointerdown', down)
  area.addEventListener('pointermove', move)
  area.addEventListener('pointerup', up)
  area.addEventListener('dblclick', doubleClick)
  return () => {
    area.removeEventListener('pointerdown', down)
    area.removeEventListener('pointermove', move)
    area.removeEventListener('pointerup', up)
    area.removeEventListener('dblclick', doubleClick)
  }
}

const stopDragAreas = new WeakMap<HTMLElement, () => void>()

/** Makes an element's empty area the window's title bar inside the desktop client; a no-op in a browser. */
export const vWindowDrag: ObjectDirective<HTMLElement> = {
  mounted: area => { stopDragAreas.set(area, windowDragArea(area)) },
  unmounted: area => { stopDragAreas.get(area)?.(); stopDragAreas.delete(area) },
}
