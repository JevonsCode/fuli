import { computed, inject, ref, watch } from 'vue'
import { routeLocationKey, routerKey } from 'vue-router'

// A quick look (Peek) is part of the URL as ?item=<space>/<id>, so a refresh
// or a shared link opens the same record even before (or without) the
// collection behind it, and Back closes it. Both parts are URI-encoded, so an
// id may contain any character.
const PEEK_QUERY = 'item'

interface PeekItem { spaceId: string; id: string }

/** The ?item= value for a record; a page that turns its own link into a Peek uses it. */
export function peekItemValue(item: PeekItem) {
  return `${encodeURIComponent(item.spaceId)}/${encodeURIComponent(item.id)}`
}

function readPeekItem(value: unknown): PeekItem | null {
  if (typeof value !== 'string') return null
  const parts = value.split('/')
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null
  try {
    return { spaceId: decodeURIComponent(parts[0]), id: decodeURIComponent(parts[1]) }
  } catch {
    return null
  }
}

// Embedded without a router (component previews and tests) the quick look is
// local state: it opens and closes the same way, only without history.
function localPeek() {
  const item = ref<PeekItem | null>(null)
  return {
    item: computed(() => item.value),
    open: async (next: PeekItem) => { item.value = next },
    close: async () => { item.value = null },
  }
}

export function useRoutePeek() {
  const route = inject(routeLocationKey, null)
  const router = inject(routerKey, null)
  if (!route || !router) return localPeek()
  const item = computed(() => readPeekItem(route.query[PEEK_QUERY]))
  // True while the entry on screen is the one this page pushed: closing then
  // goes Back, so the history holds no second copy of the collection.
  let pushed = false
  watch(item, value => { if (!value) pushed = false })

  // Opening resolves once the URL names the item, so a caller can wait for it.
  async function open(next: PeekItem) {
    const value = peekItemValue(next)
    if (route!.query[PEEK_QUERY] === value) return
    const replace = Boolean(item.value)
    pushed = pushed || !replace
    await router![replace ? 'replace' : 'push']({ query: { ...route!.query, [PEEK_QUERY]: value } })
  }

  async function close() {
    if (!item.value) return
    if (pushed) {
      pushed = false
      router!.back()
      return
    }
    const { [PEEK_QUERY]: _closed, ...query } = route!.query
    await router!.replace({ query })
  }

  return { item, open, close }
}
