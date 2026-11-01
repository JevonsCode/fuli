<script setup lang="ts">
// shadcn-vue Input (new-york-v4, unovue/shadcn-vue@0bfec13); local changes in index.ts.
import type { HTMLAttributes } from "vue"
import { useVModel } from "@vueuse/core"
import { cn } from "@/lib/class-names"
import { FIELD_SIZE, type ControlSize } from "../control-size"
import { FIELD_DISABLED, FIELD_FOCUS, FIELD_LOOK } from "../field-look"

const props = withDefaults(defineProps<{
  defaultValue?: string | number
  modelValue?: string | number
  size?: ControlSize
  class?: HTMLAttributes["class"]
}>(), { defaultValue: undefined, modelValue: undefined, size: "md", class: undefined })

const emits = defineEmits<{
  (e: "update:modelValue", payload: string | number): void
}>()

const modelValue = useVModel(props, "modelValue", emits, {
  passive: true,
  defaultValue: props.defaultValue,
})
</script>

<template>
  <input
    v-model="modelValue"
    data-slot="input"
    :data-size="size"
    :class="cn(
      FIELD_LOOK, FIELD_FOCUS, FIELD_DISABLED,
      'file:text-foreground placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground w-full min-w-0 py-1 file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium',
      FIELD_SIZE[size],
      'aria-invalid:ring-destructive-soft aria-invalid:border-destructive',
      props.class,
    )"
  >
</template>
