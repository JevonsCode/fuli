<script setup lang="ts">
// The cards of a page, one under another in one column. Its width is the
// person's choice (设置 › 系统 › 页面宽度): a comfortable reading width, centred,
// or the whole window (lib/page-width-preference.ts).
// Cards are never dealt into two columns that scroll together: columns of
// different heights leave a hole under the shorter one. A page that wants two
// halves fixes one and lets only the other scroll (the workbench, 今天).
</script>

<template>
  <div class="page-stack"><slot /></div>
</template>

<style>
/* Not scoped: pages size the cards they put inside. */
.page-stack { display: flex; flex-direction: column; gap: var(--space-4); width: 100%; max-width: 960px; min-width: 0; margin-inline: auto; }
:root[data-page-width="full"] .page-stack { max-width: none; }
</style>
