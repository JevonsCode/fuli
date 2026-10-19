<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import GrowthLoading from '@/components/GrowthLoading.vue'
import TextField from '@/components/TextField.vue'
import { ApiError } from '@/api/client'
import { formatDate, taskStatusLabel } from '@/features/project-agents/task-labels'
import {
  createSchedule, intervalMs, intervalTooShort, listSchedules, scheduleRuns, scheduleState, setScheduleEnabled, updateSchedule,
  type ScheduleRun, type ScheduleUnit, type StartMode, type TaskSchedule,
} from '@/features/task-schedules/task-schedules'
import { t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import { UiButton, UiChip, UiDialog, UiEmpty, UiSelect, UiToolbar } from '@/ui'

// 定时任务: schedules that create a project task at a fixed interval. The page
// shows planned slots as plans, never as guaranteed runs, and reloads after a
// conflict instead of overwriting someone else's change.
const store = useConsoleStore()
const spaceId = computed(() => store.activePersonalSpace?.id ?? '')
const projects = computed(() => store.state?.personalProjects ?? [])
const projectName = (id: string) => projects.value.find(project => project.project_id === id)?.profile.name ?? id
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone

const schedules = ref<TaskSchedule[]>([])
const loading = ref(false)
const loaded = ref(false)
const loadError = ref('')
let readGeneration = 0
async function load() {
  if (!spaceId.value) return
  const generation = ++readGeneration
  loading.value = true
  loadError.value = ''
  try {
    const result = await listSchedules(spaceId.value)
    if (generation !== readGeneration) return
    schedules.value = result.schedules
    loaded.value = true
  } catch (cause) {
    if (generation !== readGeneration) return
    if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403)) schedules.value = []
    loadError.value = t('taskSchedules.loadFailed')
  } finally {
    if (generation === readGeneration) loading.value = false
  }
}
onMounted(() => { if (!store.state) void store.refresh(); void load() })
watch(spaceId, () => { schedules.value = []; loaded.value = false; void load() })

// Pause is immediate; resume explains that missed slots are not replayed.
const busyId = ref('')
const actionError = ref('')
const resumeTarget = ref<TaskSchedule | null>(null)
async function toggle(schedule: TaskSchedule, enabled: boolean) {
  busyId.value = schedule.id
  actionError.value = ''
  try {
    const saved = await setScheduleEnabled(spaceId.value, schedule, enabled)
    schedules.value = schedules.value.map(item => item.id === saved.id ? { ...saved, recentRuns: item.recentRuns } : item)
    resumeTarget.value = null
  } catch (cause) {
    actionError.value = cause instanceof ApiError && cause.status === 409 ? t('taskSchedules.conflict')
      : cause instanceof Error ? cause.message : String(cause)
    resumeTarget.value = null
    await load()
  } finally {
    busyId.value = ''
  }
}

// Create and edit share one form. The start mode is never preselected. A lost
// create response is unconfirmed: create has no idempotency key, so the form
// locks and offers only reading the list again, never a second create.
const dialogOpen = ref(false)
const editing = ref<TaskSchedule | null>(null)
const saving = ref(false)
const formError = ref('')
const createUnknown = ref(false)
const draft = reactive({ project: '', title: '', objective: '', workKind: '', count: '1', unit: 'days' as ScheduleUnit,
  startMode: '' as StartMode | '', threshold: '3', firstRunAt: '' })
