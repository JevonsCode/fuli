<script setup lang="ts">
import { computed } from 'vue'
import { useWidgetLayout } from './layout'
import { WIDGETS, type SlotId } from './registry'

// A place on a page or in the shell that shows whatever the layout puts there.
// Context the place knows (an FLA's id on its page) passes through as props.
const props = defineProps<{ place: SlotId; context?: Record<string, unknown> }>()
const { widgetsIn } = useWidgetLayout()
const widgets = computed(() => widgetsIn(props.place).map(id => ({ id, component: WIDGETS[id].component })))
</script>

<template>
  <component :is="widget.component" v-for="widget in widgets" :key="widget.id" v-bind="context" :data-slot-place="place" />
</template>
