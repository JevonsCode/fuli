<script setup lang="ts">
// shadcn-vue SelectGroup (new-york-v4, unovue/shadcn-vue@0bfec13); local changes in index.ts.
import type { SelectGroupProps } from "reka-ui"
import { SelectGroup } from "reka-ui"

const props = defineProps<SelectGroupProps>()
</script>

<template>
  <SelectGroup
    data-slot="select-group"
    v-bind="props"
  >
    <slot />
  </SelectGroup>
</template>
