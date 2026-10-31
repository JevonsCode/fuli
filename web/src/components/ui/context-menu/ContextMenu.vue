<script setup lang="ts">
// shadcn-vue ContextMenu (new-york-v4); local changes in index.ts.
import type { ContextMenuRootEmits, ContextMenuRootProps } from "reka-ui"
import { ContextMenuRoot, useForwardPropsEmits } from "reka-ui"

const props = defineProps<ContextMenuRootProps>()
const emits = defineEmits<ContextMenuRootEmits>()

const forwarded = useForwardPropsEmits(props, emits)
</script>

<template>
  <ContextMenuRoot data-slot="context-menu" v-bind="forwarded">
    <slot />
  </ContextMenuRoot>
</template>
