<script setup lang="ts">
// shadcn-vue CardTitle (new-york-v4, unovue/shadcn-vue@0bfec13); local changes in index.ts.
import type { HTMLAttributes } from "vue"
import { cn } from "@/lib/class-names"

const props = withDefaults(defineProps<{
  as?: "h2" | "h3" | "h4"
  class?: HTMLAttributes["class"]
}>(), { as: "h3" })
</script>

<template>
  <component
    :is="as"
    data-slot="card-title"
    :class="cn('text-lg leading-snug font-semibold', props.class)"
  >
    <slot />
  </component>
</template>
