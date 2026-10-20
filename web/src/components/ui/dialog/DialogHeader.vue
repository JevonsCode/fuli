<script setup lang="ts">
// shadcn-vue DialogHeader (new-york-v4, unovue/shadcn-vue@0bfec13); local changes in index.ts.
import type { HTMLAttributes } from "vue"
import { cn } from "@/lib/class-names"

const props = defineProps<{
  class?: HTMLAttributes["class"]
}>()
</script>

<template>
  <div
    data-slot="dialog-header"
    :class="cn('flex flex-col gap-1.5 pr-10 text-left', props.class)"
  >
    <slot />
  </div>
</template>
