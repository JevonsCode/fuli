<template>
  <span class="ui-chip-row">
    <!-- Wrapped chips share one gap and one baseline, so second rows line up. -->
    <slot />
  </span>
</template>

<style scoped>
.ui-chip-row { display: flex; flex-wrap: wrap; align-items: center; align-content: flex-start; gap: 6px; min-width: 0; }
</style>