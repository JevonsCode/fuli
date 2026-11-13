<script setup lang="ts">
import { computed, ref } from 'vue'
import { Button } from '@/components/ui/button'
import { t } from '@/i18n'
import StatementDetails from './StatementDetails.vue'
import { sparklinePoints, statementSeries, type Statement, type StatementTile } from './statement'
import TodaySection from './TodaySection.vue'

// 这周的复利账单, the fixed left half of 今天: the running total as the one
// number to look at, its trend over the last weeks, up to four numbers of this
// week, and 查看详情 with every number and who saw it happen. It never scrolls;
// the trend takes whatever height is left. No tile is a link: no page lists
// these records yet.
const props = defineProps<{ statement: Statement; total: number | null; tiles: StatementTile[] }>()
const SPARK = { width: 320, height: 96 }
const series = computed(() => statementSeries(props.statement))
const points = computed(() => sparklinePoints(series.value, SPARK.width, SPARK.height))
const trendLabel = computed(() => t('today.statement.trend', { weeks: series.value.length, first: series.value[0] ?? 0, last: series.value.at(-1) ?? 0 }))
const detailsOpen = ref(false)
</script>

<template>
  <TodaySection class="statement-stage" :title="t('today.sections.statement')" data-today-section="statement">
    <template #action>
      <Button variant="ghost" size="sm" data-today-action="statement" @click="detailsOpen = true">{{ t('today.actions.details') }}</Button>
    </template>
    <p v-if="total !== null" class="statement-total" :aria-label="t('today.statement.headline', { count: total })" data-statement-total>
      <strong class="statement-figure" aria-hidden="true">{{ total }}</strong>
      <span aria-hidden="true">{{ t('today.statement.totalCaption') }}</span>
    </p>
    <figure v-if="points" class="statement-trend">
      <svg class="statement-spark" :viewBox="`0 0 ${SPARK.width} ${SPARK.height}`" preserveAspectRatio="none"
        role="img" :aria-label="trendLabel" data-statement-spark>
        <polyline :points="points" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
          vector-effect="non-scaling-stroke" />
      </svg>
      <figcaption>{{ trendLabel }}</figcaption>
    </figure>
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
/* The card fills its half and never scrolls: the number on top, the tiles at the bottom, the trend takes the rest. */
.statement-stage { display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
.statement-stage :deep(.today-section-body) { display: flex; flex: 1; flex-direction: column; gap: 16px; min-height: 0; padding-block: 8px 12px; }
.statement-total { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; margin: 0; color: var(--color-muted); font-size: var(--text-body); }
.statement-figure { color: var(--color-ink); font-size: clamp(48px, 7vw, 88px); font-weight: var(--weight-strong); font-variant-numeric: tabular-nums; line-height: 1; }
.statement-trend { display: flex; flex: 1; flex-direction: column; gap: 6px; min-height: 48px; margin: 0; }
.statement-spark { flex: 1; width: 100%; min-height: 0; color: var(--color-accent); }
.statement-trend figcaption { color: var(--color-muted); font-size: var(--text-meta); }
/* Two by two in the half-width card. */
.statement-tiles { display: grid; flex: none; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin: 0; padding: 0; list-style: none; }
/* An odd last tile takes the whole row, so the grid never ends on a hole. */
.statement-tile:last-child:nth-child(odd) { grid-column: 1 / -1; }
.statement-tile { display: grid; align-content: start; gap: 2px; min-width: 0; padding: 12px 14px; border-radius: var(--radius-control); background: var(--color-surface-subtle); }
.statement-number { font-size: var(--text-title); font-weight: var(--weight-strong); font-variant-numeric: tabular-nums; line-height: var(--leading-title); }
.statement-label { font-size: var(--text-body); font-weight: var(--weight-medium); }
.statement-sub { color: var(--color-muted); font-size: var(--text-meta); }
</style>
