<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue'
import { useEventListener, useMutationObserver } from '@vueuse/core'
import { Button } from '@/components/ui/button'
import { t } from '@/i18n'
import { motionReduced } from '@/lib/motion-preference'
import { outlineEntries, readingIndex, scrollParent, type OutlineEntry } from '@/lib/page-outline'

// A long page's outline (Jevons 11-04), the way Notion floats one: a few short
// bars in the right margin, the one being read longer and darker. Moving onto
// them, or tabbing in, opens the section names on frosted glass; a click goes
// there. It floats, so the page never moves for it, and a page too short to need
// one shows none. The sections are the page's own <h2>s, read as they change.
const props = defineProps<{ content?: HTMLElement | null }>()

const MIN_SECTIONS = 3
const entries = shallowRef<OutlineEntry[]>([])
const scroller = shallowRef<HTMLElement | null>(null)
const reading = ref(0)
const shown = computed(() => entries.value.length >= MIN_SECTIONS && Boolean(scroller.value))

function updateReading() {
  if (scroller.value) reading.value = readingIndex(entries.value, scroller.value)
}
let frame = 0
function refresh() {
  cancelAnimationFrame(frame)
  frame = requestAnimationFrame(() => {
    const content = props.content
    entries.value = content ? outlineEntries(content) : []
    scroller.value = content ? scrollParent(content) : null
    updateReading()
  })
}
watch(() => props.content, refresh, { immediate: true })
useMutationObserver(() => props.content, refresh, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-state', 'hidden', 'open'] })
useEventListener(window, 'resize', refresh)
useEventListener(scroller, 'scroll', updateReading, { passive: true })

function go(entry: OutlineEntry) {
  const section = entry.heading.closest<HTMLElement>('section, article') ?? entry.heading
  const behavior = motionReduced() ? 'auto' : 'smooth'
  section.scrollIntoView({ block: 'start', behavior })
  // A page whose header folds as it scrolls stops the glide partway; it goes on from there, once.
  scroller.value?.addEventListener('scrollend', () => section.scrollIntoView({ block: 'start', behavior }), { once: true })
}
</script>

<template>
  <Teleport to="body">
    <nav v-if="shown" class="page-outline" :aria-label="t('common.outline')" data-page-outline>
      <!-- The way in by keyboard: the list is hidden until something here has focus. -->
      <Button variant="ghost" class="page-outline-rail" :aria-label="t('common.outline')" data-page-outline-rail>
        <span v-for="(entry, index) in entries" :key="index" class="page-outline-bar" :class="{ 'is-reading': index === reading }" aria-hidden="true" />
      </Button>
      <ol class="page-outline-list">
        <li v-for="(entry, index) in entries" :key="index">
          <Button variant="ghost" size="sm" class="page-outline-item" :class="{ 'is-reading': index === reading }"
            :aria-current="index === reading ? 'location' : undefined" :title="entry.label" data-page-outline-item @click="go(entry)">
            {{ entry.label }}
          </Button>
        </li>
      </ol>
    </nav>
  </Teleport>
</template>

<style scoped>
/* One place on every page and window: it hangs from a fixed height, so more
   sections or a taller window only lengthen it downward. Only the rail and the
   open list take the pointer: the closed list must not cover the page. */
.page-outline { position: fixed; top: 136px; right: 4px; z-index: var(--z-nav); display: flex; flex-direction: row-reverse; align-items: flex-start; pointer-events: none; }
.page-outline-rail { display: grid; justify-items: end; gap: 9px; width: auto; height: auto; padding: 10px 6px 10px 14px; border-radius: var(--radius-control); pointer-events: auto; }
.page-outline-rail:hover { background: transparent; }
.page-outline-bar { width: 14px; height: 2px; border-radius: var(--radius-pill); background: var(--color-border-strong); transform: scaleX(.6); transform-origin: right; transition: transform var(--motion-fast) var(--motion-ease), background-color var(--motion-fast) var(--motion-ease); }
.page-outline-bar.is-reading { background: var(--color-ink); transform: none; }
.page-outline:hover .page-outline-bar { transform: none; }

/* Frosted like the dock: the glass on its own layer, so the list blurs the page
   beneath it. It scales in with no fade: a fading panel cannot blur what lies
   beneath it until it is opaque, and the blur would land with a jolt. */
.page-outline-list {
  position: relative; isolation: isolate; display: grid; max-height: calc(100dvh - 200px); margin: 0; padding: 6px; overflow-y: auto;
  border: 1px solid var(--edge-dock); border-radius: var(--radius-card); box-shadow: var(--shadow-glass); list-style: none;
  visibility: hidden; scale: .96; transform-origin: right top; user-select: none; -webkit-user-select: none;
  transition: scale var(--motion-fast) var(--motion-ease), visibility 0s linear var(--motion-fast);
}
.page-outline-list::before {
  content: ''; position: absolute; inset: 0; z-index: -1; border-radius: inherit;
  background: var(--glass-sheen), var(--surface-dock); -webkit-backdrop-filter: var(--filter-dock); backdrop-filter: var(--filter-dock);
}
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .page-outline-list::before { background: var(--color-surface); }
}
.page-outline:hover .page-outline-list, .page-outline:has(:focus-visible) .page-outline-list {
  visibility: visible; scale: 1; pointer-events: auto; transition-delay: 0s;
}
.page-outline-item { justify-content: flex-start; width: 100%; max-width: 240px; overflow: hidden; color: var(--color-muted); font-weight: var(--weight-regular); text-overflow: ellipsis; white-space: nowrap; }
.page-outline-item.is-reading { color: var(--color-ink); font-weight: var(--weight-medium); }

@media (max-width: 760px) { .page-outline { display: none; } }
@media (prefers-reduced-motion: reduce) { .page-outline-bar, .page-outline-list { transition: none; } }
:root[data-motion="reduced"] .page-outline-bar, :root[data-motion="reduced"] .page-outline-list { transition: none; }
</style>
