<script setup lang="ts">
// A tag. Fixed height and its own ellipsis keep wrapped rows aligned; put
// chips in a UiChipRow so wrapping uses one gap in both directions.
withDefaults(defineProps<{ tone?: 'neutral' | 'accent' | 'warning' | 'danger'; title?: string }>(), { tone: 'neutral', title: undefined })
</script>

<template>
  <span class="ui-chip" :class="`is-${tone}`" :title="title"><slot /></span>
</template>

<style scoped>
.ui-chip {
  display: inline-flex; align-items: center; height: 22px; max-width: 160px; padding: 0 8px;
  overflow: hidden; border-radius: var(--radius-pill); font-size: 12px; font-weight: var(--weight-medium); line-height: 22px;
  text-overflow: ellipsis; white-space: nowrap; vertical-align: middle;
}
.ui-chip.is-neutral { color: var(--color-ink-soft); background: var(--color-surface-subtle); }
.ui-chip.is-accent { color: var(--color-accent); background: var(--color-accent-soft); }
.ui-chip.is-warning { color: var(--color-warning); background: var(--color-warning-soft); }
.ui-chip.is-danger { color: var(--color-danger); background: var(--color-danger-soft); }
</style>
