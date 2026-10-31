<script setup lang="ts">
// shadcn-vue ContextMenuItem (new-york-v4); local changes in index.ts.
import type { ContextMenuItemEmits, ContextMenuItemProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import { ContextMenuItem, useForwardPropsEmits } from "reka-ui"
import { cn } from "@/lib/class-names"

const props = withDefaults(defineProps<ContextMenuItemProps & {
  class?: HTMLAttributes["class"]
  inset?: boolean
  variant?: "default" | "destructive"
}>(), {
  variant: "default",
})
const emits = defineEmits<ContextMenuItemEmits>()

const delegatedProps = reactiveOmit(props, "inset", "variant", "class")

const forwarded = useForwardPropsEmits(delegatedProps, emits)
</script>

<template>
  <ContextMenuItem
    data-slot="context-menu-item"
    :data-inset="inset ? '' : undefined"
    :data-variant="variant"
    v-bind="forwarded"
    :class="cn('relative flex min-h-8 cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none select-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-45 data-[inset]:pl-8 data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive-soft [&_svg]:pointer-events-none [&_svg]:shrink-0', props.class)"
  >
    <slot />
  </ContextMenuItem>
</template>
