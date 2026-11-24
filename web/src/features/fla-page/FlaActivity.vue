<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { useNearEnd } from '@/composables/useNearEnd'
import { builtInRole } from '@/features/agent-profile/role-names'
import { activityWeeks } from '@/features/project-agents/activity-calendar'
import { taskStatusLabel } from '@/features/project-agents/task-labels'
import { currentLocale, t } from '@/i18n'
import { formatDateTime } from '@/lib/date-time'
import type { ProjectAgentActivityDay, ProjectAgentActivityResult } from '@/types'
import { readAgentActivity } from './agent-activity'

// Widget 'fla-activity' (docs/fla-page.md): 最近的活动, a year of days, each
// shaded by how many of this FLA's tasks ended that day (finished, failed or
// cancelled). A day opens the tasks it holds. Read only once the section comes
// into view, so the page does not pay for it on every visit. A year with
// nothing recorded says so instead of drawing empty squares. A built-in role's
// work is not recorded as these tasks, so its page has no such section.
const props = defineProps<{ spaceId: string; agentId: string; agentName?: string; projectName?: (id: string) => string }>()

const hasSource = computed(() => !builtInRole(props.agentId))
const section = ref<HTMLElement | null>(null)
const inView = useNearEnd(section, ref(null), 0)
// While the sections above it are still loading, this one can flash through
// the view; it reads only once it has stayed there a moment.
const SETTLE_MS = 300
const state = ref<'waiting' | 'loading' | 'ready' | 'failed'>('waiting')
const activity = ref<ProjectAgentActivityResult | null>(null)
const selected = ref('')
let generation = 0

async function load() {
  const current = ++generation
  state.value = 'loading'
  try {
    const value = await readAgentActivity(props.spaceId, props.agentId)
    if (current !== generation) return
    activity.value = value
    state.value = 'ready'
  } catch {
    if (current === generation) state.value = 'failed'
  }
}
let settle: ReturnType<typeof setTimeout> | undefined
watch(inView, (visible) => {
  clearTimeout(settle)
  if (visible && state.value === 'waiting') settle = setTimeout(() => { if (inView.value && state.value === 'waiting') void load() }, SETTLE_MS)
})
onBeforeUnmount(() => clearTimeout(settle))
watch(() => `${props.spaceId}/${props.agentId}`, () => {
  generation += 1
  activity.value = null
  selected.value = ''
  state.value = 'waiting'
  if (inView.value) void load()
})

const days = computed(() => activity.value?.days ?? [])
const weeks = computed(() => activityWeeks(days.value))
const total = computed(() => days.value.reduce((sum, day) => sum + day.total, 0))
const most = computed(() => Math.max(0, ...days.value.map(day => day.total)))
const intensity = (day: ProjectAgentActivityDay) => (!most.value || !day.total ? 0 : Math.min(4, Math.ceil((day.total / most.value) * 4)))
const selectedDay = computed(() => days.value.find(day => day.date === selected.value) ?? null)
const project = (id: string | null | undefined) => (id ? props.projectName?.(id) ?? id : '')

const dateText = (date: string) => formatDateTime(`${date}T00:00:00Z`, currentLocale(), { month: 'short', day: 'numeric', timeZone: 'UTC' }, { missing: date, invalid: date })
const monthText = (month: string) => formatDateTime(`${month}-01T00:00:00Z`, currentLocale(), { month: 'short', timeZone: 'UTC' }, { missing: '' })
// Weekday names from a known Monday (2024-01-01), in the page's locale.
const weekdays = computed(() => Array.from({ length: 7 }, (_, index) => formatDateTime(
  `2024-01-0${index + 1}T00:00:00Z`, currentLocale(), { weekday: 'short', timeZone: 'UTC' }, { missing: '' })))
const cellLabel = (day: ProjectAgentActivityDay) => t('flaPage.activity.cell', { date: dateText(day.date), count: day.total })

// A year wider than the column scrolls inside its own box, opened on the latest weeks.
const scroller = ref<HTMLElement | null>(null)
watch([scroller, weeks], async () => {
  await nextTick()
  if (scroller.value) scroller.value.scrollLeft = scroller.value.scrollWidth
})
</script>

