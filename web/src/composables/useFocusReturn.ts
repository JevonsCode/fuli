import { nextTick, onBeforeUnmount, onMounted, watch, type Ref } from 'vue'
import { useRouter } from 'vue-router'

// In-memory only, like scroll positions: the record a reader last opened on
// each collection, by the collection's key.
const opened = new Map<string, string>()

/** Focus the card or row marked data-return-focus="<id>": its first focusable, or itself. */
export function focusReturnTarget(root: HTMLElement | null | undefined, id: string) {
  if (!root || !id) return false
  // Quoted attribute value: only a quote or a backslash needs escaping.
  const marked = root.querySelector<HTMLElement>(`[data-return-focus="${id.replace(/["\\]/g, '\\$&')}"]`)
  const target = marked?.matches('a[href], button, [tabindex]')
    ? marked
    : marked?.querySelector<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])')
  if (!target) return false
  target.focus({ preventScroll: true })
  return true
}

/**
 * Coming Back to a collection puts focus on the card or row the reader
 * opened, so the keyboard continues where it left off (the scroll position is
 * restored separately). Cards and rows opt in with data-return-focus="<id>".
 * Only a Back/Forward return counts; arriving from the navigation does not.
 */
export function useFocusReturn(root: Ref<HTMLElement | null>, key: string, ready: Ref<boolean>) {
  // The router marks an entry it has left forward from; a fresh visit has none.
  const returning = Boolean((useRouter().options.history.state as { forward?: unknown } | null)?.forward)
  let settled = false
  function remember(event: Event) {
    if (event instanceof KeyboardEvent && event.key !== 'Enter' && event.key !== ' ') return
    const marked = (event.target as Element | null)?.closest?.('[data-return-focus]')
    if (marked instanceof HTMLElement && marked.dataset.returnFocus) opened.set(key, marked.dataset.returnFocus)
  }
  onMounted(() => {
    root.value?.addEventListener('click', remember, true)
    root.value?.addEventListener('keydown', remember, true)
  })
  onBeforeUnmount(() => {
    root.value?.removeEventListener('click', remember, true)
    root.value?.removeEventListener('keydown', remember, true)
  })
  watch(ready, async (value) => {
    if (!value || settled) return
    settled = true
    const id = opened.get(key)
    if (!returning || !id) return
    await nextTick()
    focusReturnTarget(root.value, id)
  }, { immediate: true })
  /** Record an opening that did not start from a click inside the collection (a Peek's own link). */
  return { remember: (id: string) => { opened.set(key, id) } }
}
