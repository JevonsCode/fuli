<script setup lang="ts">
import { computed, useId } from 'vue'

import { FULI_MARK, markCut } from '@/lib/brand'

const props = withDefaults(defineProps<{
  label: string
  variant?: 'page' | 'compact' | 'inline'
}>(), { variant: 'page' })

// The mark's drawn size per variant; it picks the optical cut (micro for inline).
const MARK_PIXELS = { page: 48, compact: 28, inline: 16 } as const
const gradientId = useId()
const pixels = computed(() => MARK_PIXELS[props.variant])
const cut = computed(() => markCut(pixels.value))
const paths = computed(() => FULI_MARK[cut.value])
const { ink } = FULI_MARK
</script>

<template>
  <span
    class="growth-loading"
    :class="[`growth-loading--${props.variant}`, { 'view-loading': props.variant === 'page' }]"
    role="status"
    aria-live="polite"
    aria-atomic="true"
    :aria-label="props.label"
    :style="{ '--growth-loading-size': `${pixels}px` }"
  >
    <span class="growth-loading__content">
      <span class="growth-loading__visual" aria-hidden="true">
        <!-- The brand loading (brand/motion/fuli-motion.css): the rings breathe and the bars grow in turn. -->
        <svg
          class="growth-loading__mark fuli-brand-svg is-motion-loading"
          :data-cut="cut"
          :viewBox="FULI_MARK.viewBox.join(' ')"
          aria-hidden="true"
          focusable="false"
        >
          <defs>
            <linearGradient
              :id="gradientId"
              :x1="FULI_MARK.goldLine.x1"
              :y1="FULI_MARK.goldLine.y1"
              :x2="FULI_MARK.goldLine.x2"
              :y2="FULI_MARK.goldLine.y2"
              gradientUnits="userSpaceOnUse"
            >
              <stop v-for="[offset, color] in FULI_MARK.gold.light" :key="offset" :offset="offset" :stop-color="color" />
            </linearGradient>
          </defs>
          <g class="fuli-mark-group">
            <path class="fuli-orbit-gold" :fill="`url(#${gradientId})`" :d="paths.orbitGold" />
            <path class="fuli-orbit-upper" :fill="ink" :d="paths.orbitUpper" />
            <path class="fuli-wave" :fill="ink" :d="paths.wave" />
            <path v-for="(bar, index) in paths.bars" :key="index" :class="`fuli-bar fuli-bar--${index + 1}`" :fill="ink" :d="bar" />
          </g>
        </svg>
      </span>
      <span class="growth-loading__label">{{ props.label }}</span>
    </span>
  </span>
</template>

<style scoped>
.growth-loading {
  display: block;
  min-width: 0;
  color: var(--color-muted);
  font-family: inherit;
  font-size: 14px;
  line-height: 1.4;
}

/* The page variant fills and centres through .view-loading (styles/vue.css);
   the base rule's display would otherwise win over it. */
.growth-loading--page {
  display: grid;
  place-items: center;
}

/* A section whose box has a height (a flex column, a grid row) centres the
   compact variant in all of it; elsewhere it keeps its own 104px. */
.growth-loading--compact {
  flex-grow: 1;
  align-self: stretch;
  display: grid;
  place-items: center;
  min-height: 104px;
  padding: 16px;
}

.growth-loading--inline {
  display: inline-flex;
  max-width: 100%;
  vertical-align: middle;
}

.growth-loading__content {
  display: grid;
  justify-items: center;
  min-width: 0;
  gap: 8px;
}

.growth-loading--inline .growth-loading__content {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.growth-loading__visual {
  display: block;
  width: var(--growth-loading-size);
  height: var(--growth-loading-size);
  flex: 0 0 auto;
}

.growth-loading__mark {
  width: 100%;
  height: 100%;
}

.growth-loading__label {
  color: var(--color-muted);
  font-size: 14px;
  line-height: 1.4;
  text-align: center;
  overflow-wrap: anywhere;
}

.growth-loading--inline .growth-loading__label {
  text-align: left;
}
</style>
