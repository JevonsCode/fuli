<script setup lang="ts">
withDefaults(defineProps<{ title: string; open?: boolean }>(), { open: false })
</script>

<template>
  <details class="ui-disclosure" :open="open">
    <summary>{{ title }}<slot name="summary" /></summary>
    <slot />
  </details>
</template>
