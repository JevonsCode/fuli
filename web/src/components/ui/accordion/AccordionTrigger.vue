<script setup lang="ts">
// shadcn-vue AccordionTrigger (new-york-v4, unovue/shadcn-vue@0bfec13); local changes in index.ts.
import type { AccordionTriggerProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import {
  AccordionHeader,
  AccordionTrigger,
} from "reka-ui"
import { cn } from "@/lib/class-names"
import UiIcon from "@/ui/UiIcon.vue"

const props = defineProps<AccordionTriggerProps & { class?: HTMLAttributes["class"] }>()

const delegatedProps = reactiveOmit(props, "class")
</script>

<template>
  <AccordionHeader class="flex">
    <AccordionTrigger
      data-slot="accordion-trigger"
      v-bind="delegatedProps"
      :class="
        cn(
          'flex flex-1 cursor-pointer items-center justify-between gap-4 border-0 bg-transparent px-0 py-4 text-left text-lg font-semibold text-foreground transition-colors hover:not-disabled:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-45 [&[data-state=open]>svg]:rotate-180',
          props.class,
        )
      "
    >
      <slot />
      <slot name="icon">
        <UiIcon
          name="chevron-down"
          :size="16"
          class="pointer-events-none shrink-0 text-muted-foreground transition-transform"
        />
      </slot>
    </AccordionTrigger>
  </AccordionHeader>
</template>
