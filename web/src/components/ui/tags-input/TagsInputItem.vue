<script setup lang="ts">
// shadcn-vue TagsInputItem (new-york-v4, unovue/shadcn-vue@0bfec13); local changes in index.ts.
import type { TagsInputItemProps } from "reka-ui"
import type { HTMLAttributes } from "vue"

import { reactiveOmit } from "@vueuse/core"
import { TagsInputItem, useForwardProps } from "reka-ui"
import { cn } from "@/lib/class-names"

const props = defineProps<TagsInputItemProps & { class?: HTMLAttributes["class"] }>()

const delegatedProps = reactiveOmit(props, "class")

const forwardedProps = useForwardProps(delegatedProps)
</script>

<template>
  <TagsInputItem v-bind="forwardedProps" :class="cn('flex h-5 min-w-0 items-center rounded-md bg-secondary data-[state=active]:bg-accent data-[state=active]:outline-2 data-[state=active]:outline-ring', props.class)">
    <slot />
  </TagsInputItem>
</template>
