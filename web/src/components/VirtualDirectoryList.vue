<script setup lang="ts" generic="T">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import { t } from '@/i18n'
import { listPositionText } from '@/lib/list-position'

// The position capsule shows while the list moves, when a pointer enters it or focus
// moves into it, and fades this long after the last of those.
const POSITION_AWAKE_MS = 1400
// The reader hears where they are once the scrolling has settled, never on every frame.
const POSITION_SETTLE_MS = 400

const props = withDefaults(defineProps<{
  items: readonly T[]
  rowHeight: number
  label: string
  minWidth?: string
  overscan?: number
  resetKey?: unknown
  activeIndex?: number
  itemKey?: (item: T, index: number) => string | number
  /**
   * 'list': the list is its own fixed-height scroll box. 'page': the list
   * grows with its rows and follows the page's scroll, so the page has one
   * scrollbar; the header sticks to the top of the page.
   */
  scrollsWith?: 'list' | 'page'
}>(), {
  minWidth: '100%',
  overscan: 8,
  resetKey: undefined,
  activeIndex: -1,
  itemKey: undefined,
  scrollsWith: 'list',
})

// The drawn rows reach the last loaded ones: a paged list reads its next page.
const emit = defineEmits<{ nearEnd: [] }>()

defineSlots<{
  header?: () => unknown
  default: (props: { item: T; index: number }) => unknown
  empty?: () => unknown
  footer?: () => unknown
}>()

const root = ref<HTMLElement | null>(null)
const scroller = ref<HTMLElement | null>(null)
const header = ref<HTMLElement | null>(null)
const canvas = ref<HTMLElement | null>(null)
const page = ref<HTMLElement | null>(null)
const scrollTop = ref(0)
const viewportHeight = ref(640)
const headerHeight = ref(0)
let resizeObserver: ResizeObserver | null = null

const pageScroll = computed(() => props.scrollsWith === 'page')
// The element whose scroll moves the rows: the list's own box, or the page.
const scrollElement = computed(() => (pageScroll.value ? page.value : scroller.value))

const itemCount = computed(() => props.items.length)
// Where you are only matters once the rows are taller than what shows at once;
// a short list shows no 1 / 1.
const showsPosition = computed(() => itemCount.value * props.rowHeight > viewportHeight.value)
const currentIndex = computed(() => {
  if (!itemCount.value) return 0
  return Math.min(itemCount.value, Math.floor(scrollTop.value / props.rowHeight) + 1)
})
const positionText = computed(() => listPositionText(currentIndex.value, itemCount.value))
const visibleRange = computed(() => {
  const start = Math.max(
    0,
    Math.floor(scrollTop.value / props.rowHeight) - props.overscan,
  )
  const visibleCount = Math.ceil(viewportHeight.value / props.rowHeight)
    + (props.overscan * 2)
  return {
    start,
    end: Math.min(itemCount.value, start + visibleCount),
  }
})
watch([() => visibleRange.value.end, () => props.items], ([end]) => {
  if (itemCount.value && end >= itemCount.value) emit('nearEnd')
}, { immediate: true })

const visibleIndices = computed(() =>
  Array.from(
    { length: visibleRange.value.end - visibleRange.value.start },
    (_, offset) => visibleRange.value.start + offset,
  ),
)
const canvasStyle = computed(() => ({
  height: `${itemCount.value * props.rowHeight}px`,
  minWidth: props.minWidth,
}))
const headerStyle = computed(() => ({ minWidth: props.minWidth }))

function scrollingAncestor(element: HTMLElement) {
  for (let node = element.parentElement; node; node = node.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(node).overflowY)) return node
  }
  return document.scrollingElement instanceof HTMLElement ? document.scrollingElement : null
}

onMounted(() => {
  if (pageScroll.value && root.value) page.value = scrollingAncestor(root.value)
})

watch([scrollElement, header], ([element, headerElement], _previous, onCleanup) => {
  resizeObserver?.disconnect()
  resizeObserver = null
  if (!element) return
  updateViewport()
  if (pageScroll.value) {
    element.addEventListener('scroll', updateViewport, { passive: true })
    onCleanup(() => element.removeEventListener('scroll', updateViewport))
  }
  if (typeof ResizeObserver !== 'function') return
  resizeObserver = new ResizeObserver(updateViewport)
  resizeObserver.observe(element)
  if (headerElement) resizeObserver.observe(headerElement)
}, { flush: 'post' })

watch(() => props.resetKey, async () => {
  await nextTick()
  scrollToStart()
}, { flush: 'post' })

