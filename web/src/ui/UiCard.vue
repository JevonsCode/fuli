<script setup lang="ts">
withDefaults(defineProps<{ interactive?: boolean; tag?: string }>(), { interactive: false, tag: 'article' })
</script>

<template>
  <!-- The one surface: interactive cards lift slightly on hover (transform only). -->
  <component :is="tag" class="ui-card-surface" :class="{ 'is-interactive': interactive }"><slot /></component>
</template>

<style scoped>
.ui-card-surface {
  display: block; padding: 14px 16px; border: 1px solid var(--color-border); border-radius: var(--radius-card);
  background: var(--color-surface);
  transition: transform var(--motion-fast) var(--motion-ease), border-color var(--motion-fast);
}
.ui-card-surface.is-interactive { cursor: pointer; }
.ui-card-surface.is-interactive:hover { border-color: var(--color-border-strong); transform: translateY(-2px); }
@media (prefers-reduced-motion: reduce) { .ui-card-surface.is-interactive:hover { transform: none; } }
</style>
