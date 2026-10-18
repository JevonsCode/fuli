<script setup lang="ts">
import UiIcon from './UiIcon.vue'
import type { IconName } from './icons'

// An action shown as an icon only. The label is required: it becomes the
// accessible name and the hover tooltip, so no button face needs words.
withDefaults(defineProps<{
  icon: IconName
  label: string
  shape?: 'round' | 'square'
  size?: 'sm' | 'md'
  active?: boolean
  disabled?: boolean
}>(), { shape: 'round', size: 'md', active: false, disabled: false })
</script>

<template>
  <button type="button" class="ui-icon-button" :class="[`is-${shape}`, `is-${size}`, { 'is-active': active }]"
    :aria-label="label" :title="label" :aria-pressed="active || undefined" :disabled="disabled">
    <UiIcon :name="icon" :size="size === 'sm' ? 16 : 18" />
  </button>
</template>

<style scoped>
.ui-icon-button {
  display: inline-grid; place-items: center; padding: 0; border: 1px solid transparent;
  color: var(--color-ink-soft); background: transparent; cursor: pointer;
  transition: color var(--motion-fast), background var(--motion-fast), transform var(--motion-fast) var(--motion-ease);
}
.ui-icon-button.is-md { width: 36px; height: 36px; }
.ui-icon-button.is-sm { width: 30px; height: 30px; }
.ui-icon-button.is-round { border-radius: var(--radius-pill); }
.ui-icon-button.is-square { border-radius: var(--radius-control); }
.ui-icon-button:hover:not(:disabled) { color: var(--color-ink); background: var(--color-surface-hover); }
.ui-icon-button:active:not(:disabled) { transform: scale(.94); }
.ui-icon-button.is-active { color: var(--color-accent); background: var(--color-accent-soft); }
.ui-icon-button:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }
.ui-icon-button:disabled { opacity: .45; cursor: not-allowed; }
</style>
