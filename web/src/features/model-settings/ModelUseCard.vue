<script setup lang="ts">
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { t } from '@/i18n'

// One use on the model center (11-06): its name and state, the model it
// runs on, the one line of what is enough, and its quick action on the right.
// A use that waits for the person, or is being edited, lifts as a card. The
// wide card (语义搜索) puts its actions beside the text on a wide grid.
defineProps<{
  name: string
  state: string
  tone: 'success' | 'warning' | 'secondary'
  advice: string
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
      <p class="model-use-advice" :title="advice" data-model-use-advice>
        <span class="model-use-label">{{ t('modelSettings.uses.advicePrefix') }}</span>{{ advice }}
      </p>
      <slot />
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
/* The model is one line (the full text in a title); the advice keeps two lines' room, so it is never cut on a laptop and cards keep one rhythm. */
.model-use-model, .model-use-advice { min-width: 0; margin: 0; font-size: var(--text-control); line-height: 20px; }
.model-use-model { overflow: hidden; color: var(--color-muted); text-overflow: ellipsis; white-space: nowrap; }
.model-use-model :deep(code) { margin-inline-end: 8px; color: var(--color-ink); font-family: var(--font-mono); font-size: var(--text-control); }
.model-use-advice { display: -webkit-box; min-height: 40px; overflow: hidden; color: var(--color-ink-soft); -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.model-use-label { margin-inline-end: 8px; color: var(--color-muted); font-size: var(--text-meta); }
/* The quick action sits at the card's foot, on the right, at the same place in every card of a row. */
.model-use-actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: var(--space-2); margin-top: auto; min-width: 0; }
.model-use-actions :deep(button) { user-select: none; }
@container (min-width: 680px) {
  .model-use--wide { flex-direction: row; align-items: center; gap: var(--space-6); }
  .model-use--wide .model-use-main { flex: 1; }
  .model-use--wide .model-use-actions { margin-top: 0; }
  .model-use--wide .model-use-advice { min-height: 0; }
}
</style>
