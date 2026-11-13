<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { currentLocale, t } from '@/i18n'
import { formatDateTime } from '@/lib/date-time'
import UiDialog from '@/ui/UiDialog.vue'
import UiSegmented from '@/ui/UiSegmented.vue'
import StatementRows from './StatementRows.vue'
import { readStatement, statementDetails, statementWeek, type Statement } from './statement'

// 查看详情 of the statement: every number it has, each with one line on what it
// counts and whether FULI saw it happen or an assistant reported it, for this
// week or the one before. Each switch reads that week again; the numbers shown
// stay where they are until the answer arrives, so the dialog never empties,
// changes height or flashes (Jevons 11-13). The reading mark has its own
// reserved place beside the switch.
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
      <div class="statement-details-head">
        <UiSegmented :model-value="week" :options="weekOptions" :label="t('today.statement.week.label')" size="sm" @update:model-value="choose" />
        <span class="statement-details-reading">
          <GrowthLoading v-if="loading" variant="inline" :label="t(week === 'previous' ? 'today.loading.previousStatement' : 'today.loading.statement')" />
        </span>
      </div>
      <p v-if="!rows.length && !loading" class="statement-details-none">{{ t(`today.statement.unavailable.${week}`) }}</p>
      <StatementRows v-else-if="shown && rows.length" :statement="shown" :busy="loading" />
    </div>
  </UiDialog>
</template>

<style scoped>
.statement-details { display: grid; gap: 12px; }
/* The switch and the reading mark share one line; the mark's place is always there, so nothing moves when it shows. */
.statement-details-head { display: flex; align-items: center; gap: 12px; min-height: 32px; }
.statement-details-head > :first-child { flex: 1; min-width: 0; }
.statement-details-reading { display: inline-flex; flex: none; align-items: center; justify-content: flex-end; min-width: 20px; }
.statement-details-none { margin: 0; color: var(--color-muted); font-size: var(--text-body); }
</style>