const projectOptions = computed(() => projects.value.map(project => ({ value: project.project_id, label: project.profile.name })))
const unitOptions = computed(() => (['minutes', 'hours', 'days'] as const).map(unit => ({ value: unit, label: t(`taskSchedules.unit.${unit}`) })))
const thresholdOptions = Array.from({ length: 10 }, (_, index) => ({ value: String(index + 1), label: String(index + 1) }))
// Without a chosen time the first slot is one interval after the form opened;
// it is shown and sent as that exact time, so what is confirmed is what is saved.
const openedAt = ref(Date.now())
const plannedFirst = computed(() => {
  if (draft.firstRunAt) return new Date(draft.firstRunAt)
  const every = { unit: draft.unit, count: Number(draft.count) }
  return intervalTooShort(every) ? null : new Date(openedAt.value + intervalMs(every))
})
function openCreate() {
  editing.value = null
  Object.assign(draft, { project: '', title: '', objective: '', workKind: '', count: '1', unit: 'days', startMode: '', threshold: '3', firstRunAt: '' })
  openedAt.value = Date.now()
  formError.value = ''
  createUnknown.value = false
  dialogOpen.value = true
}
function openEdit(schedule: TaskSchedule) {
  editing.value = schedule
  Object.assign(draft, { project: schedule.personalProjectId, title: schedule.body.title, objective: schedule.body.objective,
    workKind: schedule.body.workKind, count: String(schedule.body.every.count), unit: schedule.body.every.unit,
    startMode: schedule.body.startMode, threshold: String(schedule.body.failureThreshold), firstRunAt: '' })
  formError.value = ''
  createUnknown.value = false
  dialogOpen.value = true
}
function validate(): string {
  if (!draft.project) return t('taskSchedules.form.chooseProject')
  if (intervalTooShort({ unit: draft.unit, count: Number(draft.count) })) return t('taskSchedules.form.tooShort')
  if (!draft.startMode) return t('taskSchedules.form.chooseStart')
  if (!editing.value && draft.firstRunAt && new Date(draft.firstRunAt).getTime() <= Date.now()) return t('taskSchedules.form.past')
  return ''
}
function apiMessage(error: ApiError) {
  try { return (JSON.parse(error.detail) as { error?: string }).error || error.message } catch { return error.detail || error.message }
}
async function save() {
  if (createUnknown.value || saving.value) return
  formError.value = validate()
  if (formError.value) return
  saving.value = true
  const changes = { title: draft.title.trim(), objective: draft.objective.trim(), workKind: draft.workKind.trim(),
    every: { unit: draft.unit, count: Number(draft.count) }, startMode: draft.startMode as StartMode,
    failureThreshold: Number(draft.threshold) }
  try {
    if (editing.value) await updateSchedule(spaceId.value, editing.value, changes)
    else await createSchedule(spaceId.value, { personalProjectId: draft.project, ...changes, firstRunAt: plannedFirst.value!.toISOString() })
    dialogOpen.value = false
    await load()
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 409) { formError.value = t('taskSchedules.conflict'); await load(); return }
    const unknown = !(cause instanceof ApiError) || cause.status >= 500
    if (unknown && !editing.value) createUnknown.value = true
    formError.value = unknown ? t('taskSchedules.form.unknown') : apiMessage(cause)
  } finally {
    saving.value = false
  }
}
async function verifyCreate() {
  await load()
  dialogOpen.value = false
  createUnknown.value = false
}

// The latest 50 tasks a schedule created, read on request.
const runsOpen = ref('')
const runsLoading = ref(false)
const runsError = ref(false)
const scheduleRunList = ref<ScheduleRun[]>([])
async function toggleRuns(schedule: TaskSchedule) {
  if (runsOpen.value === schedule.id) { runsOpen.value = ''; return }
  runsOpen.value = schedule.id
  runsLoading.value = true
  runsError.value = false
  scheduleRunList.value = []
  try {
    const result = await scheduleRuns(spaceId.value, schedule.id)
    if (runsOpen.value === schedule.id) scheduleRunList.value = result.runs
  } catch {
    if (runsOpen.value === schedule.id) runsError.value = true
  } finally {
    runsLoading.value = false
  }
}
</script>

