<script setup lang="ts">
// shadcn-vue HoverCardTrigger (new-york-v4, unovue/shadcn-vue@0bfec13); local changes in index.ts.
import type { HoverCardTriggerProps } from "reka-ui"
import { HoverCardTrigger } from "reka-ui"

const props = defineProps<HoverCardTriggerProps>()
</script>

<template>
  <HoverCardTrigger
    data-slot="hover-card-trigger"
    v-bind="props"
  >
    <slot />
  </HoverCardTrigger>
</template>
