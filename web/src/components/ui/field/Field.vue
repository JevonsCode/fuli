<script setup lang="ts">
// shadcn-vue Field (new-york-v4, unovue/shadcn-vue@0bfec13); local changes in index.ts.
import type { HTMLAttributes } from "vue"
import type { FieldVariants } from "."
import { cn } from "@/lib/class-names"
import { fieldVariants } from "."

const props = defineProps<{
  class?: HTMLAttributes["class"]
  orientation?: FieldVariants["orientation"]
}>()
</script>

<template>
  <div
    role="group"
    data-slot="field"
    :data-orientation="orientation"
    :class="cn(
      fieldVariants({ orientation }),
      props.class,
    )"
  >
    <slot />
  </div>
</template>