<template>
  <section v-if="hasSource" id="fla-activity" ref="section" class="activity" aria-labelledby="fla-activity-heading" data-widget="fla-activity">
    <h2 id="fla-activity-heading" class="activity-label">
      {{ t('flaPage.activity.title') }}
      <span v-if="total" class="ui-num" data-activity-total>{{ t('flaPage.activity.total', { count: total }) }}</span>
    </h2>
    <GrowthLoading v-if="state === 'waiting' || state === 'loading'" variant="compact" :label="t('flaPage.activity.loading', { name: agentName ?? '' })" />
    <Card v-else class="activity-card">
      <p v-if="state === 'failed'" class="activity-hint" role="status" data-activity-failed>
        {{ t('flaPage.activity.failed') }}
        <Button size="sm" variant="ghost" @click="load">{{ t('flaPage.activity.retry') }}</Button>
      </p>
      <p v-else-if="!weeks.length" class="activity-hint" data-activity-empty>{{ t('flaPage.activity.empty') }}</p>
      <div v-else class="activity-frame">
        <!-- Weeks as columns, Monday on top; a year fills the width, a short range keeps readable cells. -->
        <div ref="scroller" class="activity-calendar" :style="{ '--weeks': weeks.length }" data-activity-calendar>
          <div class="activity-months" aria-hidden="true"><span v-for="week in weeks" :key="week.key">{{ week.month ? monthText(week.month) : '' }}</span></div>
          <div class="activity-weekdays" aria-hidden="true"><span v-for="(label, index) in weekdays" :key="index">{{ index % 2 === 0 ? label : '' }}</span></div>
          <div class="activity-grid" role="group" :aria-label="t('flaPage.activity.aria')">
            <template v-for="week in weeks" :key="week.key">
              <template v-for="(day, index) in week.days" :key="day?.date ?? `${week.key}:${index}`">
                <Button v-if="day" variant="ghost" size="icon-xs" :class="['activity-cell', `intensity-${intensity(day)}`]" :title="cellLabel(day)"
                  :aria-label="cellLabel(day)" :aria-pressed="selected === day.date" data-activity-day @click="selected = selected === day.date ? '' : day.date" />
                <span v-else class="activity-pad" aria-hidden="true" />
              </template>
            </template>
          </div>
        </div>
        <p class="activity-legend" :title="t('flaPage.activity.legend')">
          <span>{{ t('flaPage.activity.less') }}</span>
          <span v-for="level in 5" :key="level" :class="['activity-swatch', `intensity-${level - 1}`]" aria-hidden="true" />
          <span>{{ t('flaPage.activity.more') }}</span>
          <span class="ui-sr-only">{{ t('flaPage.activity.legend') }}</span>
        </p>
        <div v-if="selectedDay" class="activity-day" data-activity-detail>
          <p class="activity-day-head"><strong>{{ dateText(selectedDay.date) }}</strong> <span class="ui-num">{{ selectedDay.total }}</span></p>
          <p v-if="!selectedDay.tasks?.length" class="activity-hint">{{ t('flaPage.activity.noTasks') }}</p>
          <ul v-else class="activity-tasks">
            <li v-for="task in selectedDay.tasks" :key="task.taskId">
              <RouterLink class="activity-task" :to="{ query: { task: task.taskId } }">{{ task.title }}</RouterLink>
              <span class="activity-hint">{{ [taskStatusLabel(task.status), project(task.personalProjectId)].filter(Boolean).join(' · ') }}</span>
              <span v-if="task.summary" class="activity-summary">{{ task.summary }}</span>
            </li>
          </ul>
        </div>
      </div>
    </Card>
  </section>
</template>

