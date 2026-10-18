<script setup lang="ts">
import UiIcon from './UiIcon.vue'
import type { IconName } from './icons'

// An empty state is information: one icon and one short line, shown in place
// instead of hiding the section behind a toggle.
withDefaults(defineProps<{ icon?: IconName; text: string }>(), { icon: 'info' })
</script>

<template>
  <div class="ui-empty" role="status">
    <UiIcon :name="icon" :size="22" />
    <span>{{ text }}</span>
    <slot />
  </div>
</template>

<style scoped>
.ui-empty {
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px;
  padding: 24px 16px; border: 1px dashed var(--color-border); border-radius: var(--radius-card);
  color: var(--color-muted); font-size: 13px; text-align: center;
}
</style>
