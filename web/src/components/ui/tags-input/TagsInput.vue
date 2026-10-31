<script setup lang="ts">
// shadcn-vue TagsInput (new-york-v4, unovue/shadcn-vue@0bfec13); local changes in index.ts.
import type { TagsInputRootEmits, TagsInputRootProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import { TagsInputRoot, useForwardPropsEmits } from "reka-ui"
import { cn } from "@/lib/class-names"

const props = defineProps<TagsInputRootProps & { class?: HTMLAttributes["class"] }>()
const emits = defineEmits<TagsInputRootEmits>()

const delegatedProps = reactiveOmit(props, "class")

const forwarded = useForwardPropsEmits(delegatedProps, emits)
</script>

<template>
  <TagsInputRoot
    v-slot="slotProps" v-bind="forwarded" :class="cn(
      'flex flex-wrap gap-1.5 items-center rounded-md border border-input bg-card px-2 py-1 text-sm transition-[border-color,box-shadow] outline-none',
      'focus-within:border-ring focus-within:ring-primary-soft focus-within:ring-3',
      'aria-invalid:ring-destructive-soft aria-invalid:border-destructive',
      props.class)"
  >
    <slot v-bind="slotProps" />
  </TagsInputRoot>
</template>
