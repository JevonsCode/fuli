<script setup lang="ts">
// shadcn-vue TableHead (new-york-v4, unovue/shadcn-vue@0bfec13); local changes in index.ts.
import type { HTMLAttributes } from "vue"
import { cn } from "@/lib/class-names"

const props = defineProps<{
  class?: HTMLAttributes["class"]
}>()
</script>

<template>
  <th
    data-slot="table-head"
    :class="cn('h-10 px-3 text-left align-middle text-xs font-semibold whitespace-nowrap text-muted-foreground', props.class)"
  >
    <slot />
  </th>
</template>
