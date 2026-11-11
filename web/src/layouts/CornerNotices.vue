<script setup lang="ts">
import NpmCopyNotice from '@/features/npm-copies/NpmCopyNotice.vue'
import TourResumeNotice from '@/features/onboarding-tour/TourResumeNotice.vue'
import WhatsNewNotice from '@/features/whats-new/WhatsNewNotice.vue'

// The floating notices at the bottom right, just above the dock: a paused
// beginner's guide, what is new after an update, an older npm copy of FULI.
// They stack upwards from the dock without overlapping, never cover the top
// bar or a page's tabs, and take no height from the page. The npm copy stays
// lowest and the paused guide highest, so closing one never moves the others.
</script>

<template>
  <div class="corner-notices" data-corner-notices>
    <TourResumeNotice />
    <WhatsNewNotice />
    <NpmCopyNotice />
  </div>
</template>

<style scoped>
/* The column is anchored at the dock and empty space lets clicks through to the page. */
.corner-notices {
  position: fixed; bottom: var(--dock-clearance); right: calc(var(--page-inline) + var(--scrollbar-size)); z-index: var(--z-popover);
  display: flex; flex-direction: column; justify-content: flex-end; gap: 8px;
  width: min(440px, calc(100vw - 2 * var(--page-inline))); max-height: calc(100dvh - var(--dock-clearance) - 120px);
  pointer-events: none;
}
.corner-notices > :deep(*) { pointer-events: auto; }
</style>
