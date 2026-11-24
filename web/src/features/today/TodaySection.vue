<script setup lang="ts">
import { useId } from 'vue'
import { Card, CardAction, CardHeader, CardTitle } from '@/components/ui/card'
import '@/features/overview/workbench-card.css'

// One section of 今天: a plain card with its title on the left and at most one
// quiet action on the right (the `action` slot); its rows below.
defineProps<{ title: string }>()
const headingId = `today-${useId().replace(/[^A-Za-z0-9_-]/g, '')}`
</script>

<template>
  <Card as="section" class="today-section" :aria-labelledby="headingId">
    <CardHeader class="today-section-head">
      <CardTitle :id="headingId" as="h2">{{ title }}</CardTitle>
      <CardAction v-if="$slots.action"><slot name="action" /></CardAction>
    </CardHeader>
    <div class="today-section-body"><slot /></div>
  </Card>
</template>

<style scoped>
/* The card's title and its one action share a centre line at the action's height. */
.today-section { gap: 4px; padding-block: 14px 8px; }
.today-section-head { align-items: center; min-height: 32px; }
.today-section-head :deep([data-slot='card-action']) { align-self: center; }
.today-section-body { min-width: 0; padding-inline: 20px; }
</style>
