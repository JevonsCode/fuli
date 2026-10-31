<script setup lang="ts">
// shadcn-vue PopoverContent (new-york-v4, unovue/shadcn-vue@0bfec13); local changes in index.ts.
import type { PopoverContentEmits, PopoverContentProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import {
  PopoverContent,
  PopoverPortal,
  useForwardPropsEmits,
} from "reka-ui"
import { cn } from "@/lib/class-names"

defineOptions({
  inheritAttrs: false,
})

const props = withDefaults(
  defineProps<PopoverContentProps & { class?: HTMLAttributes["class"] }>(),
  {
    align: "center",
    sideOffset: 4,
  },
)
const emits = defineEmits<PopoverContentEmits>()

const delegatedProps = reactiveOmit(props, "class")

const forwarded = useForwardPropsEmits(delegatedProps, emits)
</script>

<template>
  <PopoverPortal>
    <PopoverContent
      data-slot="popover-content"
      v-bind="{ ...$attrs, ...forwarded }"
      :class="cn('z-(--z-dialog) w-72 origin-(--reka-popover-content-transform-origin) rounded-(--radius-card) border border-border bg-popover p-4 text-popover-foreground shadow-(--shadow-popover) outline-none data-[state=open]:animate-popover-in', props.class)"
    >
      <slot />
    </PopoverContent>
  </PopoverPortal>
</template>
