<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Breadcrumb from '@/components/Breadcrumb.vue'
import GrowthLoading from '@/components/GrowthLoading.vue'
import PageStack from '@/components/PageStack.vue'
import { Card, CardAction, CardHeader, CardTitle } from '@/components/ui/card'
import { readStatement, type Statement } from '@/features/today/statement'
import { t } from '@/i18n'
import { UiIconButton, UiNotice } from '@/ui'
import {
  addDays, CALENDAR_WEEKS, dayLabel, isDayKey, localToday, measureOf, MEASURES, mondayOf, readStatementDays, statementWeekOf,
  type Measure, type StatementDays,
} from './calendar'
import StatementCalendar from './StatementCalendar.vue'
import StatementWeekRows from './StatementWeekRows.vue'

// 复利账单, day by day: the last year as a calendar on top, and under it, in
// the same column, the statement of the week picked there (this week at
// first). The week is in the URL (?week=<its Monday>), so a link, a refresh
// or Back keeps it; the measure is in ?measure=. While another week is read,
// the last one's rows stay, dimmed, and the reading mark has its own place.
const route = useRoute()
const router = useRouter()
const today = localToday(new Date())
const thisMonday = mondayOf(today)
const firstMonday = addDays(thisMonday, -7 * (CALENDAR_WEEKS - 1))

const days = ref<{ state: 'loading' | 'ready' | 'failed'; value: StatementDays | null }>({ state: 'loading', value: null })
const byDay = computed(() => new Map((days.value.value?.days ?? []).map(entry => [entry.day, entry])))
const measures = computed(() => MEASURES.filter(measure => !(days.value.value?.unavailable ?? []).includes(measure)))
const empty = computed(() => days.value.state === 'ready'
  && ![...byDay.value.values()].some(entry => measures.value.some(measure => measureOf(entry, measure) > 0)))

const week = computed(() => {
  const asked = route.query.week
  return isDayKey(asked) && mondayOf(asked) === asked && asked >= firstMonday && asked <= thisMonday ? asked : thisMonday
})
const measure = computed<Measure>(() => {
  const asked = route.query.measure as Measure
  return measures.value.includes(asked) ? asked : measures.value[0] ?? 'learned'
})
const selectedDay = ref<string | null>(null)
watch(week, monday => { if (selectedDay.value && mondayOf(selectedDay.value) !== monday) selectedDay.value = null })

function goWeek(monday: string) {
  if (monday !== week.value) void router.push({ query: { ...route.query, week: monday } })
}
function select(day: string) {
  selectedDay.value = day
  goWeek(mondayOf(day))
}
function chooseMeasure(next: Measure) {
  void router.replace({ query: { ...route.query, measure: next } })
}

const range = (monday: string) => t('statementCalendar.week.range', { from: dayLabel(monday), to: dayLabel(addDays(monday, 6)) })
const daySummary = computed(() => {
  const day = selectedDay.value
  if (!day) return ''
  const entry = byDay.value.get(day)
  const parts = measures.value.filter(name => measureOf(entry, name) > 0)
    .map(name => t(`statementCalendar.measures.${name}.count`, { count: measureOf(entry, name) }))
  return parts.length ? t('statementCalendar.day.some', { date: dayLabel(day), text: parts.join(' · ') })
    : t('statementCalendar.day.none', { date: dayLabel(day) })
})

// The week's statement: the last one read stays on screen until the next arrives.
const shown = ref<{ week: string; statement: Statement | null } | null>(null)
const reading = ref<string | null>(null)
let controller: AbortController | null = null
async function readWeek(monday: string) {
  controller?.abort()
  const current = new AbortController()
  controller = current
  reading.value = monday
  const statement = await readStatement(statementWeekOf(monday), current.signal)
  if (current.signal.aborted) return
  shown.value = { week: monday, statement }
  reading.value = null
}
watch(week, monday => { void readWeek(monday) }, { immediate: true })
onBeforeUnmount(() => controller?.abort())

void readStatementDays(new Date()).then(value => { days.value = { state: value ? 'ready' : 'failed', value } })
</script>

<template>
  <section class="view statement-calendar-view" data-statement-page>
    <Breadcrumb :parent="{ label: t('routes.today.title'), to: '/', from: /^\/(?:[?#]|$)/ }" />
    <GrowthLoading v-if="days.state === 'loading'" :label="t('statementCalendar.loading.days')" />
    <PageStack v-else>
      <UiNotice v-if="days.state === 'failed'" tone="warning" data-calendar-failed>{{ t('statementCalendar.failed') }}</UiNotice>
      <p v-else-if="empty" class="statement-calendar-empty" data-calendar-empty>{{ t('statementCalendar.empty') }}</p>
      <template v-else>
        <Card as="section" class="statement-calendar-card" :aria-label="t('statementCalendar.calendar')">
          <div class="statement-calendar-body">
            <StatementCalendar :days="byDay" :today="today" :measure="measure" :measures="measures" :selected-day="selectedDay"
              :selected-week="week" @update:measure="chooseMeasure" @select="select" />
          </div>
        </Card>
        <Card as="section" class="statement-week-card" :aria-busy="reading !== null" data-statement-week>
          <CardHeader class="statement-week-head">
            <CardTitle as="h2" data-statement-week-range>{{ range(week) }}</CardTitle>
            <CardAction class="statement-week-actions">
              <span class="statement-week-reading" data-statement-week-reading>
                <GrowthLoading v-if="reading && shown" variant="inline" :label="t('statementCalendar.loading.week', { range: range(reading) })" />
              </span>
              <UiIconButton icon="chevron-left" size="sm" :label="t('statementCalendar.week.previous')" :disabled="week <= firstMonday"
                data-statement-week-previous @click="goWeek(addDays(week, -7))" />
              <UiIconButton icon="chevron-right" size="sm" :label="t('statementCalendar.week.next')" :disabled="week >= thisMonday"
                data-statement-week-next @click="goWeek(addDays(week, 7))" />
            </CardAction>
          </CardHeader>
          <div class="statement-week-body">
            <p v-if="daySummary" class="statement-week-day" data-statement-day>{{ daySummary }}</p>
            <GrowthLoading v-if="!shown" variant="compact" :label="t('statementCalendar.loading.week', { range: range(week) })" />
            <p v-else-if="!shown.statement" class="statement-week-none" :class="{ 'is-stale': reading }">{{ t('statementCalendar.weekFailed') }}</p>
            <StatementWeekRows v-else :statement="shown.statement" :class="{ 'is-stale': reading }" data-statement-week-rows />
          </div>
        </Card>
      </template>
    </PageStack>
  </section>
</template>

<style scoped>
.statement-calendar-body, .statement-week-body { min-width: 0; padding-inline: 20px; }
.statement-week-head { align-items: center; }
.statement-week-actions { display: flex; align-items: center; gap: 4px; align-self: center; }
/* The reading mark's own place, so nothing moves when it shows or goes. */
.statement-week-reading { display: inline-flex; justify-content: center; width: 30px; }
.statement-week-reading :deep(.growth-loading__label) {
  position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap;
}
.statement-week-day { margin: 0 0 8px; color: var(--color-muted); font-size: var(--text-body); }
.statement-week-none, .statement-calendar-empty { margin: 0; color: var(--color-muted); font-size: var(--text-body); }
.is-stale { opacity: 0.5; transition: opacity var(--motion-exit); }
</style>
