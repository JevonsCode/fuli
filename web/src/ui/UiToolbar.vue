<script setup lang="ts">
// The row above a page's list: filters and search at the start, a count and
// actions at the end. Same spacing on every page.
</script>

<template>
  <div class="ui-toolbar">
    <div class="ui-toolbar-start"><slot /></div>
    <div v-if="$slots.end" class="ui-toolbar-end"><slot name="end" /></div>
  </div>
</template>

<style scoped>
.ui-toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px 16px; }
.ui-toolbar-start, .ui-toolbar-end { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; }
.ui-toolbar-end { margin-left: auto; color: var(--color-muted); font-size: 13px; }
</style>
