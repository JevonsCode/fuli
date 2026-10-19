<script setup lang="ts">
import { Button } from '@/components/ui/button'
import UiIcon from './UiIcon.vue'
import type { IconName } from './icons'

// An action shown as an icon only: the shared Button in its ghost icon size.
// The wrapper exists for one repeated contract: the label is required and
// becomes both the accessible name and the hover tooltip, so no icon button
// ships unnamed; the icon comes from FULI's own set.
withDefaults(defineProps<{
  icon: IconName
  label: string
  shape?: 'round' | 'square'
  size?: 'sm' | 'md'
  active?: boolean
  disabled?: boolean
}>(), { shape: 'round', size: 'md', active: false, disabled: false })
</script>

<template>
  <Button variant="ghost" :size="size === 'sm' ? 'icon-sm' : 'icon'"
    :class="[shape === 'round' ? 'rounded-full' : '',
             'transition-[color,background-color,border-color,scale] active:not-disabled:scale-94',
             'aria-pressed:bg-primary-soft aria-pressed:text-primary']"
    :aria-label="label" :title="label" :aria-pressed="active || undefined" :disabled="disabled">
    <UiIcon :name="icon" :size="size === 'sm' ? 16 : 18" />
  </Button>
</template>
