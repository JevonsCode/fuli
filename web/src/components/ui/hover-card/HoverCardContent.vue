<script setup lang="ts">
// shadcn-vue HoverCardContent (new-york-v4, unovue/shadcn-vue@0bfec13); local changes in index.ts.
import type { HoverCardContentProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import {
  HoverCardContent,
  HoverCardPortal,
  useForwardProps,
} from "reka-ui"
import { cn } from "@/lib/class-names"

defineOptions({
  inheritAttrs: false,
})

const props = withDefaults(
  defineProps<HoverCardContentProps & { class?: HTMLAttributes["class"] }>(),
  {
    sideOffset: 4,
  },
)

const delegatedProps = reactiveOmit(props, "class")

const forwardedProps = useForwardProps(delegatedProps)
</script>

<template>
  <HoverCardPortal>
    <HoverCardContent
      data-slot="hover-card-content"
      v-bind="{ ...$attrs, ...forwardedProps }"
      :class="cn('z-(--z-dialog) w-64 origin-(--reka-hover-card-content-transform-origin) rounded-lg border bg-popover p-4 text-popover-foreground shadow-(--shadow-popover) outline-none data-[state=open]:animate-popover-in', props.class)"
    >
      <slot />
    </HoverCardContent>
  </HoverCardPortal>
</template>
