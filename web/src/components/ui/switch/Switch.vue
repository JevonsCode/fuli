<script setup lang="ts">
// shadcn-vue Switch (new-york-v4, unovue/shadcn-vue@0bfec13); local changes in index.ts.
import type { SwitchRootEmits, SwitchRootProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import {
  SwitchRoot,
  SwitchThumb,
  useForwardPropsEmits,
} from "reka-ui"
import { cn } from "@/lib/class-names"

const props = defineProps<SwitchRootProps & { class?: HTMLAttributes["class"] }>()

const emits = defineEmits<SwitchRootEmits>()

const delegatedProps = reactiveOmit(props, "class")

const forwarded = useForwardPropsEmits(delegatedProps, emits)
</script>

<template>
  <SwitchRoot
    v-slot="slotProps"
    data-slot="switch"
    v-bind="forwarded"
    :class="cn(
      'peer data-[state=checked]:bg-primary data-[state=unchecked]:bg-border-strong inline-flex h-[22px] w-[38px] shrink-0 cursor-pointer items-center rounded-full border border-transparent p-[2px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-45',
      props.class,
    )"
  >
    <SwitchThumb
      data-slot="switch-thumb"
      :class="cn('bg-card pointer-events-none block size-4 rounded-full shadow-xs ring-0 transition-transform duration-(--motion-medium) data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0')"
    >
      <slot name="thumb" v-bind="slotProps" />
    </SwitchThumb>
  </SwitchRoot>
</template>
