<script setup lang="ts" generic="T extends string">
// Mutually exclusive filters or views: one row of choices, one active.
defineProps<{
  modelValue: T
  options: readonly { value: T; label: string; count?: number }[]
  label: string
}>()
defineEmits<{ 'update:modelValue': [value: T] }>()
</script>

<template>
  <div class="ui-segmented" role="group" :aria-label="label">
    <button v-for="option in options" :key="option.value" type="button" :aria-pressed="option.value === modelValue"
      @click="$emit('update:modelValue', option.value)">
      {{ option.label }}<small v-if="option.count !== undefined">{{ option.count }}</small>
    </button>
  </div>
</template>
