import { onScopeDispose, watch, type Ref } from 'vue'

// The rest the pointer takes before a hover surface opens or closes: --motion-intent in theme/base.css.
export const POINTER_INTENT_MS = 280

// Whether a point lies in a box grown by `margin` on every side. The margin is
// a hover bridge: the gap between a surface and what it opened counts as inside.
export function pointInBox(x: number, y: number, box: DOMRect | null | undefined, margin = 0) {
  return Boolean(box) && x >= box!.left - margin && x <= box!.right + margin && y >= box!.top - margin && y <= box!.bottom + margin
}

// Watches the pointer while `active` and calls `leave` once it has stayed
// outside (per `inside`) for the intent delay; coming back in cancels it. It
// reads the whole document, so a surface in a portal, a modal menu that
// blocks pointer events, or a page change that covers the dock for a moment
// are judged by where the pointer is, not by which element got the event.
export function usePointerPresence({ active, inside, leave, delayMs = POINTER_INTENT_MS }: {
  active: Ref<boolean>
  inside: (event: PointerEvent) => boolean
  leave: () => void
  delayMs?: number
}) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const cancel = () => { clearTimeout(timer); timer = undefined }
  const schedule = () => {
    if (timer !== undefined) return
    timer = setTimeout(() => { timer = undefined; leave() }, delayMs)
  }
  const moved = (event: PointerEvent) => { if (inside(event)) cancel(); else schedule() }
  // The pointer left the window altogether.
  const exited = (event: PointerEvent) => { if (!event.relatedTarget) schedule() }

  function stop() {
    cancel()
    document.removeEventListener('pointermove', moved)
    document.removeEventListener('pointerout', exited)
  }
  watch(active, (on) => {
    stop()
    if (!on) return
    document.addEventListener('pointermove', moved, { passive: true })
    document.addEventListener('pointerout', exited, { passive: true })
  }, { immediate: true })
  onScopeDispose(stop)
}
