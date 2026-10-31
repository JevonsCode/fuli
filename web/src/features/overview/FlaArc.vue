<script setup lang="ts">
import { computed } from 'vue'
import { t } from '@/i18n'

// One arc segment per FLA on the task; a finished assignment fills its
// segment in gold. A count, never a percentage the task does not record.
const props = defineProps<{ done: number; total: number }>()

const CX = 100, CY = 104, R = 78
const point = (deg: number) => [CX + R * Math.cos(deg * Math.PI / 180), CY - R * Math.sin(deg * Math.PI / 180)] as const
const segments = computed(() => {
  const n = Math.max(props.total, 1)
  const gap = n > 1 ? Math.min(10, 120 / n) : 0
  return Array.from({ length: n }, (_, index) => {
    const from = 180 - index * 180 / n - (index ? gap / 2 : 0)
    const to = 180 - (index + 1) * 180 / n + (index < n - 1 ? gap / 2 : 0)
    const [x1, y1] = point(from), [x2, y2] = point(to)
    return { d: `M${x1.toFixed(1)} ${y1.toFixed(1)} A${R} ${R} 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)}`, done: index < props.done, index }
  })
})
</script>

<template>
  <div class="fla-arc" role="img" :aria-label="t('overview.stage.flaProgress', { done, total })">
    <svg viewBox="0 0 200 120" aria-hidden="true">
      <path v-for="segment in segments" :key="segment.index" :d="segment.d" class="fla-arc-segment"
        :class="{ 'is-done': segment.done }" :style="{ '--segment-index': segment.index }" />
    </svg>
    <p class="fla-arc-count" aria-hidden="true"><strong>{{ done }}</strong><span>/{{ total }}</span></p>
    <p class="fla-arc-label" aria-hidden="true">{{ t('overview.stage.flaDone') }}</p>
  </div>
</template>

<style scoped>
.fla-arc { position: relative; width: 200px; height: 128px; flex: 0 0 auto; }
.fla-arc svg { width: 200px; height: 120px; overflow: visible; }
.fla-arc-segment {
  fill: none; stroke: var(--color-gold-soft); stroke-width: 16; stroke-linecap: round;
  transition: stroke var(--motion-spring) var(--motion-ease-spring);
  transition-delay: calc(var(--segment-index) * 60ms);
}
.fla-arc-segment.is-done { stroke: var(--color-gold); }
.fla-arc-count { position: absolute; right: 0; bottom: 22px; left: 0; margin: 0; text-align: center; line-height: 1; font-variant-numeric: tabular-nums; }
.fla-arc-count strong { font-size: 40px; font-weight: var(--weight-strong); letter-spacing: -.03em; }
.fla-arc-count span { color: var(--color-faint); font-size: 22px; font-weight: var(--weight-medium); }
.fla-arc-label { position: absolute; right: 0; bottom: 0; left: 0; margin: 0; color: var(--color-muted); font-size: var(--text-meta); text-align: center; }
</style>
