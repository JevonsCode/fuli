<script setup lang="ts">
// shadcn-vue ComboboxItemIndicator (new-york-v4, unovue/shadcn-vue@0bfec13); local changes in index.ts.
import type { ComboboxItemIndicatorProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import { ComboboxItemIndicator, useForwardProps } from "reka-ui"
import { cn } from "@/lib/class-names"

const props = defineProps<ComboboxItemIndicatorProps & { class?: HTMLAttributes["class"] }>()

const delegatedProps = reactiveOmit(props, "class")

const forwarded = useForwardProps(delegatedProps)
</script>

<template>
  <ComboboxItemIndicator
    data-slot="combobox-item-indicator"
    v-bind="forwarded"
    :class="cn('ml-auto', props.class)"
  >
    <slot />
  </ComboboxItemIndicator>
</template>
