<script setup lang="ts">
// shadcn-vue SelectTrigger (new-york-v4, unovue/shadcn-vue@0bfec13); local changes in index.ts.
import type { SelectTriggerProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import { SelectIcon, SelectTrigger, useForwardProps } from "reka-ui"
import { cn } from "@/lib/class-names"
import { FIELD_DISABLED, FIELD_FOCUS, FIELD_LOOK, FIELD_OPEN } from "../field-look"
import UiIcon from "@/ui/UiIcon.vue"

const props = withDefaults(
  defineProps<SelectTriggerProps & { class?: HTMLAttributes["class"], size?: "sm" | "default" }>(),
  { size: "default" },
)

const delegatedProps = reactiveOmit(props, "class", "size")
const forwardedProps = useForwardProps(delegatedProps)
</script>

<template>
  <SelectTrigger
    data-slot="select-trigger"
    :data-size="size"
    v-bind="forwardedProps"
    :class="cn(
      FIELD_LOOK, FIELD_FOCUS, FIELD_OPEN, FIELD_DISABLED,
      `data-[placeholder]:text-muted-foreground [&_svg:not([class*='text-'])]:text-muted-foreground aria-invalid:border-destructive flex w-fit cursor-pointer appearance-none items-center justify-between gap-2 px-3 py-1.5 text-base leading-[1.5] whitespace-nowrap data-[size=default]:h-(--control-height) data-[size=sm]:h-(--control-height-sm) data-[size=sm]:text-sm *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-2 [&_svg]:pointer-events-none [&_svg]:shrink-0`,
      props.class,
    )"
  >
    <slot />
    <SelectIcon as-child>
      <UiIcon name="chevron-down" :size="14" />
    </SelectIcon>
  </SelectTrigger>
</template>
