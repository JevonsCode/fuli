import { computed, watch, type Ref } from 'vue'

import { focusReturnTarget } from '@/composables/useFocusReturn'
import { useRoutePeek } from '@/composables/useRoutePeek'
import type { KnowledgeItem } from '@/types'
import { knowledgeItemKey } from './model'

/**
 * The quick look of a knowledge item on a collection page (知识整理, 偏好),
 * kept in the URL as ?item=<space>/<kind>:<id> (D-03 §2): a link or a refresh
 * opens the same item once the collection holds it, Esc and Back close it, and
 * focus returns to what opened it, or to the item's row after a direct link.
 * Rows mark themselves with data-return-focus="<kind>:<id>".
 */
export function useKnowledgeItemPeek(options: {
  spaceId: Ref<string | undefined>
  items: Ref<KnowledgeItem[]>
  /** True only once the whole collection was read successfully, so a missing item is really missing. */
  settled: Ref<boolean>
  root: Ref<HTMLElement | null>
}) {
  const peek = useRoutePeek()
  const key = computed(() => {
    const requested = peek.item.value
    return requested && requested.spaceId === options.spaceId.value ? requested.id : ''
  })
  const item = computed(() =>
    key.value ? options.items.value.find(candidate => knowledgeItemKey(candidate) === key.value) ?? null : null)

  // An item the completely read collection does not hold (removed, or from
  // another space) leaves the URL instead of waiting there unseen. A partial
  // read never decides that: the link stays until a retry reads the rest.
  watch([options.settled, peek.item, item], ([settled, requested, found]) => {
    if (settled && requested && !found) void peek.close()
  })

  let opener: HTMLElement | null = null
  let lastKey = ''
  watch(key, value => { if (value) lastKey = value }, { immediate: true })

  function open(next: KnowledgeItem) {
    const active = document.activeElement
    if (!peek.item.value) opener = active instanceof HTMLElement && active !== document.body ? active : null
    return peek.open({ spaceId: options.spaceId.value ?? '', id: knowledgeItemKey(next) })
  }

  /** The Peek's close-auto-focus: back to the opener, or to the item's row after a direct link. */
  function returnFocus(event: Event) {
    event.preventDefault()
    const target = opener
    opener = null
    if (target?.isConnected) target.focus({ preventScroll: true })
    else focusReturnTarget(options.root.value, lastKey)
  }

  /** The URL names an item in this space that the collection does not hold (yet). */
  const pending = computed(() => Boolean(key.value) && !item.value)

  return { item, pending, open, close: peek.close, returnFocus }
}
