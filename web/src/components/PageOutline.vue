<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue'
import { useEventListener, useMutationObserver } from '@vueuse/core'
import { Button } from '@/components/ui/button'
import { t } from '@/i18n'
import { motionReduced } from '@/lib/motion-preference'
import { outlineEntries, outlineNeeded, readingIndex, scrollParent, type OutlineEntry } from '@/lib/page-outline'

// A long page's 目录 (Jevons 11-04, 11-07, 11-08): a ruler by the window's right
// edge, one short tick per section on a hairline, the one being read longer and
// darker. Moving onto it, or tabbing in, opens the section names, with how many
// each holds, beside their ticks on faint glass; a click goes there. The name being
// read is darker and bolder, nothing more: no box, no fill, no bar. A window with
// room beside the page keeps the names open. It is navigation at the page's edge,
// not another card. It floats, so
// the page never moves for it, and a page too short to need one shows none. The
// sections are the page's own <h2>s, read as they change; a heading names itself
// and its count with data-outline-label / data-outline-count.
const props = defineProps<{ content?: HTMLElement | null }>()

const entries = shallowRef<OutlineEntry[]>([])
const scroller = shallowRef<HTMLElement | null>(null)
const reading = ref(0)
const needed = ref(false)
const shown = computed(() => needed.value && Boolean(scroller.value))

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
    needed.value = Boolean(scroller.value && outlineNeeded(entries.value, scroller.value))
    updateReading()
  })
}
watch(() => props.content, refresh, { immediate: true })
useMutationObserver(() => props.content, refresh, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-state', 'hidden', 'open', 'data-outline-count'] })
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
    <nav v-if="shown" class="page-outline" :style="{ '--outline-rows': entries.length }" :aria-label="t('common.outline')" data-page-outline>
      <!-- The way in by keyboard: the list is hidden until something here has focus. -->
      <Button variant="ghost" class="page-outline-rail" :aria-label="t('common.outline')" data-page-outline-rail>
        <span v-for="(entry, index) in entries" :key="index" class="page-outline-tick" aria-hidden="true">
          <span class="page-outline-bar" :class="{ 'is-reading': index === reading }" />
        </span>
      </Button>
      <ol class="page-outline-list">
        <li v-for="(entry, index) in entries" :key="index">
          <Button variant="ghost" class="page-outline-item" :class="{ 'is-reading': index === reading }"
            :aria-current="index === reading ? 'location' : undefined" :title="entry.label" data-page-outline-item @click="go(entry)">
            <span class="page-outline-label">{{ entry.label }}</span>
            <span v-if="entry.count !== undefined" class="page-outline-count" data-page-outline-count>{{ entry.count }}</span>
          </Button>
        </li>
      </ol>
    </nav>
  </Teleport>
</template>

<style scoped>
/* Navigation at the page's edge, not another card (Jevons 11-08). By the window's right
   edge, clear of the page's scrollbar, it never reaches the page's content. Its ticks start
   two fifths of the way down the window, away from the top bar's actions (Jevons 11-08:
   贴在顶部紧挨着「设置」); a list too long to fit there rises just enough to end above the
   bottom margin, and never higher than just under the top bar.
   The ruler (one tick per section on a hairline, the hairline on the outer side) sits at
   the edge; the names open leftwards from it, each on its tick's row, so a name and its
   tick read as one line. Only the ruler and the open names take the pointer: the closed
   names must not cover the page. */
.page-outline {
  --outline-row: 22px;
  --outline-pad: 6px;
  --outline-top-min: calc(76px + var(--desktop-caption-top, 0px));
  --outline-bottom: 32px;
  --outline-height: calc(var(--outline-rows, 3) * var(--outline-row) + 2 * var(--outline-pad));
  position: fixed; top: max(var(--outline-top-min), min(40dvh, calc(100dvh - var(--outline-height) - var(--outline-bottom)))); right: calc(max(var(--scrollbar-size), 8px) + 2px); z-index: var(--z-nav);
  display: flex; flex-direction: row-reverse; align-items: flex-start; pointer-events: none;
}
/* The ticks end 14px from the window's edge on the hairline and narrow with the margin. */
.page-outline-rail {
  position: relative; display: grid; grid-auto-rows: var(--outline-row); justify-items: end; align-items: center; gap: 0;
  width: auto; height: auto; max-height: calc(100dvh - var(--outline-top-min) - var(--outline-bottom)); overflow: hidden;
  padding: var(--outline-pad) 4px; border-radius: var(--radius-control); pointer-events: auto;
}
.page-outline-rail:hover { background: transparent; }
.page-outline-rail::after {
  content: ''; position: absolute; top: calc(var(--outline-pad) + var(--outline-row) / 2 - 4px); bottom: calc(var(--outline-pad) + var(--outline-row) / 2 - 4px); right: 4px;
  width: 1px; background: var(--color-border); pointer-events: none;
}
.page-outline-tick { display: block; line-height: 0; }
.page-outline-bar {
  display: block; width: clamp(8px, calc(2.4vw - 10px), 14px); height: 2px; border-radius: var(--radius-pill); background: var(--color-border-strong);
  transform: scaleX(.5); transform-origin: right; transition: transform var(--motion-fast) var(--motion-ease), background-color var(--motion-fast) var(--motion-ease);
}
.page-outline-bar.is-reading { background: var(--color-ink); transform: none; }
.page-outline:hover .page-outline-bar:not(.is-reading) { transform: scaleX(.7); }

/* Faint glass, no edge or shadow: the names float over the page without becoming a card.
   The glass lives on its own layer so it blurs the page beneath it. It scales in with no
   fade: a fading panel cannot blur what lies beneath it until it is opaque. */
.page-outline-list {
  position: relative; isolation: isolate; display: grid; grid-template-columns: minmax(0, 1fr); grid-auto-rows: var(--outline-row); gap: 0;
  width: max-content; max-width: 220px; max-height: calc(100dvh - var(--outline-top-min) - var(--outline-bottom)); margin: 0; padding: var(--outline-pad) 2px var(--outline-pad) 12px; overflow: hidden auto;
  border-radius: var(--radius-control); list-style: none;
  visibility: hidden; scale: .97; transform-origin: right top; user-select: none; -webkit-user-select: none;
  transition: scale var(--motion-fast) var(--motion-ease), visibility 0s linear var(--motion-fast);
}
.page-outline-list::before {
  content: ''; position: absolute; inset: 0; z-index: -1; border-radius: inherit;
  background: var(--surface-dock); -webkit-backdrop-filter: var(--filter-dock); backdrop-filter: var(--filter-dock);
}
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .page-outline-list::before { background: var(--color-bg); opacity: .92; }
}
.page-outline:hover .page-outline-list, .page-outline:has(:focus-visible) .page-outline-list {
  visibility: visible; scale: 1; pointer-events: auto; transition-delay: 0s;
}
/* A name is only text: muted, darker under the pointer, and the one being read in ink and
   one weight bolder. No box, no fill, no bar. */
