<script setup lang="ts">
import { shown, type AdvancedArea } from './advanced-areas'

// What belongs to an advanced area, rendered only once the area is shown.
defineProps<{ area: AdvancedArea }>()
</script>

<template>
  <slot v-if="shown(area)" />
</template>
