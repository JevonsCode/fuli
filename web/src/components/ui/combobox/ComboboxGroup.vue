<script setup lang="ts">
// shadcn-vue ComboboxGroup (new-york-v4, unovue/shadcn-vue@0bfec13); local changes in index.ts.
import type { ComboboxGroupProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import { ComboboxGroup, ComboboxLabel } from "reka-ui"
import { cn } from "@/lib/class-names"

const props = defineProps<ComboboxGroupProps & {
  class?: HTMLAttributes["class"]
  heading?: string
}>()

const delegatedProps = reactiveOmit(props, "class")
</script>

<template>
  <ComboboxGroup
    data-slot="combobox-group"
    v-bind="delegatedProps"
    :class="cn('overflow-hidden p-1 text-foreground', props.class)"
  >
    <ComboboxLabel v-if="heading" class="px-2 py-1.5 text-xs font-medium text-muted-foreground">
      {{ heading }}
    </ComboboxLabel>
    <slot />
  </ComboboxGroup>
</template>
