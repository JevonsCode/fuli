<script setup lang="ts">
// shadcn-vue SelectScrollUpButton (new-york-v4, unovue/shadcn-vue@0bfec13); local changes in index.ts.
import type { SelectScrollUpButtonProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import { SelectScrollUpButton, useForwardProps } from "reka-ui"
import { cn } from "@/lib/class-names"
import UiIcon from "@/ui/UiIcon.vue"

const props = defineProps<SelectScrollUpButtonProps & { class?: HTMLAttributes["class"] }>()

const delegatedProps = reactiveOmit(props, "class")

const forwardedProps = useForwardProps(delegatedProps)
</script>

<template>
  <SelectScrollUpButton
    data-slot="select-scroll-up-button"
    v-bind="forwardedProps"
    :class="cn('flex cursor-default items-center justify-center py-1', props.class)"
  >
    <slot>
      <UiIcon name="chevron-up" :size="16" />
    </slot>
  </SelectScrollUpButton>
</template>
