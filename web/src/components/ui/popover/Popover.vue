<script setup lang="ts">
// shadcn-vue Popover (new-york-v4, unovue/shadcn-vue@0bfec13); local changes in index.ts.
import type { PopoverRootEmits, PopoverRootProps } from "reka-ui"
import { PopoverRoot, useForwardPropsEmits } from "reka-ui"

const props = defineProps<PopoverRootProps>()
const emits = defineEmits<PopoverRootEmits>()

const forwarded = useForwardPropsEmits(props, emits)
</script>

<template>
  <PopoverRoot
    v-slot="slotProps"
    data-slot="popover"
    v-bind="forwarded"
  >
    <slot v-bind="slotProps" />
  </PopoverRoot>
</template>
