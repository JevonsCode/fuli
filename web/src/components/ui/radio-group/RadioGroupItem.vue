<script setup lang="ts">
// shadcn-vue RadioGroupItem (new-york-v4, unovue/shadcn-vue@0bfec13); local changes in index.ts.
import type { RadioGroupItemProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import {
  RadioGroupIndicator,
  RadioGroupItem,
  useForwardProps,
} from "reka-ui"
import { cn } from "@/lib/class-names"

const props = defineProps<RadioGroupItemProps & { class?: HTMLAttributes["class"] }>()

const delegatedProps = reactiveOmit(props, "class")

const forwardedProps = useForwardProps(delegatedProps)
</script>

<template>
  <RadioGroupItem
    data-slot="radio-group-item"
    v-bind="forwardedProps"
    :class="
      cn(
        'border-input data-[state=checked]:border-primary data-[state=checked]:bg-primary aria-invalid:border-destructive aspect-square size-4 shrink-0 cursor-pointer rounded-full border-[1.5px] bg-card p-0 transition-[background-color,border-color] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50',
        props.class,
      )
    "
  >
    <RadioGroupIndicator
      data-slot="radio-group-indicator"
      class="relative flex items-center justify-center"
    >
      <slot>
        <span class="absolute top-1/2 left-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary-foreground" />
      </slot>
    </RadioGroupIndicator>
  </RadioGroupItem>
</template>
