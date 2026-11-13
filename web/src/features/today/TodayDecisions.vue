<script setup lang="ts">
import { RouterLink } from 'vue-router'
import { Button } from '@/components/ui/button'
import AttentionRow from '@/features/overview/AttentionRow.vue'
import { overviewTime } from '@/features/overview/overview-data'
import { inboxLocation } from '@/features/project-agents/attention-store'
import { t } from '@/i18n'
import UiIcon from '@/ui/UiIcon.vue'
import type { DecisionRow } from './today-model'
import TodaySection from './TodaySection.vue'

// 等你拍板: the requests answer the way they do on 工作台 (AttentionRow); the
// habits waiting to be confirmed go to 待决策 and disagreeing preferences to 偏好,
// where each is decided today.
defineProps<{ rows: DecisionRow[]; more: number; agentName: (id?: string | null) => string }>()
const SUMMARY = {
  review: { icon: 'memory', to: '/inbox' },
  conflicts: { icon: 'warning', to: '/preferences' },
} as const
</script>

<template>
  <TodaySection :title="t('today.sections.decisions')" data-today-section="decisions">
    <template #action>
      <Button as-child variant="ghost" size="sm"><RouterLink :to="inboxLocation()" data-today-action="decisions">{{ t('today.actions.all') }}</RouterLink></Button>
    </template>
    <ul class="workbench-rows">
      <li v-for="row in rows" :key="row.kind === 'request' ? row.item.requestId : row.kind" :data-today-decision="row.kind">
        <AttentionRow v-if="row.kind === 'request'" :item="row.item" :name="agentName(row.item.agentId)" :time="overviewTime(row.item.createdAt)" />
        <div v-else class="workbench-row">
          <span class="today-mark" aria-hidden="true"><UiIcon :name="SUMMARY[row.kind].icon" :size="16" /></span>
          <p class="workbench-row-title today-summary">{{ t(`today.decisions.${row.kind}`, { count: row.count }) }}</p>
          <Button as-child variant="outline" size="sm"><RouterLink :to="SUMMARY[row.kind].to">{{ t('today.actions.look') }}</RouterLink></Button>
        </div>
      </li>
    </ul>
    <p v-if="more > 0" class="workbench-meta today-more" data-today-more>{{ t('today.decisions.more', { count: more }) }}</p>
  </TodaySection>
</template>

<style scoped>
.today-mark { display: grid; width: 34px; height: 34px; place-items: center; border-radius: 11px; color: var(--color-ink-soft); background: var(--color-surface-subtle); }
.today-summary { white-space: normal; }
.today-more { padding: 8px 0 6px; border-top: 1px solid var(--color-border); }
</style>
