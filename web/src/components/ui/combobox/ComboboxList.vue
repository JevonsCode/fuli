<script setup lang="ts">
// shadcn-vue ComboboxList (new-york-v4, unovue/shadcn-vue@0bfec13); local changes in index.ts.
import type { ComboboxContentEmits, ComboboxContentProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import { ComboboxContent, ComboboxPortal, useForwardPropsEmits } from "reka-ui"
import { cn } from "@/lib/class-names"

defineOptions({
  inheritAttrs: false,
})

const props = withDefaults(defineProps<ComboboxContentProps & { class?: HTMLAttributes["class"] }>(), {
  position: "popper",
  align: "start",
  sideOffset: 4,
})
const emits = defineEmits<ComboboxContentEmits>()

const delegatedProps = reactiveOmit(props, "class")
const forwarded = useForwardPropsEmits(delegatedProps, emits)
</script>

<template>
  <ComboboxPortal>
    <ComboboxContent
      data-slot="combobox-list"
      v-bind="{ ...$attrs, ...forwarded }"
      :class="cn('z-(--z-popover) w-[200px] max-h-(--reka-combobox-content-available-height) origin-(--reka-combobox-content-transform-origin) flex-col overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-(--shadow-popover) outline-none data-[state=open]:animate-popover-in', props.class)"
    >
      <slot />
    </ComboboxContent>
  </ComboboxPortal>
</template>
