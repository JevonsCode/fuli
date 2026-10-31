<script setup lang="ts">
// shadcn-vue ContextMenuContent (new-york-v4); local changes in index.ts.
import type { ContextMenuContentEmits, ContextMenuContentProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import {
  ContextMenuContent,
  ContextMenuPortal,
  useForwardPropsEmits,
} from "reka-ui"
import { cn } from "@/lib/class-names"

defineOptions({
  inheritAttrs: false,
})

const props = defineProps<ContextMenuContentProps & { class?: HTMLAttributes["class"] }>()
const emits = defineEmits<ContextMenuContentEmits>()

const delegatedProps = reactiveOmit(props, "class")

const forwarded = useForwardPropsEmits(delegatedProps, emits)
</script>

<template>
  <ContextMenuPortal>
    <ContextMenuContent
      data-slot="context-menu-content"
      v-bind="{ ...$attrs, ...forwarded }"
      :class="cn('z-(--z-popover) max-h-(--reka-context-menu-content-available-height) min-w-44 origin-(--reka-context-menu-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-(--shadow-popover) data-[state=open]:animate-popover-in', props.class)"
    >
      <slot />
    </ContextMenuContent>
  </ContextMenuPortal>
</template>
