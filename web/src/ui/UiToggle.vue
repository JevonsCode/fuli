<script setup lang="ts">
// The only switch control: a real button with switch semantics, never a
// restyled checkbox per page.
defineProps<{ modelValue: boolean; label: string; disabled?: boolean }>()
defineEmits<{ 'update:modelValue': [value: boolean] }>()
</script>

<template>
  <button type="button" role="switch" class="ui-toggle" :aria-checked="modelValue" :aria-label="label"
    :disabled="disabled" @click="$emit('update:modelValue', !modelValue)">
    <span class="ui-toggle-thumb" aria-hidden="true" />
  </button>
</template>

<style scoped>
.ui-toggle {
  position: relative; flex: 0 0 auto; width: 38px; height: 22px; padding: 0; border: 0;
  border-radius: var(--radius-pill); background: var(--color-border-strong); cursor: pointer;
  transition: background var(--motion-fast);
}
.ui-toggle[aria-checked='true'] { background: var(--color-accent); }
.ui-toggle-thumb {
  position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%;
  background: var(--color-surface); box-shadow: 0 1px 2px rgb(0 0 0 / 20%);
  transition: transform var(--motion-medium) var(--motion-ease);
}
.ui-toggle[aria-checked='true'] .ui-toggle-thumb { transform: translateX(16px); }
.ui-toggle:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }
.ui-toggle:disabled { opacity: .45; cursor: not-allowed; }
</style>
