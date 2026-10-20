<script setup lang="ts">
// shadcn-vue DialogFooter (new-york-v4, unovue/shadcn-vue@0bfec13); local changes in index.ts.
import type { HTMLAttributes } from "vue"
import { cn } from "@/lib/class-names"

const props = defineProps<{
  class?: HTMLAttributes["class"]
}>()
</script>

<template>
  <div
    data-slot="dialog-footer"
    :class="cn('flex flex-col-reverse gap-2 sm:flex-row sm:flex-wrap sm:justify-end', props.class)"
  >
    <slot />
  </div>
</template>
