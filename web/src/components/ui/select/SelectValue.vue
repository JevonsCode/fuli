<script setup lang="ts">
// shadcn-vue SelectValue (new-york-v4, unovue/shadcn-vue@0bfec13); local changes in index.ts.
import type { SelectValueProps } from "reka-ui"
import { SelectValue } from "reka-ui"

const props = defineProps<SelectValueProps>()
</script>

<template>
  <SelectValue
    data-slot="select-value"
    v-bind="props"
  >
    <slot />
  </SelectValue>
</template>
