<script setup lang="ts">
// shadcn-vue Input (new-york-v4, unovue/shadcn-vue@0bfec13); local changes in index.ts.
import type { HTMLAttributes } from "vue"
import { useVModel } from "@vueuse/core"
import { cn } from "@/lib/class-names"

const props = defineProps<{
  defaultValue?: string | number
  modelValue?: string | number
  class?: HTMLAttributes["class"]
}>()

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
    :class="cn(
      'file:text-foreground placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground border-input h-(--control-height) w-full min-w-0 rounded-md border bg-card px-3 py-1.5 text-base leading-[1.5] text-foreground transition-[border-color,box-shadow] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium hover:not-disabled:border-border-strong disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground',
      'focus-visible:border-ring focus-visible:ring-primary-soft focus-visible:ring-3 focus-visible:outline-none',
      'aria-invalid:ring-destructive-soft aria-invalid:border-destructive',
      props.class,
    )"
  >
</template>
