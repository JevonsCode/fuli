<script setup lang="ts">
import { useResizeObserver } from '@vueuse/core'
import { computed, ref } from 'vue'

import VirtualDirectoryList from '@/components/VirtualDirectoryList.vue'

import type { ReviewLine } from './review-list'

// One 待决策 group's rows (Jevons 11-07: the list keeps growing). A short group
// is a plain list whose rows animate out when handled; a long one draws only
// the rows near the screen and follows the page's scroll, so the page keeps
// one scrollbar. Every row then has the same height, read from review-rows.css
// (--review-row-height), which also says how tall a row is on a narrow screen.
const props = defineProps<{ lines: readonly ReviewLine[]; label: string }>()
defineSlots<{ default: (props: { line: ReviewLine }) => unknown }>()

/** From this many rows a group draws only the ones near the screen. */
const VIRTUAL_FROM = 24
const virtual = computed(() => props.lines.length >= VIRTUAL_FROM)
const root = ref<HTMLElement | null>(null)
const rowHeight = ref(76)
useResizeObserver(root, () => {
  const height = root.value ? Number.parseFloat(getComputedStyle(root.value).getPropertyValue('--review-row-height')) : Number.NaN
  if (Number.isFinite(height) && height > 0) rowHeight.value = height
})
const lineKey = (line: ReviewLine) => line.key
</script>

<template>
  <div v-if="virtual" ref="root" class="review-rows review-rows--virtual" data-review-rows="virtual">
    <VirtualDirectoryList :items="lines" :row-height="rowHeight" :label="label" :item-key="lineKey" scrolls-with="page">
      <template #default="{ item, index }">
        <div class="review-row" :class="{ 'is-first': index === 0 }" :data-review-line="item.key">
          <slot :line="item" />
        </div>
      </template>
    </VirtualDirectoryList>
  </div>
  <TransitionGroup v-else name="ui-list" tag="ul" class="review-rows" data-review-rows="list">
    <li v-for="line in lines" :key="line.key" class="review-row" :data-review-line="line.key">
      <slot :line="line" />
    </li>
  </TransitionGroup>
</template>
