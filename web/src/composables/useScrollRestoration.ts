import { nextTick, watch, type Ref } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'

// In-memory only: positions survive in-app navigation, not reloads.
const positions = new Map<string, number>()
// Lists that lay out lazily (content-visibility, late images) grow for a few
// frames after they render; keep trying for about half a second.
const RESTORE_FRAMES = 30

/**
 * Restore a page's own scroll container when the reader comes back to it.
 * The router only restores window scroll, and console pages scroll inside
 * their `.view` element. Each leave saves the latest position; it is
 * applied once, when the page's content is first ready again, and re-applied
 * while the content is still growing tall enough to reach it, unless the
 * reader scrolls first.
 */
export function useScrollRestoration(
  scroller: Ref<HTMLElement | null>,
  key: string,
  ready: Ref<boolean>,
) {
  let settled = false
  onBeforeRouteLeave(() => {
    if (scroller.value) positions.set(key, scroller.value.scrollTop)
  })
  watch(
    ready,
    async (value) => {
      if (!value || settled) return
      settled = true
      const top = positions.get(key)
      positions.delete(key)
      if (top === undefined) return
      await nextTick()
      const element = scroller.value
      if (!element) return
      let readerScrolled = false
      const stop = () => { readerScrolled = true }
      const events = ['wheel', 'touchstart', 'keydown'] as const
      for (const name of events) element.addEventListener(name, stop, { once: true, passive: true })
      for (let frame = 0; frame < RESTORE_FRAMES && !readerScrolled; frame += 1) {
        element.scrollTop = top
        if (Math.abs(element.scrollTop - top) <= 1) break
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
      }
      for (const name of events) element.removeEventListener(name, stop)
    },
    { immediate: true },
  )
}
