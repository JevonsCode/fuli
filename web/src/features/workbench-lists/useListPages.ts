import { onBeforeUnmount, ref, shallowRef, watch, type Ref } from 'vue'

export interface ListPage<T> {
  items: T[]
  nextCursor: string | null
  /** How many match; only the first page has to say. */
  total?: number | null
}

export interface ListSource<T> {
  /** Changes whenever what the list answers changes (space, filters, sort). */
  key: string
  read: (cursor: string | null, signal: AbortSignal) => Promise<ListPage<T>>
}

/**
 * A list read a page at a time. A new key reads its first page again while
 * the rows already shown stay until the answer replaces them; a page still on
 * its way for an older key is dropped. `more()` appends the next page.
 */
export function useListPages<T>(source: Ref<ListSource<T> | null>) {
  const items = shallowRef<T[]>([])
  const total = ref<number | null>(null)
  const nextCursor = ref<string | null>(null)
  const loading = ref(false)
  const loadingMore = ref(false)
  const error = ref<unknown>(null)
  let controller: AbortController | null = null

  function start() {
    controller?.abort()
    controller = new AbortController()
    return controller
  }

  async function first() {
    const current = source.value
    const request = start()
    loadingMore.value = false
    error.value = null
    if (!current) { items.value = []; total.value = null; nextCursor.value = null; loading.value = false; return }
    loading.value = true
    try {
      const page = await current.read(null, request.signal)
      if (request.signal.aborted) return
      items.value = page.items
      total.value = page.total ?? page.items.length
      nextCursor.value = page.nextCursor
    } catch (cause) {
      if (!request.signal.aborted) error.value = cause
    } finally {
      if (!request.signal.aborted) loading.value = false
    }
  }

  async function more() {
    const current = source.value
    const after = nextCursor.value
    if (!current || !after || loading.value || loadingMore.value || error.value) return
    const request = controller ?? start()
    loadingMore.value = true
    try {
      const page = await current.read(after, request.signal)
      if (request.signal.aborted || nextCursor.value !== after) return
      items.value = [...items.value, ...page.items]
      nextCursor.value = page.nextCursor
    } catch (cause) {
      if (!request.signal.aborted) error.value = cause
    } finally {
      if (!request.signal.aborted) loadingMore.value = false
    }
  }

  watch(() => source.value?.key ?? '', () => { void first() }, { immediate: true })
  onBeforeUnmount(() => controller?.abort())

  return { items, total, nextCursor, loading, loadingMore, error, reload: first, more }
}
