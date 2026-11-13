import { useMutationObserver } from '@vueuse/core'
import { onBeforeUnmount, ref, shallowRef, watch, type Ref } from 'vue'

import { motionReduced } from '@/lib/motion-preference'
import { headingLabel } from '@/lib/page-outline'
import type { SettingsTab } from './settings-tabs'

/** A card of the open topic and the name it shows. */
export interface SettingsOutlineEntry { card: HTMLElement, label: string }

// A card is the one being read while it crosses the top third of the scrolling side.
const READING_BAND = '0px 0px -66% 0px'

// The name a card already gives itself: its labelling heading, its own label, or its first heading.
function cardLabel(card: HTMLElement): string {
  const labelledBy = card.getAttribute('aria-labelledby')
  const heading = (labelledBy && card.ownerDocument.getElementById(labelledBy)) || card.querySelector<HTMLElement>('h2')
  return heading ? headingLabel(heading) : card.getAttribute('aria-label')?.trim() ?? ''
}

const sameEntries = (a: readonly SettingsOutlineEntry[], b: readonly SettingsOutlineEntry[]) =>
  a.length === b.length && a.every((entry, index) => entry.card === b[index]!.card && entry.label === b[index]!.label)

/**
 * The open topic's outline, read from the cards it renders now, so a card left
 * out (v-if) has no entry and a new card gets one by itself. While searching
 * the outline is empty: the matches span every topic. The card being read is
 * followed with an IntersectionObserver on the scrolling side.
 */
export function useSettingsOutline(scroller: Ref<HTMLElement | null>, tab: Ref<SettingsTab>, searching: () => boolean) {
  const entries = shallowRef<SettingsOutlineEntry[]>([])
  const current = ref(0)

  function read() {
    const panel = searching() ? null : scroller.value?.querySelector<HTMLElement>(`[data-settings-tab="${tab.value}"]`)
    const next = panel
      ? [...panel.querySelectorAll<HTMLElement>('.settings-card')].map(card => ({ card, label: cardLabel(card) })).filter(entry => entry.label)
      : []
    if (!sameEntries(next, entries.value)) entries.value = next
  }
  watch([scroller, tab, searching], read, { immediate: true, flush: 'post' })
  useMutationObserver(scroller, read, { childList: true, subtree: true, characterData: true })

  // Another topic starts at its top. While searching every topic's panels share
  // this scrolling side, so go to the clicked topic's own panel instead.
  watch(tab, () => {
    current.value = 0
    if (!scroller.value) return
    if (searching()) {
      scroller.value.querySelector<HTMLElement>(`[data-settings-tab="${tab.value}"]`)
        ?.scrollIntoView({ block: 'start', behavior: motionReduced() ? 'auto' : 'smooth' })
    } else {
      scroller.value.scrollTop = 0
    }
  }, { flush: 'post' })

  let observer: IntersectionObserver | null = null
  const crossing = new Set<Element>()
  watch(entries, list => {
    observer?.disconnect()
    crossing.clear()
    if (!scroller.value || typeof IntersectionObserver === 'undefined') return
    observer = new IntersectionObserver(changes => {
      for (const change of changes) {
        if (change.isIntersecting) crossing.add(change.target)
        else crossing.delete(change.target)
      }
      const reading = entries.value.findIndex(entry => crossing.has(entry.card))
      if (reading >= 0) current.value = reading
    }, { root: scroller.value, rootMargin: READING_BAND })
    for (const entry of list) observer.observe(entry.card)
  })
  onBeforeUnmount(() => observer?.disconnect())

  function go(index: number) {
    entries.value[index]?.card.scrollIntoView({ block: 'start', behavior: motionReduced() ? 'auto' : 'smooth' })
    current.value = index
  }

  return { entries, current, go }
}
