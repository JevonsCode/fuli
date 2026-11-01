<script setup lang="ts">
import { computed } from 'vue'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { t } from '@/i18n'
import { motionReduced } from '@/lib/motion-preference'
import UiChip from '@/ui/UiChip.vue'
import type { HowtoCase } from './howto-content'

// One real case as a short timeline: who did what in which client, and what
// FULI connected at that step. The dots light up in turn while motion is allowed.
const props = defineProps<{ story: HowtoCase }>()
const animated = computed(() => !motionReduced())
</script>

<template>
  <Card as="article" class="howto-case" :data-howto-case="props.story.id" :aria-labelledby="`howto-case-${props.story.id}`">
    <CardHeader>
      <CardTitle :id="`howto-case-${props.story.id}`">{{ props.story.title }}</CardTitle>
      <CardDescription class="howto-case-summary">{{ props.story.summary }}</CardDescription>
    </CardHeader>
    <ol class="howto-timeline" :class="{ 'is-animated': animated }" :style="{ '--steps': props.story.steps.length }">
      <li v-for="(step, index) in props.story.steps" :key="index" class="howto-step" :style="{ '--i': index }" data-howto-step>
        <span class="howto-step-dot" aria-hidden="true" />
        <div class="howto-step-body">
          <p class="howto-step-who">
            <span class="howto-step-actor">{{ step.actor }}</span>
            <UiChip v-if="step.client">{{ step.client }}</UiChip>
          </p>
          <p class="howto-step-did">{{ step.did }}</p>
          <p v-if="step.fuli" class="howto-step-fuli"><span>{{ t('howto.fuli') }}</span>{{ step.fuli }}</p>
        </div>
      </li>
    </ol>
  </Card>
</template>

<style scoped>
.howto-case-summary { color: var(--color-muted); font-size: var(--text-body); line-height: 1.6; }
.howto-timeline { display: grid; margin: 0; padding: 0 20px; list-style: none; }
.howto-step { position: relative; display: grid; grid-template-columns: 12px minmax(0, 1fr); gap: 12px; padding-bottom: 14px; }
.howto-step:last-child { padding-bottom: 0; }
/* The thread that joins one step to the next. */
.howto-step:not(:last-child)::before {
  content: ''; position: absolute; top: 16px; bottom: 0; left: 5px; width: 2px; border-radius: 1px; background: var(--color-border);
}
.howto-step-dot {
  width: 12px; height: 12px; margin-top: 4px; box-sizing: border-box; border-radius: 50%;
  border: 2px solid var(--color-gold); background: var(--color-surface);
}
.howto-step-body { display: grid; gap: 3px; min-width: 0; }
.howto-step-who { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.howto-step-actor { color: var(--color-ink); font-size: var(--text-body); font-weight: var(--weight-medium); }
.howto-step-did { color: var(--color-ink-soft); font-size: var(--text-body); line-height: 1.6; }
.howto-step-fuli { color: var(--color-muted); font-size: var(--text-meta); line-height: 1.6; }
.howto-step-fuli > span { margin-right: 6px; color: var(--color-gold); font-weight: var(--weight-strong); letter-spacing: .04em; }

.is-animated .howto-step-dot {
  animation: howto-step-light calc(var(--motion-pulse) * 3) var(--motion-ease) infinite;
  animation-delay: calc(var(--i) * var(--motion-pulse) * 3 / var(--steps));
}
@keyframes howto-step-light {
  0%, 12% { background: var(--color-gold); }
  24%, 100% { background: var(--color-surface); }
}
</style>