watch(itemCount, async () => {
  await nextTick()
  const element = scrollElement.value
  if (!element) return
  const maximumScrollTop = Math.max(0, element.scrollHeight - element.clientHeight)
  if (element.scrollTop > maximumScrollTop) element.scrollTop = maximumScrollTop
  updateViewport()
})

watch([scrollElement, () => props.activeIndex], async ([element, activeIndex]) => {
  if (!element || activeIndex < 0 || activeIndex >= itemCount.value) return
  await nextTick()
  scrollIndexIntoView(activeIndex)
}, { flush: 'post' })

const positionAwake = ref(false)
const positionAnnouncement = ref('')
let awakeTimer: ReturnType<typeof setTimeout> | undefined
let settleTimer: ReturnType<typeof setTimeout> | undefined

function wakePosition() {
  positionAwake.value = true
  clearTimeout(awakeTimer)
  awakeTimer = setTimeout(() => { positionAwake.value = false }, POSITION_AWAKE_MS)
}

function announcePosition() {
  positionAnnouncement.value = t('common.counts.listPosition', {
    current: positionText.value.current,
    total: positionText.value.widest,
  })
}

// Any movement of the rows shows the capsule; the live region is written only once it stops.
watch(scrollTop, () => {
  wakePosition()
  clearTimeout(settleTimer)
  settleTimer = setTimeout(announcePosition, POSITION_SETTLE_MS)
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  clearTimeout(awakeTimer)
  clearTimeout(settleTimer)
})

// Where the first row sits in the scrolling element's content: 0 in the
// list's own box (the header scrolls with it), the rows' offset in the page.
function rowsOffset(element: HTMLElement) {
  if (!pageScroll.value || !canvas.value) return 0
  return canvas.value.getBoundingClientRect().top - element.getBoundingClientRect().top + element.scrollTop
}

function updateViewport() {
  const element = scrollElement.value
  if (!element) return
  scrollTop.value = Math.max(0, element.scrollTop - rowsOffset(element))
  viewportHeight.value = element.clientHeight || viewportHeight.value
  headerHeight.value = header.value?.offsetHeight ?? 0
}

function onScroll(event: Event) {
  if (pageScroll.value) return
  const element = event.currentTarget as HTMLElement
  scrollTop.value = element.scrollTop
}

function scrollToStart() {
  const element = scrollElement.value
  if (!element) return
  // In the page, only bring the list's start back into view; the content above it stays.
  const start = pageScroll.value ? Math.max(0, rowsOffset(element) - headerHeight.value) : 0
  if (!pageScroll.value || element.scrollTop > start) element.scrollTop = start
  updateViewport()
}

function scrollIndexIntoView(index: number) {
  const element = scrollElement.value
  if (!element || index < 0 || index >= itemCount.value) return
  // The sticky header covers the page's top edge; in the list's own box it scrolls away.
  const topInset = pageScroll.value ? headerHeight.value : 0
  const bottomInset = pageScroll.value ? 0 : headerHeight.value
  const rowTop = rowsOffset(element) + index * props.rowHeight
  const rowBottom = rowTop + props.rowHeight
  if (rowTop - topInset < element.scrollTop) element.scrollTop = rowTop - topInset
  else if (element.clientHeight && rowBottom > element.scrollTop + element.clientHeight - bottomInset) {
    element.scrollTop = rowBottom - element.clientHeight + bottomInset
  }
  updateViewport()
}

defineExpose({
  scrollToStart,
  scrollIndexIntoView,
})
</script>

<template>
  <section
    ref="root"
    class="virtual-directory-list"
    :class="{ 'is-page-scroll': pageScroll }"
    :aria-label="label"
    @pointerenter="wakePosition"
    @focusin="wakePosition"
  >
    <div
      ref="scroller"
      class="virtual-directory-list__scroller"
      @scroll.passive="onScroll"
    >
      <div
        v-if="$slots.header"
        ref="header"
        class="virtual-directory-list__header"
        :style="headerStyle"
      >
        <slot name="header" />
      </div>

      <div ref="canvas" class="virtual-directory-list__canvas" :style="canvasStyle">
        <div
          v-for="index in visibleIndices"
          :key="itemKey?.(items[index] as T, index) ?? index"
          class="virtual-directory-list__row"
          :class="{ 'is-active': index === activeIndex }"
          :data-virtual-index="index"
          :style="{
            height: `${rowHeight}px`,
            transform: `translateY(${index * rowHeight}px)`,
          }"
        >
          <div class="virtual-directory-list__content">
            <slot :item="items[index] as T" :index="index" />
          </div>
        </div>
      </div>

      <div
        v-if="!itemCount && $slots.empty"
        class="virtual-directory-list__empty"
        :style="headerStyle"
      >
        <slot name="empty" />
      </div>
      <div
        v-if="$slots.footer"
        class="virtual-directory-list__footer"
        :style="headerStyle"
      >
        <slot name="footer" />
      </div>
    </div>

    <template v-if="showsPosition">
      <!-- For the eye only: the live region below says it, and only once the list settles. -->
      <div
        class="virtual-directory-list__position"
        :class="{ 'is-awake': positionAwake }"
        aria-hidden="true"
      >
        <span class="virtual-directory-list__current" :data-widest="positionText.widest"><span>{{ positionText.current }}</span></span>
        <span>/ {{ positionText.total }}</span>
      </div>
      <span class="ui-sr-only" role="status" aria-live="polite">{{ positionAnnouncement }}</span>
    </template>
  </section>
