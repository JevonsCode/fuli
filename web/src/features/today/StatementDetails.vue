<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { currentLocale, t } from '@/i18n'
import { formatDateTime } from '@/lib/date-time'
import UiDialog from '@/ui/UiDialog.vue'
import UiSegmented from '@/ui/UiSegmented.vue'
import { readStatement, statementDetails, statementWeek, type Statement } from './statement'

// 查看详情 of the statement: every number it has, each with one line on what it
// counts and whether FULI saw it happen or an assistant reported it, for this
// week or the one before (each switch reads that week again).
const props = defineProps<{ open: boolean; statement: Statement }>()
defineEmits<{ close: [] }>()
type Week = 'current' | 'previous'
const week = ref<Week>('current')
const shown = ref<Statement | null>(props.statement)
const loading = ref(false)
let reading = 0
const weekOptions = computed(() => (['previous', 'current'] as const).map(value => ({ value, label: t(`today.statement.week.${value}`) })))
const range = computed(() => {
  const { from, to } = statementWeek(new Date(), week.value === 'previous' ? 1 : 0)
  const last = new Date(Date.parse(to) - 1).toISOString()
  const day = (value: string) => formatDateTime(value, currentLocale(), { month: 'short', day: 'numeric' }, { missing: '', invalid: '' })
  return t('today.statement.week.range', { from: day(from), to: day(last) })
})
const rows = computed(() => shown.value ? statementDetails(shown.value) : [])

async function choose(next: Week) {
  week.value = next
  const current = ++reading
  loading.value = true
  const value = await readStatement(statementWeek(new Date(), next === 'previous' ? 1 : 0))
  if (current !== reading) return
  shown.value = value
  loading.value = false
}
// Opening again starts on this week, from what the page already read.
watch(() => props.open, open => { if (open) { reading++; week.value = 'current'; shown.value = props.statement; loading.value = false } })
</script>

<template>
  <UiDialog :open="open" :title="t('today.sections.statement')" :description="range" size="md" @close="$emit('close')">
    <div class="statement-details" data-statement-details>
      <UiSegmented :model-value="week" :options="weekOptions" :label="t('today.statement.week.label')" size="sm" @update:model-value="choose" />
      <GrowthLoading v-if="loading" variant="compact" :label="t(week === 'previous' ? 'today.loading.previousStatement' : 'today.loading.statement')" />
      <p v-else-if="!rows.length" class="statement-details-none">{{ t(`today.statement.unavailable.${week}`) }}</p>
      <dl v-else class="statement-details-list">
        <div v-for="row in rows" :key="row.key" class="statement-details-row" :data-statement-detail="row.key">
          <dt>{{ row.label }}</dt>
          <dd class="statement-details-value">{{ row.value }}</dd>
          <dd class="statement-details-what">{{ row.what }} · {{ row.source }}</dd>
        </div>
      </dl>
    </div>
  </UiDialog>
</template>

<style scoped>
.statement-details { display: grid; gap: 12px; }
.statement-details-none { margin: 0; color: var(--color-muted); font-size: var(--text-body); }
.statement-details-list { margin: 0; }
.statement-details-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; column-gap: 12px; padding: 8px 0; }
.statement-details-row + .statement-details-row { border-top: 1px solid var(--color-border); }
.statement-details-row dt { font-size: var(--text-body); font-weight: var(--weight-medium); }
.statement-details-row dd { margin: 0; }
.statement-details-value { font-size: var(--text-body); font-weight: var(--weight-medium); font-variant-numeric: tabular-nums; }
.statement-details-what { grid-column: 1 / -1; color: var(--color-muted); font-size: var(--text-meta); }
</style>
