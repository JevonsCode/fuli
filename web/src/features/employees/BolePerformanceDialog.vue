<script setup lang="ts">
import { computed } from 'vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import GrowthLoading from '@/components/GrowthLoading.vue'
import UiDialog from '@/ui/UiDialog.vue'
import { currentLocale, t } from '@/i18n'
import { formatDateTime } from '@/lib/date-time'
import { dimensionRows, toolFlagLines } from './bole-performance'
import type { ScoreCardRead } from './useBoleScoreCards'

const props = defineProps<{ name: string; read: ScoreCardRead | undefined }>()
const emit = defineEmits<{ close: []; retry: [] }>()

const card = computed(() => props.read?.status === 'ready' ? props.read.card : null)
const rows = computed(() => card.value ? dimensionRows(card.value) : [])
const flags = computed(() => card.value ? toolFlagLines(card.value) : [])
const asOf = computed(() => formatDateTime(card.value?.asOf, currentLocale(), { dateStyle: 'medium', timeStyle: 'short' }, {
  missing: t('employees.bole.unknownTime'),
}))
</script>

<template>
  <UiDialog open :title="t('employees.bole.performance.title', { name })" @close="emit('close')">
    <GrowthLoading v-if="!read" variant="compact" :label="t('employees.bole.performance.reading', { name })" />
    <div v-else-if="!card" class="ui-empty text-destructive" role="alert">
      <p class="m-0">{{ t('employees.bole.performance.readFailed') }}</p>
      <Button class="mt-3" size="sm" variant="outline" @click="emit('retry')">{{ t('employees.retry') }}</Button>
    </div>
    <template v-else>
      <ul class="bole-dimensions">
        <li v-for="row in rows" :key="row.key" :data-dimension="row.key">
          <strong>{{ row.label }}</strong>
          <template v-if="row.scored">
            <Badge variant="outline">{{ row.tier }}</Badge>
            <span>{{ row.rate }}</span>
            <small>{{ t('employees.bole.performance.passed', { passed: row.passed, sample: row.sample }) }}</small>
          </template>
          <small v-else>{{ t('employees.bole.performance.insufficientDetail', { sample: row.sample, minimum: card.minimumSample }) }}</small>
        </li>
      </ul>
      <ul v-if="flags.length" class="bole-performance-notes">
        <li v-for="flag in flags" :key="flag">{{ flag }}</li>
      </ul>
      <p class="bole-performance-meta">
        <span v-if="card.disputedReviewCount">{{ t('employees.bole.performance.disputed', { count: card.disputedReviewCount }) }}</span>
        <span v-if="card.staleReviewCount">{{ t('employees.bole.performance.stale', { count: card.staleReviewCount }) }}</span>
        <time :datetime="card.asOf">{{ t('employees.bole.performance.asOf', { time: asOf }) }}</time>
      </p>
    </template>
  </UiDialog>
</template>

<style scoped>
.bole-dimensions, .bole-performance-notes { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.bole-dimensions li { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; min-height: 40px; padding: 8px 12px; border-radius: var(--radius-control); background: var(--color-surface-subtle); }
.bole-dimensions strong { flex: 1 1 96px; font-size: 14px; font-weight: 500; }
.bole-dimensions span:not([data-slot]) { font-size: 14px; font-variant-numeric: tabular-nums; }
.bole-dimensions small, .bole-performance-meta { color: var(--color-muted); font-size: 12px; }
.bole-performance-notes { margin-top: 12px; font-size: 13px; line-height: 1.6; overflow-wrap: anywhere; }
.bole-performance-meta { display: flex; flex-wrap: wrap; gap: 4px 12px; margin: 12px 0 0; }
</style>
