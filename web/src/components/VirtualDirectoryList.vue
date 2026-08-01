<script setup lang="ts" generic="T">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'

import { t } from '@/i18n'

const props = withDefaults(defineProps<{
  items: readonly T[]
  rowHeight: number
  label: string
  minWidth?: string
  overscan?: number
  resetKey?: unknown
  activeIndex?: number
  watermarkPrefix?: string
  itemKey?: (item: T, index: number) => string | number
}>(), {
  minWidth: '100%',
  overscan: 8,
  resetKey: undefined,
  activeIndex: -1,
  watermarkPrefix: '#',
  itemKey: undefined,
})

defineSlots<{
  header?: () => unknown
  default: (props: { item: T; index: number; formattedIndex: string }) => unknown
  empty?: () => unknown
  footer?: () => unknown
}>()

const scroller = ref<HTMLElement | null>(null)
const header = ref<HTMLElement | null>(null)
const scrollTop = ref(0)
const viewportHeight = ref(640)
const headerHeight = ref(0)
let resizeObserver: ResizeObserver | null = null

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

watch([scroller, header], ([element, headerElement]) => {
  resizeObserver?.disconnect()
  resizeObserver = null
  if (!element) return
  updateViewport()
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
  const element = scroller.value
  if (!element) return
  const maximumScrollTop = Math.max(0, element.scrollHeight - element.clientHeight)
  if (element.scrollTop > maximumScrollTop) element.scrollTop = maximumScrollTop
  updateViewport()
})

watch([scroller, () => props.activeIndex], async ([element, activeIndex]) => {
  if (!element || activeIndex < 0 || activeIndex >= itemCount.value) return
  await nextTick()
  scrollIndexIntoView(activeIndex)
}, { flush: 'post' })

onBeforeUnmount(() => resizeObserver?.disconnect())

function formatIndex(index: number) {
  return String(index).padStart(indexWidth.value, '0')
}

function updateViewport() {
  const element = scroller.value
  if (!element) return
  scrollTop.value = element.scrollTop
  viewportHeight.value = element.clientHeight || viewportHeight.value
  headerHeight.value = header.value?.offsetHeight ?? 0
}

function onScroll(event: Event) {
  const element = event.currentTarget as HTMLElement
  scrollTop.value = element.scrollTop
}

function scrollToStart() {
  const element = scroller.value
  if (!element) return
  element.scrollTop = 0
  scrollTop.value = 0
}

function scrollIndexIntoView(index: number) {
  const element = scroller.value
  if (!element || index < 0 || index >= itemCount.value) return
  const rowTop = index * props.rowHeight
  const rowBottom = rowTop + props.rowHeight
  const visibleTop = element.scrollTop
  const visibleBottom = visibleTop + element.clientHeight - headerHeight.value
  if (rowTop < visibleTop) element.scrollTop = rowTop
  else if (element.clientHeight && rowBottom > visibleBottom) {
    element.scrollTop = rowBottom - element.clientHeight + headerHeight.value
  }
  scrollTop.value = element.scrollTop
}

defineExpose({
  scrollToStart,
  scrollIndexIntoView,
})
</script>

<template>
  <section class="virtual-directory-list" :aria-label="label">
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

      <div class="virtual-directory-list__canvas" :style="canvasStyle">
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
          <span class="virtual-directory-list__watermark" aria-hidden="true">
            {{ watermarkPrefix }}{{ formatIndex(index + 1) }}
          </span>
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

.virtual-directory-list__watermark {
  position: absolute;
  z-index: 1;
  right: 9px;
  bottom: -7px;
  color: rgb(47 57 51 / 5.5%);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 31px;
  font-weight: 760;
  line-height: 1;
  letter-spacing: -.09em;
  pointer-events: none;
  user-select: none;
}

.virtual-directory-list__row.is-active .virtual-directory-list__watermark {
  color: rgb(53 96 71 / 8%);
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
  border: 1px solid rgb(207 215 209 / 78%);
  border-radius: 999px;
  color: #8b938d;
  background: rgb(255 255 255 / 88%);
  box-shadow: 0 3px 12px rgb(47 57 51 / 8%);
  backdrop-filter: blur(8px);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 9px;
  line-height: 1;
  pointer-events: none;
}

.virtual-directory-list__position strong {
  color: #425047;
  font-size: 11px;
  font-weight: 720;
}
</style>