<template>
  <section class="view page-stack task-schedules-view">
    <p class="page-lede">{{ t('taskSchedules.lede') }}</p>
    <UiToolbar>
      <template #end>
        <GrowthLoading v-if="loading && schedules.length" variant="inline" :label="t('taskSchedules.loading')" />
        <UiButton variant="ghost" size="sm" :disabled="loading" @click="load">{{ t('taskSchedules.refresh') }}</UiButton>
        <UiButton variant="primary" size="sm" data-schedule-new @click="openCreate">{{ t('taskSchedules.new') }}</UiButton>
      </template>
    </UiToolbar>
    <p v-if="actionError" role="alert" class="inline-error">{{ actionError }}</p>
    <p v-if="loadError" role="alert" class="inline-error">
      {{ loadError }} <UiButton size="sm" variant="ghost" @click="load">{{ t('taskSchedules.retryRead') }}</UiButton>
    </p>

    <GrowthLoading v-if="loading && !schedules.length" variant="compact" :label="t('taskSchedules.loading')" />
    <UiEmpty v-else-if="loaded && !schedules.length" class="ui-list" :text="t('taskSchedules.empty')" />
    <div v-if="schedules.length" class="ui-list">
      <article v-for="schedule in schedules" :key="schedule.id" class="ui-list-row" :data-schedule-row="schedule.id">
        <div class="ui-list-main">
          <strong class="ui-list-heading">{{ schedule.body.title }}</strong>
          <p class="ui-list-text">{{ projectName(schedule.personalProjectId) }} · {{ t('taskSchedules.every', { count: schedule.body.every.count, unit: t(`taskSchedules.unit.${schedule.body.every.unit}`) }) }}</p>
          <div class="ui-list-meta">
            <UiChip :tone="scheduleState(schedule) === 'enabled' ? 'accent' : scheduleState(schedule) === 'circuit_open' ? 'warning' : 'neutral'">
              {{ t(`taskSchedules.state.${scheduleState(schedule)}`) }}
            </UiChip>
            <span :title="t('taskSchedules.nextHint')">{{ t('taskSchedules.next') }} · {{ formatDate(schedule.nextRunAt) }} ({{ timeZone }})</span>
            <span>{{ t(`taskSchedules.startMode.${schedule.body.startMode}`) }}</span>
            <span>{{ t('taskSchedules.threshold', { count: schedule.body.failureThreshold }) }}</span>
          </div>
          <p class="task-schedule-runs">
            <span>{{ t('taskSchedules.recent') }} ·</span>
            <template v-if="schedule.recentRuns?.length">
              <span v-for="run in schedule.recentRuns" :key="run.slot" class="task-schedule-run">
                {{ formatDate(run.slot) }} · {{ run.taskId ? taskStatusLabel(run.status as never) : t('taskSchedules.submitFailed') }}
              </span>
            </template>
            <span v-else>{{ t('taskSchedules.noRuns') }}</span>
          </p>
        </div>
        <div class="ui-list-actions">
          <UiButton variant="ghost" size="sm" data-schedule-edit @click="openEdit(schedule)">{{ t('taskSchedules.edit') }}</UiButton>
          <UiButton variant="ghost" size="sm" :aria-expanded="runsOpen === schedule.id" data-schedule-runs @click="toggleRuns(schedule)">
            {{ t('taskSchedules.runs') }}
          </UiButton>
          <UiButton v-if="schedule.enabled" variant="ghost" size="sm" :busy="busyId === schedule.id" :busy-label="t('taskSchedules.pausing')"
            data-schedule-pause @click="toggle(schedule, false)">{{ t('taskSchedules.pause') }}</UiButton>
          <UiButton v-else variant="ghost" size="sm" :disabled="busyId === schedule.id" data-schedule-resume @click="resumeTarget = schedule">
            {{ t('taskSchedules.resume') }}
          </UiButton>
        </div>
        <div v-if="runsOpen === schedule.id" class="task-schedule-run-panel" data-schedule-run-panel>
          <GrowthLoading v-if="runsLoading" variant="inline" :label="t('taskSchedules.loadingRuns')" />
          <p v-else-if="runsError" role="alert" class="inline-error">{{ t('taskSchedules.runsFailed') }}</p>
          <p v-else-if="!scheduleRunList.length">{{ t('taskSchedules.noRuns') }}</p>
          <template v-else>
            <p class="ui-meta">{{ t('taskSchedules.latest50') }}</p>
            <ol class="task-schedule-run-list">
              <li v-for="run in scheduleRunList" :key="run.slot">
                <span>{{ formatDate(run.slot) }}</span>
                <span>{{ run.taskId ? taskStatusLabel(run.status as never) : t('taskSchedules.submitFailed') }}</span>
                <code v-if="run.taskId">{{ run.taskId }}</code>
              </li>
            </ol>
          </template>
        </div>
      </article>
    </div>

    <UiDialog :open="Boolean(resumeTarget)" size="sm" :title="t('taskSchedules.resumeTitle')" :busy="busyId === resumeTarget?.id" @close="resumeTarget = null">
      <p>{{ resumeTarget?.body.title }}</p>
      <p>{{ t('taskSchedules.resumeBody') }}</p>
      <template #footer>
        <UiButton variant="ghost" :disabled="Boolean(busyId)" @click="resumeTarget = null">{{ t('taskSchedules.form.cancel') }}</UiButton>
        <UiButton variant="primary" :busy="Boolean(busyId)" :busy-label="t('taskSchedules.resuming')" data-schedule-resume-confirm
          @click="resumeTarget && toggle(resumeTarget, true)">{{ t('taskSchedules.resumeConfirm') }}</UiButton>
      </template>
    </UiDialog>

    <UiDialog :open="dialogOpen" form :busy="saving" :error="formError" :title="t(editing ? 'taskSchedules.form.editTitle' : 'taskSchedules.form.title')"
      :description="editing ? undefined : t('taskSchedules.form.description')" @close="dialogOpen = false" @submit="save">
      <fieldset class="task-schedule-form" :disabled="createUnknown">
        <UiSelect v-model="draft.project" field :label="t('taskSchedules.form.project')" :options="projectOptions" required :disabled="Boolean(editing)" />
        <TextField v-model="draft.title" :label="t('taskSchedules.form.name')" required data-schedule-title />
        <TextField v-model="draft.objective" :label="t('taskSchedules.form.objective')" multiline :rows="3" required data-schedule-objective />
        <TextField v-model="draft.workKind" :label="t('taskSchedules.form.workKind')" required data-schedule-work-kind />
        <fieldset class="task-schedule-interval">
          <legend>{{ t('taskSchedules.form.interval') }}</legend>
          <label><span class="ui-sr-only">{{ t('taskSchedules.form.count') }}</span>
            <input v-model="draft.count" type="number" min="1" max="1000" required data-schedule-count /></label>
          <UiSelect v-model="draft.unit" :label="t('taskSchedules.form.interval')" :options="unitOptions" />
        </fieldset>
        <fieldset class="task-schedule-start">
          <legend>{{ t('taskSchedules.form.startMode') }}</legend>
          <label><input v-model="draft.startMode" type="radio" name="schedule-start" value="queue" /> {{ t('taskSchedules.startMode.queue') }}</label>
          <label><input v-model="draft.startMode" type="radio" name="schedule-start" value="backlog" /> {{ t('taskSchedules.startMode.backlog') }}</label>
        </fieldset>
        <UiSelect v-model="draft.threshold" field :label="t('taskSchedules.form.threshold')" :options="thresholdOptions" />
        <label v-if="!editing" class="task-schedule-first">
          <span>{{ t('taskSchedules.form.firstRun') }} ({{ timeZone }})</span>
          <input v-model="draft.firstRunAt" type="datetime-local" data-schedule-first-run />
          <small>{{ t('taskSchedules.form.firstRunHint') }}</small>
        </label>
        <p v-if="!editing && plannedFirst" class="task-schedule-planned" data-schedule-planned>
          {{ t('taskSchedules.form.planned', { local: formatDate(plannedFirst.toISOString()), zone: timeZone, utc: plannedFirst.toISOString() }) }}
        </p>
        <p v-if="editing" class="ui-meta">{{ t('taskSchedules.form.editHint') }}</p>
      </fieldset>
      <template #footer>
        <template v-if="createUnknown">
          <UiButton variant="primary" data-schedule-verify @click="verifyCreate">{{ t('taskSchedules.form.verify') }}</UiButton>
        </template>
        <template v-else>
          <UiButton variant="ghost" :disabled="saving" @click="dialogOpen = false">{{ t('taskSchedules.form.cancel') }}</UiButton>
          <UiButton variant="primary" type="submit" :busy="saving" :busy-label="t('taskSchedules.form.saving')" data-schedule-save>
            {{ editing ? t('taskSchedules.form.saveEdit') : t('taskSchedules.form.save') }}
          </UiButton>
        </template>
      </template>
    </UiDialog>
  </section>
</template>

<style scoped>
.task-schedule-runs { display: flex; flex-wrap: wrap; gap: 6px 12px; margin: 4px 0 0; font-size: 13px; }
.task-schedule-form { display: grid; gap: 12px; margin: 0; padding: 0; border: 0; }
.task-schedule-planned { margin: 0; font-size: 13px; }
.task-schedule-run-panel { grid-column: 1 / -1; display: grid; gap: 6px; }
.task-schedule-run-list { display: grid; gap: 4px; margin: 0; padding: 0; list-style: none; font-size: 13px; }
.task-schedule-run-list li { display: flex; flex-wrap: wrap; gap: 4px 12px; }
.task-schedule-run-list code { overflow-wrap: anywhere; }
.task-schedule-interval { display: flex; flex-wrap: wrap; gap: 8px; align-items: end; margin: 0; padding: 0; border: 0; }
.task-schedule-interval input { width: 96px; min-height: 36px; }
.task-schedule-start { display: grid; gap: 6px; margin: 0; padding: 0; border: 0; }
.task-schedule-start label { display: flex; gap: 8px; align-items: center; min-height: 32px; }
.task-schedule-first { display: grid; gap: 4px; }
</style>
