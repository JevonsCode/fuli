<script setup lang="ts">
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'

// One use on the model center (11-06, compact since 11-11): its name and
// state, the model it runs on, one line of how it stands now, and its quick
// action on the right. A card never grows with its data: lists, progress and
// results open in 「查看详情」. A use that waits for the person, or is being
// edited, lifts as a card. The wide card (语义搜索) puts its actions beside
// the text on a wide grid.
defineProps<{
  name: string
  state: string
  tone: 'success' | 'warning' | 'secondary' | 'destructive'
  lifted?: boolean
  wide?: boolean
}>()
</script>

<template>
  <Card as="article" class="model-use" :class="{ 'model-use--lifted shadow-md': lifted, 'model-use--wide': wide }">
    <div class="model-use-main">
      <header class="model-use-head">
        <h3 class="model-use-name">{{ name }}</h3>
        <Badge :variant="tone" :title="state" data-model-use-state>{{ state }}</Badge>
      </header>
      <p class="model-use-model" data-model-use-model><slot name="model" /></p>
      <div class="model-use-note" data-model-use-note><slot /></div>
    </div>
    <footer class="model-use-actions"><slot name="actions" /></footer>
  </Card>
</template>

<style scoped>
.model-use {
  position: relative; gap: var(--space-3); padding: var(--space-4) var(--space-5);
  transition: box-shadow var(--motion-fast), border-color var(--motion-fast);
}
.model-use--lifted { z-index: 1; border-color: var(--color-border-strong); }
.model-use-main { display: grid; align-content: start; gap: 6px; min-width: 0; }
.model-use-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); min-width: 0; min-height: 24px; }
.model-use-name { min-width: 0; margin: 0; overflow: hidden; color: var(--color-ink); font-size: var(--text-body); font-weight: var(--weight-medium); text-overflow: ellipsis; white-space: nowrap; }
/* One fixed line, so a model name in the mono font does not push the line below it. */
.model-use-model { min-width: 0; height: 20px; margin: 0; overflow: hidden; color: var(--color-muted); font-size: var(--text-control); line-height: 20px; text-overflow: ellipsis; white-space: nowrap; }
.model-use-model :deep(code) { margin-inline-end: 8px; color: var(--color-ink); font-family: var(--font-mono); font-size: var(--text-control); }
/* How the use stands now: two lines' room, always, so every card of a row is one height and the actions stay level. */
.model-use-note { display: grid; align-content: start; min-width: 0; height: 40px; overflow: hidden; color: var(--color-ink-soft); font-size: var(--text-control); line-height: 20px; }
/* A sentence may take both lines; a longer one keeps its full text in a title. */
.model-use-note :deep(p) { margin: 0; }
.model-use-note :deep(p:not(.model-failure)) { display: -webkit-box; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; }
/* The quick action sits at the card's foot, on the right, at the same place in every card of a row. */
.model-use-actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: var(--space-2); margin-top: auto; min-width: 0; }
.model-use-actions :deep(button) { user-select: none; }
@container (min-width: 680px) {
  .model-use--wide { flex-direction: row; align-items: center; gap: var(--space-6); }
  .model-use--wide .model-use-main { flex: 1; }
  .model-use--wide .model-use-actions { margin-top: 0; }
  .model-use--wide .model-use-note { height: 20px; }
  .model-use--wide .model-use-note :deep(p:not(.model-failure)) { -webkit-line-clamp: 1; line-clamp: 1; }
}
</style>
