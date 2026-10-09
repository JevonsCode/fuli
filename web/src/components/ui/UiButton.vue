<script setup lang="ts">
import GrowthLoading from '../GrowthLoading.vue'

withDefaults(defineProps<{
  variant?: 'default' | 'primary' | 'ghost' | 'danger'
  size?: 'sm' | 'md'
  type?: 'button' | 'submit' | 'reset'
  busy?: boolean
  busyLabel?: string
  disabled?: boolean
  icon?: boolean
}>(), { variant: 'default', size: 'md', type: 'button', busy: false, busyLabel: '', disabled: false, icon: false })
</script>

<template>
  <button :type="type" class="ui-button"
    :class="[`ui-button--${variant}`, { 'ui-button--sm': size === 'sm', 'ui-button--icon': icon }]"
    :disabled="disabled || busy" :aria-busy="busy || undefined">
    <GrowthLoading v-if="busy" variant="inline" :label="busyLabel" />
    <slot v-else />
  </button>
</template>
