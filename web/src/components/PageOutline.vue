<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue'
import { useEventListener, useMutationObserver } from '@vueuse/core'
import { Button } from '@/components/ui/button'
import { t } from '@/i18n'
import { motionReduced } from '@/lib/motion-preference'
import { outlineEntries, outlineNeeded, readingIndex, scrollParent, type OutlineEntry } from '@/lib/page-outline'

// A long page's 目录 (Jevons 11-04, 11-07, 11-08, 11-12 「那个锚点现在好丑啊」): a slim glass
// capsule by the window's right edge holding one dot per section, the section being read drawn
// as a longer ink pill that glides from dot to dot. No name shows at rest: the page's margin is
// too narrow for one, and a name there sat over the cards' own actions. Moving onto the capsule,
// or tabbing in, opens it leftwards into the
// names, with how many each holds, each on its dot's row; a click goes there. The name being read
// is darker, nothing more: no box, no fill, no bar. A window with room beside the page keeps the
// names open. It is navigation at the page's edge, not another card. It floats, so the page never
// moves for it, and a page too short to need one shows none. The sections are the page's own
// <h2>s, read as they change; a heading names itself and its count with data-outline-label /
// data-outline-count.
const props = defineProps<{ content?: HTMLElement | null }>()

// The style's own numbers (.page-outline): rows shorten to MIN_ROW to fit between the top bar and
// the bottom margin. A window too short even for that shows no outline, rather than one whose last
// sections lie outside the window.
const MIN_ROW = 16
const PADDING = 12
const TOP_MIN = 76
const BOTTOM = 32
// The desktop client keeps a strip under its window buttons (--desktop-caption-top), which the style adds to the top.
// lib/desktop-client.ts sets it on the root element's own style.
const captionTop = () => Number.parseFloat(document.documentElement.style.getPropertyValue('--desktop-caption-top')) || 0
const fits = (rows: number) => rows * MIN_ROW + PADDING <= window.innerHeight - TOP_MIN - captionTop() - BOTTOM

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
    needed.value = Boolean(scroller.value && outlineNeeded(entries.value, scroller.value)) && fits(entries.value.length)
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
    <nav v-if="shown" class="page-outline"
      :style="{ '--outline-rows': entries.length, '--outline-reading': reading }" :aria-label="t('common.outline')" data-page-outline>
      <span class="page-outline-glass" aria-hidden="true" />
      <span class="page-outline-capsule" aria-hidden="true" data-page-outline-capsule />
      <ol class="page-outline-list">
        <li v-for="(entry, index) in entries" :key="index">
          <Button variant="ghost" class="page-outline-item" :class="{ 'is-reading': index === reading, 'is-read': index < reading }"
            :aria-current="index === reading ? 'location' : undefined" :title="entry.label" data-page-outline-item @click="go(entry)">
            <span class="page-outline-name">
              <span class="page-outline-label">{{ entry.label }}</span>
              <span v-if="entry.count !== undefined" class="page-outline-count" data-page-outline-count>{{ entry.count }}</span>
            </span>
            <span class="page-outline-dot" aria-hidden="true" />
          </Button>
        </li>
      </ol>
      <span class="page-outline-marker" aria-hidden="true" data-page-outline-marker />
    </nav>
  </Teleport>
</template>

<style scoped>
/* Navigation at the page's edge, not another card (Jevons 11-08). By the window's right edge,
   clear of the page's scrollbar, the capsule stays in the page's side margin (it narrows with
   the margin) and never reaches the content. Its first dot sits a little over a quarter of the
   way down the window (28%), away from the top bar's actions (Jevons 11-08: 贴在顶部紧挨着「设置」);
   a list too long to fit there rises just enough to end above the bottom margin, and never higher
   than just under the top bar.
   One row per section: its name on the left, its dot in the capsule's column on the right, on one
   centre line. Closed, only the capsule takes the pointer: the hidden names must not cover the
   page. Open, the glass behind every row takes it, so the pointer can travel to a name. */
.page-outline {
  --outline-pad: 6px;
  --outline-top-min: calc(76px + var(--desktop-caption-top, 0px));
  --outline-bottom: 32px;
  /* A row is 30px while every section fits between the top bar and the bottom margin; a page with
     more sections than that gets shorter rows (never under 16px, a line of the names), so the
     whole list and the mark on it stay inside the window instead of running off its end. */
  --outline-row: clamp(16px, calc((100dvh - var(--outline-top-min) - var(--outline-bottom) - 2 * var(--outline-pad)) / var(--outline-rows, 3)), 30px);
  --outline-capsule: clamp(14px, calc(2.4vw - 10px), 20px);
  --outline-dot: 5px;
  --outline-pill: min(14px, calc(var(--outline-row) - 4px));
  --outline-name-max: 180px;
  --outline-height: calc(var(--outline-rows, 3) * var(--outline-row) + 2 * var(--outline-pad));
  /* Opening under the pointer waits for it to rest (passing over never opens it); the keyboard opens it at once. */
  --outline-open-delay: var(--motion-intent);
  position: fixed; top: max(var(--outline-top-min), min(28dvh, calc(100dvh - var(--outline-height) - var(--outline-bottom)))); right: calc(max(var(--scrollbar-size), 8px) + 2px); z-index: var(--z-nav);
  pointer-events: none; user-select: none; -webkit-user-select: none;
}
.page-outline:has(:focus-visible) { --outline-open-delay: 0s; }

