<script setup lang="ts">
// shadcn-vue Button, style new-york-v4, from unovue/shadcn-vue@0bfec13
// (2026-10-15). Source we maintain, not an upgrading dependency; compare with
// `npx shadcn-vue@2.8.2 diff button`. Local changes:
// - `cn` comes from @/lib/class-names (clsx + tailwind-merge) rather than the
//   0.x `cn` package upstream switched to on 2026-10-15.
// - data-variant and data-size are set for the defaults too, as in shadcn/ui.
// - A native button defaults to type="button", so it never submits by accident.
// - `loading` shows GrowthLoading (inline, named by `loadingLabel`) over the
//   content, which keeps its room but turns invisible, so the button never
//   changes size and nothing beside it moves (Jevons 11-02); it also disables
//   the button so a pending action cannot be sent twice (AGENTS.md, Loading Feedback).
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
    :class="cn(buttonVariants({ variant, size }), props.class, loading && 'is-loading')"
  >
    <!-- asChild hands every attribute to the one child (a link), so it gets no wrapper. -->
    <slot v-if="asChild" />
    <template v-else>
      <span class="button-content"><slot /></span>
      <GrowthLoading v-if="loading" class="button-loading" variant="inline" :label="loadingLabel" />
    </template>
  </Primitive>
</template>

<style scoped>
/* The content keeps laying out the button (display: contents) and only turns invisible while loading.
   It passes the button's corners on, so content that takes `border-radius: inherit` (a portrait
   filling the button) keeps them instead of turning square (11-03: 头像框角上漏出底色). */
.button-content { display: contents; border-radius: inherit; }
.is-loading { position: relative; }
.is-loading > .button-content { visibility: hidden; }
/* The mark sits over the content; its words are its accessible name, not drawn in the narrow button. */
.button-loading { position: absolute; inset: 0; justify-content: center; }
.button-loading :deep(.growth-loading__label) { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
</style>
