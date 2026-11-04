<script setup lang="ts">
import { computed } from 'vue'
import { t } from '@/i18n'
import { performanceSummary } from './bole-performance'
import type { ScoreCardRead } from './useBoleScoreCards'

// One person's performance on their card. Scored dimensions stay separate and
// keep their evidence count; there is no total, and too little data says so.
const props = defineProps<{ read: ScoreCardRead | undefined }>()
const summary = computed(() => props.read?.status === 'ready' ? performanceSummary(props.read.card) : null)
</script>

<template>
  <div class="bole-performance" data-bole-performance>
    <!-- The team read has one indicator; a card only keeps its line. -->
    <span v-if="!read" class="is-muted" aria-hidden="true">—</span>
    <span v-else-if="!summary" class="is-muted">{{ t('employees.bole.performance.unavailable') }}</span>
    <span v-else-if="!summary.scored.length" class="is-muted">{{ t('employees.bole.performance.insufficient') }}</span>
    <template v-else>
      <span v-for="item in summary.scored" :key="item.key" :data-dimension="item.key">{{ t('employees.bole.performance.chip', { label: item.label, tier: item.tier, sample: item.sample }) }}</span>
      <span v-if="summary.insufficient" class="is-muted">{{ t('employees.bole.performance.insufficientCount', { count: summary.insufficient }) }}</span>
    </template>
  </div>
</template>

<style scoped>
.bole-performance { display: flex; flex-wrap: wrap; gap: 2px 12px; min-height: 20px; font-size: 12px; line-height: 20px; font-variant-numeric: tabular-nums; }
.is-muted { color: var(--color-muted); }
</style>