/* The dock's frosted glass with the shared glass edge (Jevons 11-08: a clear boundary from the
   page), drawn on the element itself so a fade still blurs what lies beneath. The capsule and
   the open panel share their corner, so opening reads as the capsule widening. */
.page-outline-glass, .page-outline-capsule {
  background: var(--surface-dock); -webkit-backdrop-filter: var(--filter-dock); backdrop-filter: var(--filter-dock); box-shadow: var(--shadow-glass);
}
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .page-outline-glass, .page-outline-capsule { background: var(--surface-glass-strong); }
}
.page-outline-capsule {
  position: absolute; top: 0; right: 0; bottom: 0; width: var(--outline-capsule); border-radius: calc(var(--outline-capsule) / 2);
  pointer-events: auto; transition: visibility 0s;
}
.page-outline-glass {
  position: absolute; inset: 0; border-radius: calc(var(--outline-capsule) / 2);
  opacity: 0; visibility: hidden; scale: .96 1; transform-origin: right center;
  transition: opacity var(--motion-exit), scale var(--motion-exit), visibility 0s linear var(--motion-fast);
}

.page-outline-list {
  position: relative; display: grid; grid-template-columns: minmax(0, 1fr); grid-auto-rows: var(--outline-row); gap: 0;
  width: max-content; margin: 0; padding: var(--outline-pad) 0 var(--outline-pad) 12px; list-style: none;
}
/* A row is only text and a dot: muted, darker under the pointer, and the one being read in ink.
   Only the colour changes (Jevons 11-07): no bolder weight, which would also shift the line width.
   No box, no fill, no bar. */
.page-outline-item {
  justify-content: flex-end; gap: 6px; width: 100%; min-height: 0; height: var(--outline-row); padding: 0; overflow: hidden;
  border: 0; background: transparent; color: var(--color-muted); font-size: var(--text-meta); font-weight: var(--weight-regular); line-height: 1.2;
  white-space: nowrap; user-select: none; -webkit-user-select: none; pointer-events: none; transition: color var(--motion-fast) var(--motion-ease);
}
.page-outline-item:hover { background: transparent; color: var(--color-ink-soft); }
.page-outline-item.is-reading { color: var(--color-ink); }
.page-outline-name {
  display: flex; align-items: baseline; gap: 6px; min-width: 0; max-width: var(--outline-name-max);
  opacity: 0; translate: 6px 0; transition: opacity var(--motion-exit), translate var(--motion-exit);
}
.page-outline-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.page-outline-count { flex: none; color: var(--color-muted); font-variant-numeric: tabular-nums; }

/* The dots: the sections already passed a shade darker than those ahead. */
.page-outline-dot { display: grid; flex: none; place-items: center; width: var(--outline-capsule); height: 100%; }
.page-outline-dot::before {
  content: ''; width: var(--outline-dot); height: var(--outline-dot); border-radius: var(--radius-pill); background: var(--color-faint);
  transition: background-color var(--motion-fast) var(--motion-ease), scale var(--motion-fast) var(--motion-ease);
}
.page-outline-item.is-read .page-outline-dot::before { background: var(--color-muted); }
.page-outline-item:hover .page-outline-dot::before { background: var(--color-ink-soft); scale: 1.3; }

/* You are here: one ink pill over the dot being read, gliding to the next as the page scrolls. */
.page-outline-marker {
  position: absolute; top: calc(var(--outline-pad) + (var(--outline-row) - var(--outline-pill)) / 2);
  right: calc((var(--outline-capsule) - var(--outline-dot)) / 2); width: var(--outline-dot); height: var(--outline-pill);
  border-radius: var(--radius-pill); background: var(--color-ink); pointer-events: none;
  translate: 0 calc(var(--outline-reading, 0) * var(--outline-row)); transition: translate var(--motion-move);
}
/* Open: the glass widens leftwards behind every row and the names come in. */
.page-outline:is(:hover, :has(:focus-visible)) .page-outline-glass {
  opacity: 1; visibility: visible; scale: 1; pointer-events: auto;
  transition: opacity var(--motion-move) var(--outline-open-delay), scale var(--motion-move) var(--outline-open-delay), visibility 0s linear var(--outline-open-delay);
}
.page-outline:is(:hover, :has(:focus-visible)) .page-outline-capsule { visibility: hidden; transition: visibility 0s linear var(--outline-open-delay); }
.page-outline:is(:hover, :has(:focus-visible)) .page-outline-item { pointer-events: auto; }
.page-outline:is(:hover, :has(:focus-visible)) .page-outline-name {
  opacity: 1; translate: none; transition: opacity var(--motion-move) var(--outline-open-delay), translate var(--motion-move) var(--outline-open-delay);
}

/* A window with room right of the page keeps the names open beside the dots. */
@media (min-width: 2400px) {
  .page-outline-glass { opacity: 1; visibility: visible; scale: 1; pointer-events: auto; transition: none; }
  .page-outline-capsule { display: none; }
  .page-outline-item { pointer-events: auto; }
  .page-outline-name {
    max-width: min(var(--outline-name-max), calc((100vw - var(--canvas-max)) / 2 - var(--outline-capsule) - 40px));
    opacity: 1; translate: none; transition: none;
  }
}
@media (max-width: 760px) { .page-outline { display: none; } }
</style>
