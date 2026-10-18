<script setup lang="ts">
import { computed } from 'vue'
import { ICONS, type IconName } from './icons'

// Decorative by default; give a label only when the icon alone carries meaning.
const props = withDefaults(defineProps<{ name: IconName; size?: number; label?: string }>(), { size: 18, label: '' })
const markup = computed(() => ICONS[props.name])
</script>

<template>
  <svg class="ui-icon" :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"
    :role="label ? 'img' : undefined" :aria-label="label || undefined" :aria-hidden="label ? undefined : 'true'"
    v-html="markup" />
</template>

<style scoped>
.ui-icon { display: block; flex: 0 0 auto; }
</style>
