<script setup lang="ts">
// shadcn-vue Card (new-york-v4, unovue/shadcn-vue@0bfec13); local changes in index.ts.
import type { HTMLAttributes } from "vue"
import { cn } from "@/lib/class-names"

const props = withDefaults(defineProps<{
  as?: "div" | "section" | "article" | "aside" | "header"
  class?: HTMLAttributes["class"]
}>(), { as: "div" })
</script>

<template>
  <component
    :is="as"
    data-slot="card"
    :class="cn('flex min-w-0 flex-col gap-4 rounded-lg border bg-card py-5 text-card-foreground', props.class)"
  >
    <slot />
  </component>
</template>
