<script setup lang="ts">
// shadcn-vue CardDescription (new-york-v4, unovue/shadcn-vue@0bfec13); local changes in index.ts.
import type { HTMLAttributes } from "vue"
import { cn } from "@/lib/class-names"

const props = defineProps<{
  class?: HTMLAttributes["class"]
}>()
</script>

<template>
  <p
    data-slot="card-description"
    :class="cn('text-xs text-muted-foreground', props.class)"
  >
    <slot />
  </p>
</template>