</template>

<style scoped>
.virtual-directory-list {
  position: relative;
  min-width: 0;
  min-height: 0;
  height: 100%;
  overflow: hidden;
}

.virtual-directory-list__scroller {
  width: 100%;
  height: 100%;
  overflow: auto;
  overscroll-behavior: contain;
}

/* Following the page, the list is no scroll box of its own: it grows with its
   rows (or the room its parent gives it), so a short list never scrolls inside
   and the header can stick to the page. The card around it clips the sides. */
.virtual-directory-list.is-page-scroll,
.is-page-scroll > .virtual-directory-list__scroller {
  height: auto;
  overflow: visible;
}

.virtual-directory-list__header {
  position: sticky;
  z-index: 3;
  top: 0;
}

.virtual-directory-list__canvas {
  position: relative;
}

.virtual-directory-list__row {
  position: absolute;
  isolation: isolate;
  top: 0;
  left: 0;
  width: 100%;
  overflow: hidden;
  will-change: transform;
}

.virtual-directory-list__content {
  position: relative;
  width: 100%;
  height: 100%;
}

.virtual-directory-list__content :deep(button > *) {
  position: relative;
  z-index: 2;
}

/* Where you are in the list (Jevons 11-08): one line of glass, `1,284 / 25,000`, current in ink
   and the total muted, in the console's own font with tabular numerals. It shows only while the
   list moves or is touched and fades after. It sits at the bottom centre, clear of the row
   actions at the right edge and of the page outline (目录) in the right margin. Opacity and
   transform only, so nothing is laid out again and no row moves for it. */
.virtual-directory-list__position {
  --position-height: 28px;
  position: absolute;
  z-index: 4;
  bottom: 12px;
  left: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  box-sizing: border-box;
  height: var(--position-height);
  padding-inline: 12px;
  border-radius: var(--radius-pill);
  color: var(--color-muted);
  background: var(--glass-sheen), var(--surface-dock);
  box-shadow: var(--shadow-glass);
  -webkit-backdrop-filter: var(--filter-dock);
  backdrop-filter: var(--filter-dock);
  font-family: var(--font-ui);
  font-size: var(--text-meta);
  font-weight: var(--weight-medium);
  line-height: 1;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  opacity: 0;
  transform: translate(-50%, 6px);
  transition: opacity var(--motion-exit), transform var(--motion-exit);
  pointer-events: none;
  user-select: none;
  -webkit-user-select: none;
}
.virtual-directory-list__position.is-awake {
  opacity: 1;
  transform: translate(-50%, 0);
  transition: opacity var(--motion-medium) var(--motion-ease-out), transform var(--motion-enter);
}
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .virtual-directory-list__position { background: var(--color-surface); }
}
/* The current number is as wide as the total written in full and set right, so the slash and
   the capsule stay where they are from the first row to the last. */
.virtual-directory-list__current {
  display: inline-grid;
  justify-items: end;
  color: var(--color-ink);
  font-weight: var(--weight-strong);
}
.virtual-directory-list__current::before,
.virtual-directory-list__current > span {
  grid-area: 1 / 1;
}
.virtual-directory-list__current::before {
  content: attr(data-widest);
  visibility: hidden;
}
/* In the page the capsule sticks to the bottom of the page's scrollport. The page keeps 112px
   free there for the floating dock (centred on a phone too), so it never meets the dock. */
.is-page-scroll .virtual-directory-list__position {
  position: sticky;
  bottom: 0;
  left: auto;
  width: fit-content;
  margin: calc(-1 * var(--position-height)) auto 0;
  transform: translateY(6px);
}
.is-page-scroll .virtual-directory-list__position.is-awake { transform: none; }
@media (prefers-reduced-motion: reduce) {
  .virtual-directory-list__position,
  .virtual-directory-list__position.is-awake { transition: opacity var(--motion-exit); transform: translate(-50%, 0); }
  .is-page-scroll .virtual-directory-list__position,
  .is-page-scroll .virtual-directory-list__position.is-awake { transform: none; }
}
</style>
