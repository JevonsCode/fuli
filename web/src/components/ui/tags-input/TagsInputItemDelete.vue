<script setup lang="ts">
// shadcn-vue TagsInputItemDelete (new-york-v4, unovue/shadcn-vue@0bfec13); local changes in index.ts.
import type { TagsInputItemDeleteProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import { TagsInputItemDelete, useForwardProps } from "reka-ui"
import { cn } from "@/lib/class-names"
import UiIcon from "@/ui/UiIcon.vue"

const props = defineProps<TagsInputItemDeleteProps & { class?: HTMLAttributes["class"] }>()

const delegatedProps = reactiveOmit(props, "class")

const forwardedProps = useForwardProps(delegatedProps)
</script>

<template>
  <TagsInputItemDelete v-bind="forwardedProps" :class="cn('flex cursor-pointer rounded bg-transparent mr-1 text-muted-foreground hover:text-foreground', props.class)">
    <slot>
      <UiIcon name="close" :size="12" />
    </slot>
  </TagsInputItemDelete>
</template>
