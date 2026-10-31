<script setup lang="ts">
// shadcn-vue PopoverTrigger (new-york-v4, unovue/shadcn-vue@0bfec13); local changes in index.ts.
import type { PopoverTriggerProps } from "reka-ui"
import { PopoverTrigger } from "reka-ui"

const props = defineProps<PopoverTriggerProps>()
</script>

<template>
  <PopoverTrigger
    data-slot="popover-trigger"
    v-bind="props"
  >
    <slot />
  </PopoverTrigger>
</template>
