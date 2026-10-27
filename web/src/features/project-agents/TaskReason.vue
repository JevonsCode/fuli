<script setup lang="ts">
import { computed } from 'vue'
import { t } from '@/i18n'
import { taskReason } from './task-reason'

// A task's recorded reason in the reader's language: the sentence first, an
// unknown code as small meta, and the stored text only under 原始信息.
const props = defineProps<{
  reason: string | null | undefined
  /** What to say when nothing was recorded. */
  fallback: string
  /** Two lines at most, for cards and boards. */
  clamp?: boolean
}>()

const view = computed(() => taskReason(props.reason))
</script>

<template>
  <div class="task-reason" data-task-reason>
    <p class="task-reason-text" :class="{ 'is-clamped': clamp }" :title="clamp ? (view?.text ?? fallback) : undefined" data-task-reason-text>
      {{ view?.text ?? fallback }}
    </p>
    <div v-if="view?.unknownCode || view?.raw" class="task-reason-meta">
      <small v-if="view.unknownCode" data-task-reason-code>{{ t('taskReason.code', { code: view.unknownCode }) }}</small>
      <details v-if="view.raw" class="task-reason-raw" data-task-reason-raw @click.stop>
        <summary data-term="work.rawReason">{{ t('taskReason.raw') }}</summary>
        <code>{{ view.raw }}</code>
      </details>
    </div>
  </div>
</template>

<style scoped>
.task-reason { display: grid; gap: 2px; min-width: 0; }
.task-reason p { margin: 0; }
.task-reason-text { overflow-wrap: anywhere; }
.task-reason-text.is-clamped { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.task-reason-meta { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 10px; color: var(--color-muted); font-size: 12px; font-weight: 400; }
.task-reason-raw summary { cursor: pointer; }
.task-reason-raw code { display: block; margin-top: 2px; font-family: var(--font-mono); font-size: 11px; white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
