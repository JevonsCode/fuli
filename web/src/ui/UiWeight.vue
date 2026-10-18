<script setup lang="ts">
import { computed } from 'vue'
import UiIcon from './UiIcon.vue'
import { clampWeight, weightBand } from './weight'

// A weight percentage as a short bar plus the number; a person's confirmation
// is marked with a check instead of more text.
const props = withDefaults(defineProps<{ percent: number; confirmedByPerson?: boolean; label: string }>(), { confirmedByPerson: false })
const value = computed(() => clampWeight(props.percent))
const band = computed(() => weightBand(value.value, props.confirmedByPerson))
</script>

<template>
  <span class="ui-weight" :class="`is-${band}`" role="meter" :aria-label="label" aria-valuemin="0" aria-valuemax="100"
    :aria-valuenow="value" :data-weight-band="band" :data-term="`weight.${band}`">
    <span class="ui-weight-track" aria-hidden="true"><span class="ui-weight-fill" :style="{ transform: `scaleX(${value / 100})` }" /></span>
    <span class="ui-weight-number">{{ value }}%</span>
    <UiIcon v-if="band === 'person'" name="check" :size="14" />
  </span>
</template>

<style scoped>
.ui-weight { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 650; }
.ui-weight-track { position: relative; width: 44px; height: 6px; overflow: hidden; border-radius: var(--radius-pill); background: var(--color-surface-subtle); }
.ui-weight-fill { position: absolute; inset: 0; transform-origin: left center; border-radius: inherit; transition: transform var(--motion-medium) var(--motion-ease); }
.ui-weight.is-pending { color: var(--color-muted); }
.ui-weight.is-pending .ui-weight-fill { background: var(--color-faint); }
.ui-weight.is-agent { color: var(--color-ink-soft); }
.ui-weight.is-agent .ui-weight-fill { background: var(--color-accent-line); }
.ui-weight.is-person { color: var(--color-accent); }
.ui-weight.is-person .ui-weight-fill { background: var(--color-accent); }
.ui-weight-number { min-width: 3.2ch; font-variant-numeric: tabular-nums; }
</style>
