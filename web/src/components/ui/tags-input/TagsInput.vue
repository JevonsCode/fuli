<script setup lang="ts">
// shadcn-vue TagsInput (new-york-v4, unovue/shadcn-vue@0bfec13); local changes in index.ts.
import type { TagsInputRootEmits, TagsInputRootProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import { TagsInputRoot, useForwardPropsEmits } from "reka-ui"
import { cn } from "@/lib/class-names"
import { FIELD_FOCUS_WITHIN, FIELD_LOOK } from "../field-look"

const props = defineProps<TagsInputRootProps & { class?: HTMLAttributes["class"] }>()
const emits = defineEmits<TagsInputRootEmits>()

const delegatedProps = reactiveOmit(props, "class")

const forwarded = useForwardPropsEmits(delegatedProps, emits)
</script>

<template>
  <TagsInputRoot
    v-slot="slotProps" v-bind="forwarded" :class="cn(
      FIELD_LOOK, FIELD_FOCUS_WITHIN,
      'flex flex-wrap gap-1.5 items-center px-2 py-1 text-sm',
      'aria-invalid:ring-destructive-soft aria-invalid:border-destructive',
      props.class)"
  >
    <slot v-bind="slotProps" />
  </TagsInputRoot>
</template>
