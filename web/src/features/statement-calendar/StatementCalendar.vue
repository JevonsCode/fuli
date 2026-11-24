<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { t } from '@/i18n'
import UiSegmented from '@/ui/UiSegmented.vue'
import {
  addDays, calendarWeeks, cellLabel, intensityLevels, measureOf, monthLabels, weekdayHints,
  type Measure, type StatementDay,
} from './calendar'

// The last 53 weeks as a contribution calendar: weeks are columns, Monday on
// top, darker is more. It is an ARIA grid (rows are weekdays, columns weeks)
// with one tab stop; the arrow keys move a day (up, down) or a week (left,
// right), Enter or Space picks the day. On a narrow window it scrolls sideways
// inside its own box and starts at the newest week.
const props = defineProps<{
  days: ReadonlyMap<string, StatementDay>
  today: string
  measure: Measure
  measures: readonly Measure[]
  selectedDay: string | null
  selectedWeek: string
}>()
const emit = defineEmits<{ 'update:measure': [Measure]; select: [string] }>()

const weeks = computed(() => calendarWeeks(props.today))
const months = computed(() => monthLabels(weeks.value))
const weekdays = weekdayHints()
const first = computed(() => weeks.value[0].monday)
const level = computed(() => intensityLevels([...props.days.values()].map(entry => measureOf(entry, props.measure))))
const options = computed(() => props.measures.map(value => ({ value, label: t(`statementCalendar.measures.${value}.label`) })))

// Each weekday's row of cells with their level and name, worked out once per change.
const rows = computed(() => weekdays.map((weekday, index) => ({
  ...weekday,
  cells: weeks.value.map(({ monday, days }) => {
    const entry = days[index]
    if (!entry) return { key: `${monday}-${index}`, day: null, monday, level: 0, label: '' }
    const value = measureOf(props.days.get(entry.day), props.measure)
    return { key: entry.day, day: entry.day, monday, level: level.value(value), label: cellLabel(entry.day, props.measure, value) }
  }),
})))

const scroller = ref<HTMLElement | null>(null)
const grid = ref<HTMLElement | null>(null)
// The one cell in the tab order: the chosen day, else today.
const focusDay = ref(props.selectedDay ?? props.today)
watch(() => props.selectedDay, day => { if (day) focusDay.value = day })

function pick(day: string) {
  focusDay.value = day
  emit('select', day)
}

const MOVES: Record<string, number> = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -7, ArrowRight: 7 }
async function onKey(event: KeyboardEvent) {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    pick(focusDay.value)
    return
  }
  const step = MOVES[event.key]
  if (!step) return
  event.preventDefault()
  const next = addDays(focusDay.value, step)
  if (next < first.value || next > props.today) return
  focusDay.value = next
  await nextTick()
  grid.value?.querySelector<HTMLElement>(`[data-day="${next}"]`)?.focus()
}

onMounted(() => { if (scroller.value) scroller.value.scrollLeft = scroller.value.scrollWidth })
</script>

<template>
  <div class="statement-calendar" data-statement-calendar>
    <UiSegmented v-if="options.length > 1" :model-value="measure" :options="options" :label="t('statementCalendar.measure')" size="sm"
      data-calendar-measure @update:model-value="emit('update:measure', $event)" />
    <div ref="scroller" class="calendar-scroll" data-calendar-scroll>
      <div class="calendar-frame" :style="{ '--calendar-weeks': weeks.length }">
        <div class="calendar-months" aria-hidden="true">
          <span v-for="month in months" :key="month.week" class="calendar-month" :style="{ gridColumn: `${month.week + 1} / span 4` }"
            data-calendar-month>{{ month.label }}</span>
        </div>
        <div ref="grid" class="calendar-grid" role="grid" :aria-label="t('statementCalendar.calendar')" data-calendar-grid @keydown="onKey">
          <div v-for="row in rows" :key="row.name" class="calendar-row" role="row">
            <span class="calendar-hint" role="rowheader" :aria-label="row.name">{{ row.hint }}</span>
            <template v-for="cell in row.cells" :key="cell.key">
              <span v-if="cell.day" class="calendar-cell" role="gridcell" :data-day="cell.day" :data-level="cell.level"
                :class="{ 'is-week': cell.monday === selectedWeek, 'is-day': cell.day === selectedDay }"
                :aria-label="cell.label" :title="cell.label" :aria-selected="cell.day === selectedDay"
                :tabindex="cell.day === focusDay ? 0 : -1" @click="pick(cell.day)" />
              <span v-else class="calendar-hole" aria-hidden="true" />
            </template>
          </div>
        </div>
      </div>
    </div>
    <p class="calendar-legend" :aria-label="t('statementCalendar.legend.label')">
      <span aria-hidden="true">{{ t('statementCalendar.legend.less') }}</span>
      <span v-for="step in 5" :key="step" class="calendar-cell is-swatch" :data-level="step - 1" aria-hidden="true" />
      <span aria-hidden="true">{{ t('statementCalendar.legend.more') }}</span>
    </p>
  </div>
</template>

<style scoped>
.statement-calendar { --cell: 12px; --cell-gap: 3px; --hint: 28px; display: grid; gap: 12px; min-width: 0; }
/* Only this box scrolls sideways; the page never does. */
.calendar-scroll { min-width: 0; overflow-x: auto; overscroll-behavior-x: contain; padding: 3px 3px 3px 0; }
.calendar-frame { display: grid; gap: 4px; width: max-content; }
.calendar-months {
  display: grid; grid-template-columns: repeat(var(--calendar-weeks), var(--cell)); column-gap: var(--cell-gap);
  height: 16px; margin-inline-start: calc(var(--hint) + var(--cell-gap));
  color: var(--color-muted); font-size: var(--text-meta); line-height: 16px;
}
.calendar-month { white-space: nowrap; }
.calendar-grid { display: grid; row-gap: var(--cell-gap); }
.calendar-row { display: grid; grid-template-columns: var(--hint) repeat(var(--calendar-weeks), var(--cell)); column-gap: var(--cell-gap); height: var(--cell); }
.calendar-hint { color: var(--color-muted); font-size: 10px; line-height: var(--cell); white-space: nowrap; user-select: none; }
.calendar-cell {
  display: block; width: var(--cell); height: var(--cell); border-radius: 3px; background: var(--color-surface-subtle);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-ink) 6%, transparent); cursor: pointer; user-select: none;
}
/* Five steps of the one accent colour. */
.calendar-cell[data-level='1'] { background: color-mix(in srgb, var(--color-accent) 22%, transparent); }
.calendar-cell[data-level='2'] { background: color-mix(in srgb, var(--color-accent) 44%, transparent); }
.calendar-cell[data-level='3'] { background: color-mix(in srgb, var(--color-accent) 68%, transparent); }
.calendar-cell[data-level='4'] { background: var(--color-accent); }
.calendar-cell.is-week { box-shadow: inset 0 0 0 1px var(--color-control-border); }
.calendar-cell.is-day, .calendar-cell:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 1px; }
.calendar-legend { display: flex; align-items: center; justify-content: flex-end; gap: 3px; margin: 0; color: var(--color-muted); font-size: var(--text-meta); user-select: none; }
.calendar-legend > span:first-child { margin-inline-end: 4px; }
.calendar-legend > span:last-child { margin-inline-start: 4px; }
.calendar-cell.is-swatch { cursor: default; }
</style>
