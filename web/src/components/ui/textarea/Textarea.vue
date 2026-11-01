<script setup lang="ts">
// shadcn-vue Textarea (new-york-v4, unovue/shadcn-vue@0bfec13); local changes in index.ts.
import type { HTMLAttributes } from "vue"
import { useVModel } from "@vueuse/core"
import { cn } from "@/lib/class-names"
import { FIELD_DISABLED, FIELD_FOCUS, FIELD_LOOK } from "../field-look"

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
    :class="cn(FIELD_LOOK, FIELD_FOCUS, FIELD_DISABLED, 'placeholder:text-muted-foreground aria-invalid:border-destructive flex field-sizing-content min-h-16 w-full px-3 py-2 text-base leading-[1.6]', props.class)"
  />
</template>
