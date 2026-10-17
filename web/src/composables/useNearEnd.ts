import { onBeforeUnmount, ref, watch, type Ref } from 'vue'

/**
 * Whether a marker at the end of a list is within `margin` pixels of its
 * scroll container's visible area. Without IntersectionObserver it stays
 * false and the page's explicit "load more" control is the only trigger.
 */
export function useNearEnd(
  marker: Ref<HTMLElement | null>,
  scroller: Ref<HTMLElement | null>,
  margin = 600,
) {
  const near = ref(false)
  let observer: IntersectionObserver | null = null

  function disconnect() {
    observer?.disconnect()
    observer = null
  }

  watch([marker, scroller], ([element, root]) => {
    disconnect()
    near.value = false
    if (!element || typeof IntersectionObserver === 'undefined') return
    observer = new IntersectionObserver(
      (entries) => { near.value = entries.some((entry) => entry.isIntersecting) },
      { root, rootMargin: `0px 0px ${margin}px 0px` },
    )
    observer.observe(element)
  }, { immediate: true, flush: 'post' })

  onBeforeUnmount(disconnect)
  return near
}
