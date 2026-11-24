<script setup lang="ts">
import { computed, toRef } from 'vue'
import { RouterLink } from 'vue-router'
import { Button } from '@/components/ui/button'
import { t } from '@/i18n'
import { useAgentGrowth, waitingCount } from './agent-growth'
import type { Waiting } from './fla-now'
import { kitPending, useFlaKit } from './kit-read'

// 等你处理, under 现在 (docs/fla-page.md): what waits on the person that the
// page would otherwise keep further down: other tasks for their call, starter
// kit picks still owed, experiences to keep or drop. One short line each,
// each going where it is answered; nothing waiting, no group at all.
const props = defineProps<{ spaceId: string; agentId: string; others: Waiting | null }>()
const emit = defineEmits<{ reveal: [sectionId: string] }>()

const { kit } = useFlaKit(toRef(props, 'spaceId'), toRef(props, 'agentId'))
const { growth } = useAgentGrowth(toRef(props, 'spaceId'), toRef(props, 'agentId'))

const taskText = computed(() => {
  const others = props.others
  if (!others) return ''
  if (others.review && others.blocked) return t('flaPage.attention.both', { review: others.review, blocked: others.blocked })
  return others.review ? t('flaPage.attention.review', { count: others.review }) : t('flaPage.attention.blocked', { count: others.blocked })
})
const kitText = computed(() => {
  const pending = kitPending(kit.value)
  if (!pending) return ''
  return pending.count ? t('flaPage.attention.kit', { count: pending.count }) : t('flaPage.attention.kitOutdated')
})
const growthCount = computed(() => waitingCount(growth.value?.items ?? []))
</script>

<template>
  <ul v-if="taskText || kitText || growthCount" class="attention" :aria-label="t('flaPage.attention.label')" data-fla-attention>
    <li v-if="taskText && others?.taskId">
      <RouterLink class="attention-item" :to="{ query: { task: others.taskId } }" data-attention="tasks">{{ taskText }}</RouterLink>
    </li>
    <li v-if="kitText">
      <Button variant="link" class="attention-item" data-attention="kit" @click="emit('reveal', 'fla-kit')">{{ kitText }}</Button>
    </li>
    <li v-if="growthCount">
      <Button variant="link" class="attention-item" data-attention="growth" @click="emit('reveal', 'fla-growth')">
        {{ t('flaPage.attention.growth', { count: growthCount }) }}</Button>
    </li>
  </ul>
</template>

<style scoped>
/* Short lines, not a card: each a warning dot and words that go where it is answered. */
.attention { display: flex; flex-wrap: wrap; gap: 4px 20px; margin: 0; padding: 0; list-style: none; }
/* The two that open a section below are design-system Buttons drawn as these same lines. */
.attention-item {
  display: inline-flex; align-items: center; justify-content: flex-start; gap: 8px; min-height: 24px; padding: 0; border: 0;
  border-radius: 0; color: var(--color-ink-soft); background: none; font: inherit; font-size: var(--text-control); letter-spacing: normal;
  text-align: left; text-decoration: none; white-space: normal; cursor: pointer; user-select: none;
}
.attention-item::before { content: ''; flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--color-warning); }
.attention-item:hover { color: var(--color-ink); text-decoration: underline; text-underline-offset: 3px; }
.attention-item:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; border-radius: 4px; }
</style>
