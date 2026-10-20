<script setup lang="ts">
// shadcn-vue Textarea (new-york-v4, unovue/shadcn-vue@0bfec13); local changes in index.ts.
import type { HTMLAttributes } from "vue"
import { useVModel } from "@vueuse/core"
import { cn } from "@/lib/class-names"

const props = defineProps<{
  class?: HTMLAttributes["class"]
  defaultValue?: string | number
  modelValue?: string | number
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
  <textarea
    v-model="modelValue"
    data-slot="textarea"
    :class="cn('border-input placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-primary-soft aria-invalid:ring-destructive-soft aria-invalid:border-destructive flex field-sizing-content min-h-16 w-full rounded-md border bg-card px-3 py-2 text-base leading-[1.6] text-foreground transition-[border-color,box-shadow] outline-none hover:not-disabled:border-border-strong focus-visible:ring-3 focus-visible:outline-none disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground', props.class)"
  />
</template>
