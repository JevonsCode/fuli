import { vi } from 'vitest'

// Native drag events for Pragmatic drag and drop in jsdom, following its
// Jest/jsdom testing guide: jsdom has no DragEvent, so this adds one with a
// minimal dataTransfer; events go to the element a browser would target
// (dragstart to the draggable, dragenter/dragover/drop to the target); the
// lift (onDragStart) runs one animation frame after dragstart. This proves
// event wiring and board logic only, not layout hit-testing, auto-scroll,
// the native preview or touch.

class TestDataTransfer {
  dropEffect = 'none'
  effectAllowed = 'all'
  readonly files = [] as unknown as FileList
  readonly items = [] as unknown as DataTransferItemList
  private readonly data = new Map<string, string>()
  get types() { return [...this.data.keys()] }
  setData(type: string, value: string) { this.data.set(type, value) }
  getData(type: string) { return this.data.get(type) ?? '' }
  clearData() { this.data.clear() }
  setDragImage() {}
}

class TestDragEvent extends MouseEvent {
  readonly dataTransfer: DataTransfer | null
  constructor(type: string, init: MouseEventInit & { dataTransfer?: DataTransfer | null } = {}) {
    super(type, init)
    this.dataTransfer = init.dataTransfer ?? null
  }
}

/** Installs DragEvent, the drag-handle hit test and a frame clock; returns the cleanup for afterEach. */
export function installDragEnvironment() {
  vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] })
  vi.stubGlobal('DragEvent', TestDragEvent)
  // jsdom applies no stylesheet, so every scroll container looks unscrollable to the auto-scroller.
  const warn = console.warn.bind(console)
  const warnings = vi.spyOn(console, 'warn').mockImplementation((message?: unknown, ...rest: unknown[]) => {
    if (typeof message === 'string' && message.startsWith('Auto scrolling has been attached to an element that appears not to be scrollable')) return
    warn(message, ...rest)
  })
  let pointed: Element[] = []
  Object.defineProperty(document, 'elementsFromPoint', { configurable: true, value: () => pointed })
  return {
    /** What a browser would hit-test under the pointer at dragstart (the drag handle). */
    pointAt(element: Element) { pointed = [element] },
    cleanup() {
      // Ends any drag a test left open (the library keeps one global drag) and its text-selection guard.
      window.dispatchEvent(new TestDragEvent('dragend', { bubbles: true, dataTransfer: new TestDataTransfer() as unknown as DataTransfer }))
      window.dispatchEvent(new MouseEvent('pointermove', { bubbles: true }))
      Reflect.deleteProperty(document, 'elementsFromPoint')
      warnings.mockRestore()
      vi.unstubAllGlobals()
      vi.useRealTimers()
    },
  }
}

export function fireDrag(target: EventTarget, type: 'dragstart' | 'dragenter' | 'drop' | 'dragend') {
  const event = new TestDragEvent(type, {
    bubbles: true,
    cancelable: true,
    dataTransfer: new TestDataTransfer() as unknown as DataTransfer,
  })
  target.dispatchEvent(event)
  return event
}

/** Runs the frame in which the library reports the lift. */
export function nextDragFrame() {
  vi.advanceTimersToNextFrame()
}
