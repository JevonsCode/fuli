<script setup lang="ts">
// shadcn-vue TagsInputItemText (new-york-v4, unovue/shadcn-vue@0bfec13); local changes in index.ts.
import type { TagsInputItemTextProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import { TagsInputItemText, useForwardProps } from "reka-ui"
import { cn } from "@/lib/class-names"

const props = defineProps<TagsInputItemTextProps & { class?: HTMLAttributes["class"] }>()

const delegatedProps = reactiveOmit(props, "class")

const forwardedProps = useForwardProps(delegatedProps)
</script>

<template>
  <TagsInputItemText v-bind="forwardedProps" :class="cn('min-w-0 truncate py-0.5 px-2 text-xs rounded bg-transparent', props.class)">
    <slot />
  </TagsInputItemText>
</template>
