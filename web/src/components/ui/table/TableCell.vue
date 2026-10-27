<script setup lang="ts">
// shadcn-vue TableCell (new-york-v4, unovue/shadcn-vue@0bfec13); local changes in index.ts.
import type { HTMLAttributes } from "vue"
import { cn } from "@/lib/class-names"

const props = defineProps<{
  class?: HTMLAttributes["class"]
}>()
</script>

<template>
  <td
    data-slot="table-cell"
    :class="cn('px-3 py-2.5 align-middle', props.class)"
  >
    <slot />
  </td>
</template>
