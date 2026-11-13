<script setup lang="ts">
import { computed, ref } from 'vue'
import { Button } from '@/components/ui/button'
import { t } from '@/i18n'
import StatementDetails from './StatementDetails.vue'
import { sparklinePoints, statementSeries, type Statement, type StatementTile } from './statement'
import TodaySection from './TodaySection.vue'

// 这周的复利账单: the running total with its trend, up to four numbers of this
// week, and 查看详情 with every number and who saw it happen. No tile is a
// link: no page lists these records yet.
const props = defineProps<{ statement: Statement; total: number | null; tiles: StatementTile[] }>()
const SPARK = { width: 96, height: 28 }
const series = computed(() => statementSeries(props.statement))
const points = computed(() => sparklinePoints(series.value, SPARK.width, SPARK.height))
const trendLabel = computed(() => t('today.statement.trend', { weeks: series.value.length, first: series.value[0] ?? 0, last: series.value.at(-1) ?? 0 }))
const detailsOpen = ref(false)
</script>

<template>
  <TodaySection :title="t('today.sections.statement')" data-today-section="statement">
    <template #action>
      <Button variant="ghost" size="sm" data-today-action="statement" @click="detailsOpen = true">{{ t('today.actions.details') }}</Button>
    </template>
    <div v-if="total !== null" class="statement-headline">
      <p class="statement-total" data-statement-total>{{ t('today.statement.headline', { count: total }) }}</p>
      <svg v-if="points" class="statement-spark" :viewBox="`0 0 ${SPARK.width} ${SPARK.height}`" :width="SPARK.width" :height="SPARK.height"
        role="img" :aria-label="trendLabel" data-statement-spark>
        <polyline :points="points" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </div>
    <ul v-if="tiles.length" class="statement-tiles">
      <li v-for="tile in tiles" :key="tile.key" class="statement-tile" :data-statement-tile="tile.key">
        <strong class="statement-number">{{ tile.value }}</strong>
        <span class="statement-label">{{ tile.label }}</span>
        <span v-if="tile.sub" class="statement-sub">{{ tile.sub }}</span>
      </li>
    </ul>
    <StatementDetails :open="detailsOpen" :statement="statement" @close="detailsOpen = false" />
  </TodaySection>
</template>

<style scoped>
.statement-headline { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-height: 36px; }
.statement-total { margin: 0; font-size: var(--text-body); font-weight: var(--weight-medium); }
.statement-spark { flex: none; color: var(--color-accent); }
/* Four in a row, two by two on a narrow screen; never page columns. */
.statement-tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin: 8px 0 12px; padding: 0; list-style: none; }
.statement-tile { display: grid; align-content: start; gap: 2px; min-width: 0; padding: 12px 14px; border-radius: var(--radius-control); background: var(--color-surface-subtle); }
.statement-number { font-size: var(--text-title); font-weight: var(--weight-strong); font-variant-numeric: tabular-nums; line-height: var(--leading-title); }
.statement-label { font-size: var(--text-body); font-weight: var(--weight-medium); }
.statement-sub { color: var(--color-muted); font-size: var(--text-meta); }
@media (max-width: 720px) {
  .statement-tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
