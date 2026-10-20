<script setup lang="ts">
// shadcn-vue FieldLabel (new-york-v4, unovue/shadcn-vue@0bfec13); local changes in index.ts.
import type { HTMLAttributes } from "vue"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/class-names"

const props = defineProps<{
  class?: HTMLAttributes["class"]
}>()
</script>

<template>
  <Label
    data-slot="field-label"
    :class="cn(
      'group/field-label peer/field-label flex w-fit gap-2 leading-snug group-data-[disabled=true]/field:opacity-45',
      'has-[>[data-slot=field]]:w-full has-[>[data-slot=field]]:flex-col has-[>[data-slot=field]]:rounded-md has-[>[data-slot=field]]:border [&>*]:data-[slot=field]:p-4',
      'has-data-[state=checked]:bg-primary-soft has-data-[state=checked]:border-primary',
      props.class,
    )"
  >
    <slot />
  </Label>
</template>
