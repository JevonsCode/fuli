<script setup lang="ts">
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { formatDate } from '@/features/project-agents/task-labels'
import { t } from '@/i18n'
import { scheduleRunLabel, scheduleState, type ScheduleRun, type TaskSchedule } from './task-schedules'

// One schedule's details in the quick look: what it creates, when, how, and
// the latest 50 tasks it created (read when the quick look opens). A schedule
// has no larger page, so everything about it is here; pause, resume and edit
// are its quick changes.
defineProps<{
  schedule?: TaskSchedule
  /** The list was read and has no such schedule (or it belongs to another space). */
  missing: boolean
  projectName: string
  timeZone: string
  pausing: boolean
  runs: { loading: boolean; error: boolean; items: ScheduleRun[] }
  openingTask: string
  openTaskError: string
}>()
const emit = defineEmits<{ edit: []; pause: []; resume: []; 'open-task': [taskId: string] }>()

const stateTone = (schedule: TaskSchedule) =>
  ({ enabled: 'success', paused: 'secondary', circuit_open: 'warning', unknown: 'secondary' } as const)[scheduleState(schedule)]
</script>

<template>
  <template v-if="!schedule">
    <DialogHeader>
      <DialogTitle>{{ t('taskSchedules.details') }}</DialogTitle>
      <DialogDescription>{{ t(missing ? 'taskSchedules.notFound' : 'taskSchedules.loading') }}</DialogDescription>
    </DialogHeader>
    <GrowthLoading v-if="!missing" variant="compact" :label="t('taskSchedules.loading')" />
  </template>
  <template v-else>
    <DialogHeader>
      <DialogTitle class="text-xl leading-tight [overflow-wrap:anywhere]">{{ schedule.body.title }}</DialogTitle>
      <DialogDescription class="flex flex-wrap items-center gap-2">
        <Badge :variant="stateTone(schedule)">{{ t(`taskSchedules.state.${scheduleState(schedule)}`) }}</Badge>
        <span>{{ projectName }} · {{ t('taskSchedules.every', { count: schedule.body.every.count, unit: t(`taskSchedules.unit.${schedule.body.every.unit}`) }) }}</span>
      </DialogDescription>
    </DialogHeader>
    <dl class="schedule-peek-facts m-0 grid gap-x-6 gap-y-3 border-t pt-4 text-sm sm:grid-cols-2">
      <div class="grid gap-0.5">
        <dt class="text-xs font-semibold text-muted-foreground" :title="t('taskSchedules.nextHint')">{{ t('taskSchedules.next') }}</dt>
        <dd class="m-0">{{ formatDate(schedule.nextRunAt) }} <span class="text-muted-foreground">({{ timeZone }})</span></dd>
      </div>
      <div class="grid gap-0.5">
        <dt class="text-xs font-semibold text-muted-foreground">{{ t('taskSchedules.columns.startMode') }}</dt>
        <dd class="m-0">{{ t(`taskSchedules.startMode.${schedule.body.startMode}`) }}</dd>
      </div>
      <div class="grid gap-0.5">
        <dt class="text-xs font-semibold text-muted-foreground">{{ t('taskSchedules.columns.threshold') }}</dt>
        <dd class="m-0">{{ t('taskSchedules.threshold', { count: schedule.body.failureThreshold }) }}</dd>
      </div>
      <div class="grid gap-0.5">
        <dt class="text-xs font-semibold text-muted-foreground">{{ t('taskSchedules.workKind') }}</dt>
        <dd class="m-0 [overflow-wrap:anywhere]">{{ schedule.body.workKind }}</dd>
      </div>
      <div class="grid gap-0.5 sm:col-span-2">
        <dt class="text-xs font-semibold text-muted-foreground">{{ t('taskSchedules.objective') }}</dt>
        <dd class="m-0 whitespace-pre-line [overflow-wrap:anywhere]">{{ schedule.body.objective }}</dd>
      </div>
    </dl>
    <section class="grid gap-2 border-t pt-4 text-sm" data-schedule-run-panel :aria-label="t('taskSchedules.runs')">
      <div class="flex items-baseline justify-between gap-3">
        <h3 class="text-sm font-semibold">{{ t('taskSchedules.runs') }}</h3>
        <span v-if="runs.items.length" class="text-xs text-muted-foreground">{{ t('taskSchedules.latest50') }}</span>
      </div>
      <GrowthLoading v-if="runs.loading" variant="inline" :label="t('taskSchedules.loadingRuns')" />
      <p v-else-if="runs.error" role="alert" class="text-destructive">{{ t('taskSchedules.runsFailed') }}</p>
      <p v-else-if="!runs.items.length" class="text-muted-foreground">{{ t('taskSchedules.noRuns') }}</p>
      <ol v-else class="schedule-run-list m-0 grid max-h-64 list-none gap-1 overflow-y-auto p-0">
        <li v-for="run in runs.items" :key="run.slot" class="flex flex-wrap items-center gap-x-3 gap-y-1 border-b py-1.5 last:border-b-0">
          <span class="tabular-nums">{{ formatDate(run.slot) }}</span>
          <span class="text-muted-foreground" :title="run.lastError ?? undefined">{{ scheduleRunLabel(run) }}</span>
          <Button v-if="run.taskId" variant="ghost" size="sm" class="ml-auto" :loading="openingTask === run.taskId" :loading-label="t('taskSchedules.openingTask')"
            :aria-label="t('taskSchedules.openTaskLabel', { id: run.taskId })" data-schedule-open-task @click="emit('open-task', run.taskId)">
            {{ t('taskSchedules.openTask') }} <code>{{ run.taskId.slice(0, 8) }}</code>
          </Button>
        </li>
      </ol>
      <p v-if="openTaskError" role="alert" class="text-destructive">{{ openTaskError }}</p>
    </section>
    <DialogFooter class="border-t pt-4">
      <Button variant="outline" data-peek-edit @click="emit('edit')">{{ t('taskSchedules.edit') }}</Button>
      <Button v-if="schedule.enabled" variant="outline" :loading="pausing" :loading-label="t('taskSchedules.pausing')" data-peek-pause @click="emit('pause')">
        {{ t('taskSchedules.pause') }}
      </Button>
      <Button v-else data-peek-resume @click="emit('resume')">{{ t('taskSchedules.resume') }}</Button>
    </DialogFooter>
  </template>
</template>