<style scoped>
.activity { display: grid; gap: 12px; }
.activity-label { display: flex; align-items: baseline; gap: 8px; margin: 0; padding-inline: 4px; color: var(--color-ink-soft); font-size: var(--text-control); font-weight: var(--weight-strong); }
.activity-label .ui-num { color: var(--color-faint); font-weight: var(--weight-medium); }
.activity-card { gap: 8px; padding: 12px 24px; }
.activity-hint { margin: 0; color: var(--color-muted); font-size: var(--text-meta); }
/* The cells size to the column (container units); too narrow a column scrolls the calendar inside its own box. */
.activity-frame { container-type: inline-size; min-width: 0; }
.activity-calendar {
  --gap: 3px; --labels: 32px;
  --cell: clamp(10px, calc((100cqw - var(--labels) - 8px - 6px - (var(--weeks) - 1) * var(--gap)) / var(--weeks)), 28px);
  /* The padding is room for a chosen cell's ring, which this scrolling box would otherwise cut. */
  display: grid; grid-template-columns: var(--labels) max-content; grid-template-rows: auto auto; gap: 4px 8px;
  max-width: 100%; padding: 3px; overflow-x: auto; overflow-y: hidden; overscroll-behavior-x: contain;
}
.activity-months { grid-column: 2; display: grid; grid-template-columns: repeat(var(--weeks), var(--cell)); gap: var(--gap); color: var(--color-muted); font-size: 11px; line-height: 1.4; }
.activity-months span { white-space: nowrap; }
/* The weekday names stay put while a narrow column scrolls the weeks under them. */
.activity-weekdays { position: sticky; left: 0; z-index: 1; grid-column: 1; grid-row: 2; display: grid; background: var(--color-surface); box-shadow: -3px 0 0 var(--color-surface), 8px 0 0 var(--color-surface); grid-template-rows: repeat(7, var(--cell)); gap: var(--gap); color: var(--color-muted); font-size: 11px; }
/* The corner above them hides the month names scrolling past. */
.activity-calendar::before { content: ''; position: sticky; left: 0; z-index: 1; grid-column: 1; grid-row: 1; background: var(--color-surface); box-shadow: -3px 0 0 var(--color-surface), 8px 0 0 var(--color-surface); }
.activity-weekdays span { display: flex; align-items: center; white-space: nowrap; }
.activity-grid { grid-column: 2; grid-row: 2; display: grid; grid-auto-flow: column; grid-template-rows: repeat(7, var(--cell)); grid-auto-columns: var(--cell); gap: var(--gap); }
.activity-cell.activity-cell, .activity-swatch { box-sizing: border-box; width: 100%; min-width: 0; height: auto; min-height: 0; aspect-ratio: 1; padding: 0; border: 1px solid var(--color-border); border-radius: 3px; background: var(--color-surface-subtle); }
.activity-cell.activity-cell:hover { outline: 1px solid var(--color-control-border); outline-offset: 1px; }
.activity-cell.activity-cell[aria-pressed="true"] { outline: 2px solid var(--color-ink); outline-offset: 1px; }
.activity-pad { display: block; }
.activity-cell.intensity-1, .activity-swatch.intensity-1 { border-color: transparent; background: color-mix(in oklab, var(--color-accent) 25%, var(--color-surface-subtle)); }
.activity-cell.intensity-2, .activity-swatch.intensity-2 { border-color: transparent; background: color-mix(in oklab, var(--color-accent) 50%, var(--color-surface-subtle)); }
.activity-cell.intensity-3, .activity-swatch.intensity-3 { border-color: transparent; background: color-mix(in oklab, var(--color-accent) 75%, var(--color-surface-subtle)); }
.activity-cell.intensity-4, .activity-swatch.intensity-4 { border-color: transparent; background: var(--color-accent); }
.activity-legend { display: flex; align-items: center; justify-content: flex-end; gap: 4px; margin: 8px 0 0; color: var(--color-muted); font-size: var(--text-meta); }
.activity-swatch { display: inline-block; width: 12px; }
.activity-day { display: grid; gap: 6px; margin-top: 8px; padding-top: 10px; border-top: 1px solid var(--color-border); }
.activity-day-head { display: flex; align-items: baseline; gap: 8px; margin: 0; font-size: var(--text-body); }
.activity-day-head .ui-num { color: var(--color-muted); font-size: var(--text-meta); }
.activity-tasks { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.activity-tasks li { display: grid; gap: 2px; min-width: 0; }
.activity-task { overflow: hidden; color: var(--color-ink); font-size: var(--text-body); text-decoration: none; text-overflow: ellipsis; white-space: nowrap; }
.activity-task:hover { text-decoration: underline; }
.activity-summary { color: var(--color-ink-soft); font-size: var(--text-meta); overflow-wrap: anywhere; }
</style>
