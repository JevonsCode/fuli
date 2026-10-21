<script setup lang="ts">
// shadcn-vue DialogContent (new-york-v4, unovue/shadcn-vue@0bfec13); local changes in index.ts.
import type { DialogContentEmits, DialogContentProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import {
  DialogClose,
  DialogContent,
  DialogOverlay,
  DialogPortal,
  useForwardPropsEmits,
} from "reka-ui"
import { Button } from "@/components/ui/button"
import { t } from "@/i18n"
import { cn } from "@/lib/class-names"
import UiIcon from "@/ui/UiIcon.vue"

defineOptions({
  inheritAttrs: false,
})

const props = withDefaults(defineProps<DialogContentProps & {
  class?: HTMLAttributes["class"]
  showCloseButton?: boolean
  size?: "sm" | "md" | "lg"
}>(), {
  showCloseButton: true,
  size: "md",
})
const emits = defineEmits<DialogContentEmits>()

const delegatedProps = reactiveOmit(props, "class", "showCloseButton", "size")

const forwarded = useForwardPropsEmits(delegatedProps, emits)
const widths = { sm: "max-w-[440px]", md: "max-w-[560px]", lg: "max-w-[720px]" }
</script>

<template>
  <DialogPortal>
    <DialogOverlay
      data-slot="dialog-overlay"
      class="fixed inset-0 z-(--z-dialog) bg-overlay backdrop-blur-(--overlay-blur) data-[state=open]:animate-overlay-in"
    />
    <DialogContent
      data-slot="dialog-content"
      v-bind="{ ...$attrs, ...forwarded }"
      :class="
        cn(
          'fixed top-1/2 left-1/2 z-(--z-dialog) grid max-h-[calc(100dvh-64px)] w-[calc(100%-32px)] -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto overscroll-contain rounded-xl border bg-card p-6 text-card-foreground shadow-(--shadow-dialog) outline-none data-[state=open]:animate-dialog-in',
          widths[size],
          props.class,
        )"
    >
      <slot />

      <DialogClose v-if="showCloseButton" as-child>
        <Button
          variant="ghost"
          size="icon-sm"
          class="absolute top-4 right-4 rounded-full"
          :aria-label="t('common.actions.close')"
          :title="t('common.actions.close')"
        >
          <UiIcon name="close" :size="16" />
        </Button>
      </DialogClose>
    </DialogContent>
  </DialogPortal>
</template>