.page-outline-item {
  justify-content: flex-end; gap: 8px; width: 100%; min-height: 0; height: var(--outline-row); padding: 0 6px; overflow: hidden;
  border: 0; background: transparent; color: var(--color-muted); font-size: var(--text-meta); font-weight: var(--weight-regular); line-height: 1.2;
  white-space: nowrap; user-select: none; -webkit-user-select: none; transition: color var(--motion-fast) var(--motion-ease);
}
.page-outline-item:hover { background: transparent; color: var(--color-ink-soft); }
.page-outline-item.is-reading { color: var(--color-ink); font-weight: var(--weight-strong); }
.page-outline-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.page-outline-count { flex: none; color: var(--color-muted); font-weight: var(--weight-regular); font-variant-numeric: tabular-nums; }

/* A window with room right of the page keeps the names open beside the ruler. */
@media (min-width: 2400px) {
  .page-outline-list { max-width: min(220px, calc((100vw - var(--canvas-max)) / 2 - 2px - 24px - 30px)); visibility: visible; scale: 1; pointer-events: auto; transition: none; }
}
@media (max-width: 760px) { .page-outline { display: none; } }
@media (prefers-reduced-motion: reduce) { .page-outline-bar, .page-outline-list, .page-outline-item { transition: none; } }
:root[data-motion="reduced"] .page-outline-bar, :root[data-motion="reduced"] .page-outline-list, :root[data-motion="reduced"] .page-outline-item { transition: none; }
</style>
