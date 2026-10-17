import { nextTick, watch, type Ref } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'

// In-memory only: positions survive in-app navigation, not reloads.
const positions = new Map<string, number>()

/**
 * Restore a page's own scroll container when the reader comes back to it.
 * The router only restores window scroll, and console pages scroll inside
 * their `.view` element. Each leave saves the latest position; it is
 * applied once, when the page's content is first ready again.
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
      if (scroller.value) scroller.value.scrollTop = top
    },
    { immediate: true },
  )
}
