<script setup lang="ts">
// shadcn-vue ContextMenuSeparator (new-york-v4); local changes in index.ts.
import type { ContextMenuSeparatorProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import { ContextMenuSeparator } from "reka-ui"
import { cn } from "@/lib/class-names"

const props = defineProps<ContextMenuSeparatorProps & { class?: HTMLAttributes["class"] }>()

const delegatedProps = reactiveOmit(props, "class")
</script>

<template>
  <ContextMenuSeparator
    data-slot="context-menu-separator"
    v-bind="delegatedProps"
    :class="cn('-mx-1 my-1 h-px bg-border', props.class)"
  />
</template>
