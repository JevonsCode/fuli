<script setup lang="ts">
// shadcn-vue TableRow (new-york-v4, unovue/shadcn-vue@0bfec13); local changes in index.ts.
import type { HTMLAttributes } from "vue"
import { cn } from "@/lib/class-names"

const props = defineProps<{
  class?: HTMLAttributes["class"]
}>()
</script>

<template>
  <tr
    data-slot="table-row"
    :class="cn('border-b transition-colors hover:bg-accent data-[state=selected]:bg-muted', props.class)"
  >
    <slot />
  </tr>
</template>
