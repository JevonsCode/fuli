<script setup lang="ts">
// shadcn-vue TabsTrigger (new-york-v4, unovue/shadcn-vue@0bfec13); local changes in index.ts.
import type { TabsTriggerProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import { TabsTrigger, useForwardProps } from "reka-ui"
import { cn } from "@/lib/class-names"

const props = defineProps<TabsTriggerProps & { class?: HTMLAttributes["class"] }>()

const delegatedProps = reactiveOmit(props, "class")

const forwardedProps = useForwardProps(delegatedProps)
</script>

<template>
  <TabsTrigger
    data-slot="tabs-trigger"
    :class="cn(
      `-mb-px inline-flex min-h-(--control-height) shrink-0 cursor-pointer items-center justify-center gap-1.5 border-0 border-b-2 border-transparent bg-transparent px-3 text-sm font-medium whitespace-nowrap text-muted-foreground transition-[color,border-color] hover:not-disabled:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-45 data-[state=active]:border-primary data-[state=active]:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0`,
      props.class,
    )"
    v-bind="forwardedProps"
  >
    <slot />
  </TabsTrigger>
</template>
