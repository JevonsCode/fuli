<script setup lang="ts">
// shadcn-vue Button, style new-york-v4, from unovue/shadcn-vue@0bfec13
// (2026-10-15). Source we maintain, not an upgrading dependency; compare with
// `npx shadcn-vue@2.8.2 diff button`. Local changes:
// - `cn` comes from @/lib/class-names (clsx + tailwind-merge) rather than the
//   0.x `cn` package upstream switched to on 2026-10-15.
// - data-variant and data-size are set for the defaults too, as in shadcn/ui.
// - A native button defaults to type="button", so it never submits by accident.
// - `loading` replaces the content with GrowthLoading (inline) and
//   `loadingLabel`, and disables the button so a pending action cannot be
//   sent twice (AGENTS.md, Loading Feedback).
import type { PrimitiveProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import type { ButtonVariants } from "."
import { Primitive } from "reka-ui"
import { computed } from "vue"
import GrowthLoading from "@/components/GrowthLoading.vue"
import { cn } from "@/lib/class-names"
import { buttonVariants } from "."

interface Props extends PrimitiveProps {
  variant?: ButtonVariants["variant"]
  size?: ButtonVariants["size"]
  class?: HTMLAttributes["class"]
  type?: "button" | "submit" | "reset"
  disabled?: boolean
  loading?: boolean
  loadingLabel?: string
}

const props = withDefaults(defineProps<Props>(), {
  as: "button",
  variant: "default",
  size: "md",
  type: "button",
  loadingLabel: "",
})

const native = computed(() => props.as === "button" && !props.asChild)
</script>

<template>
  <Primitive
    data-slot="button"
    :data-variant="variant"
    :data-size="size"
    :as="as"
    :as-child="asChild"
    :type="native ? type : undefined"
    :disabled="native && (disabled || loading) ? true : undefined"
    :aria-busy="loading || undefined"
    :class="cn(buttonVariants({ variant, size }), props.class)"
  >
    <GrowthLoading v-if="loading" variant="inline" :label="loadingLabel" />
    <slot v-else />
  </Primitive>
</template>
