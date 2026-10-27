<script setup lang="ts" generic="T">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import { t } from '@/i18n'

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

defineSlots<{
  header?: () => unknown
  default: (props: { item: T; index: number; formattedIndex: string }) => unknown
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
const indexWidth = computed(() => Math.max(3, String(itemCount.value).length))
const currentIndex = computed(() => {
  if (!itemCount.value) return 0
  return Math.min(itemCount.value, Math.floor(scrollTop.value / props.rowHeight) + 1)
})
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

onBeforeUnmount(() => resizeObserver?.disconnect())

function formatIndex(index: number) {
  return String(index).padStart(indexWidth.value, '0')
}

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
  <section ref="root" class="virtual-directory-list" :class="{ 'is-page-scroll': pageScroll }" :aria-label="label">
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
            <slot
              :item="items[index] as T"
              :index="index"
              :formatted-index="formatIndex(index + 1)"
            />
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

    <output
      v-if="itemCount"
      class="virtual-directory-list__position"
      :aria-label="t('common.counts.listPosition', {
        current: currentIndex,
        total: itemCount,
      })"
    >
      <strong>{{ formatIndex(currentIndex) }}</strong>
      <span>/ {{ formatIndex(itemCount) }}</span>
    </output>
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

.virtual-directory-list__position {
  position: absolute;
  z-index: 4;
  right: 12px;
  bottom: 12px;
  display: flex;
  align-items: baseline;
  gap: 4px;
  padding: 6px 9px;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  color: var(--color-muted);
  background: var(--color-surface);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
  line-height: 1;
  pointer-events: none;
}

/* Page scroll: the list is as tall as its rows, the page scrolls, the header
   sticks to the page's top and the position stays at the window's bottom.
   clip (not hidden) so the sticky header still follows the page. */
.virtual-directory-list.is-page-scroll { height: auto; overflow: clip; }
.is-page-scroll .virtual-directory-list__scroller { height: auto; overflow: visible; }
.is-page-scroll .virtual-directory-list__position {
  position: sticky;
  right: auto;
  width: fit-content;
  margin: -38px 12px 0 auto;
}

.virtual-directory-list__position strong {
  color: var(--color-ink);
  font-size: 12px;
  font-weight: 720;
}
</style>
