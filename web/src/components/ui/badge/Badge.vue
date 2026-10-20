<script setup lang="ts">
// shadcn-vue Badge (new-york-v4, unovue/shadcn-vue@0bfec13); local changes in index.ts.
import type { PrimitiveProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import type { BadgeVariants } from "."
import { reactiveOmit } from "@vueuse/core"
import { Primitive } from "reka-ui"
import { cn } from "@/lib/class-names"
import { badgeVariants } from "."

const props = withDefaults(defineProps<PrimitiveProps & {
  variant?: BadgeVariants["variant"]
  class?: HTMLAttributes["class"]
}>(), { as: "span" })

const delegatedProps = reactiveOmit(props, "class", "variant")
</script>

<template>
  <Primitive
    data-slot="badge"
    :data-variant="variant ?? 'default'"
    :class="cn(badgeVariants({ variant }), props.class)"
    v-bind="delegatedProps"
  >
    <slot />
  </Primitive>
</template>
