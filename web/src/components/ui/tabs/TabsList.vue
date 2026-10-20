<script setup lang="ts">
// shadcn-vue TabsList (new-york-v4, unovue/shadcn-vue@0bfec13); local changes in index.ts.
import type { TabsListProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import { TabsList } from "reka-ui"
import { cn } from "@/lib/class-names"

const props = defineProps<TabsListProps & { class?: HTMLAttributes["class"] }>()

const delegatedProps = reactiveOmit(props, "class")
</script>

<template>
  <TabsList
    data-slot="tabs-list"
    v-bind="delegatedProps"
    :class="cn(
      'flex w-full items-end gap-1 overflow-x-auto border-b text-muted-foreground [scrollbar-width:none]',
      props.class,
    )"
  >
    <slot />
  </TabsList>
</template>
