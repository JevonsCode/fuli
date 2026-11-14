<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { currentLocale, t } from '@/i18n'
import { formatDateTime } from '@/lib/date-time'
import UiDialog from '@/ui/UiDialog.vue'
import UiSegmented from '@/ui/UiSegmented.vue'
import StatementRows from './StatementRows.vue'
import StatementUsage from './StatementUsage.vue'
import { readStatement, statementDetails, statementWeek, type Statement } from './statement'
import { readStatementUsage, type StatementUsage as Usage } from './statement-usage'

// 查看详情 of the statement: every number it has, each with one line on what it
// counts and whether FULI saw it happen or an assistant reported it, for this
// week or the one before, then which clients and models did the work. Each
// switch reads that week again; the numbers shown stay where they are until
// the answer arrives, so the dialog never empties, changes height or flashes
// (Jevons 11-13). The reading mark has its own reserved place beside the switch.
const props = defineProps<{ open: boolean; statement: Statement }>()
defineEmits<{ close: [] }>()
type Week = 'current' | 'previous'
const week = ref<Week>('current')
const shown = ref<Statement | null>(props.statement)
const usage = ref<Usage | null>(null)
// What is being read now: the week's statement with its usage, or only the usage of the week already shown.
const reading = ref<'statement' | 'usage' | null>(null)
let readId = 0
const weekOptions = computed(() => (['previous', 'current'] as const).map(value => ({ value, label: t(`today.statement.week.${value}`) })))
const range = computed(() => {
  const { from, to } = statementWeek(new Date(), week.value === 'previous' ? 1 : 0)
  const last = new Date(Date.parse(to) - 1).toISOString()
  const day = (value: string) => formatDateTime(value, currentLocale(), { month: 'short', day: 'numeric' }, { missing: '', invalid: '' })
  return t('today.statement.week.range', { from: day(from), to: day(last) })
})
const rows = computed(() => shown.value ? statementDetails(shown.value) : [])
const readingLabel = computed(() => reading.value === 'usage' ? t('today.loading.usage')
  : t(week.value === 'previous' ? 'today.loading.previousStatement' : 'today.loading.statement'))

async function choose(next: Week) {
  week.value = next
  const current = ++readId
  reading.value = 'statement'
  const bounds = statementWeek(new Date(), next === 'previous' ? 1 : 0)
  const [value, used] = await Promise.all([readStatement(bounds), readStatementUsage(bounds)])
  if (current !== readId) return
  shown.value = value
  usage.value = used
  reading.value = null
}
// Opening again starts on this week, from what the page already read; only its usage is read.
watch(() => props.open, async (open) => {
  if (!open) return
  const current = ++readId
  week.value = 'current'
  shown.value = props.statement
  reading.value = 'usage'
  const used = await readStatementUsage(statementWeek(new Date()))
  if (current !== readId) return
  usage.value = used
  reading.value = null
}, { immediate: true })
</script>

<template>
  <UiDialog :open="open" :title="t('today.sections.statement')" :description="range" size="md" @close="$emit('close')">
    <div class="statement-details" data-statement-details>
      <div class="statement-details-head">
        <UiSegmented :model-value="week" :options="weekOptions" :label="t('today.statement.week.label')" size="sm" @update:model-value="choose" />
        <span class="statement-details-reading">
          <GrowthLoading v-if="reading" variant="inline" :label="readingLabel" />
        </span>
      </div>
      <p v-if="!rows.length && reading !== 'statement'" class="statement-details-none">{{ t(`today.statement.unavailable.${week}`) }}</p>
      <StatementRows v-else-if="shown && rows.length" :statement="shown" :busy="reading === 'statement'" />
      <StatementUsage :usage="usage" :busy="reading !== null" />
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
