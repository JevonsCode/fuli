<script setup lang="ts" generic="T extends string">
import UiIcon from './UiIcon.vue'
import type { IconName } from './icons'

// Mutually exclusive filters or views: one row of choices, one active. An
// option with an icon and iconOnly shows just the icon, labelled for a11y;
// a swatch (any CSS colour, usually a token) shows a small dot before the label.
defineProps<{
  modelValue: T
  options: readonly { value: T; label: string; count?: number; icon?: IconName; iconOnly?: boolean; swatch?: string }[]
  label: string
}>()
defineEmits<{ 'update:modelValue': [value: T] }>()
</script>

<template>
  <div class="ui-segmented" role="group" :aria-label="label">
    <button v-for="option in options" :key="option.value" type="button" :aria-pressed="option.value === modelValue" :data-value="option.value"
      :aria-label="option.iconOnly ? option.label : undefined" :title="option.iconOnly ? option.label : undefined"
      @click="$emit('update:modelValue', option.value)">
      <span v-if="option.swatch" class="ui-segmented-swatch" :style="{ background: option.swatch }" aria-hidden="true" /><UiIcon v-if="option.icon" :name="option.icon" :size="16" /><template v-if="!option.iconOnly">{{ option.label }}</template><small v-if="option.count !== undefined">{{ option.count }}</small>
    </button>
  </div>
</template>
