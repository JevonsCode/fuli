<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import GrowthLoading from '@/components/GrowthLoading.vue'
import TextField from '@/components/TextField.vue'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { focusReturnTarget, useFocusReturn } from '@/composables/useFocusReturn'
import { useRoutePeek } from '@/composables/useRoutePeek'
import SchedulePeek from '@/features/task-schedules/SchedulePeek.vue'
import {
  readScheduleTableQuery, SCHEDULE_COLUMNS, SCHEDULE_SORTS, SCHEDULE_STATE_FILTERS, scheduleColumnVisible, scheduleTableLocationQuery,
  visibleSchedules, type ScheduleColumn, type ScheduleTableQuery,
} from '@/features/task-schedules/schedule-table'
import { ApiError, getJson } from '@/api/client'
import { formatDate } from '@/features/project-agents/task-labels'
import { normalizeTask } from '@/features/project-agents/task-evidence'
import {
  createSchedule, intervalMs, intervalTooShort, listSchedules, scheduleRunLabel, scheduleRuns, scheduleState, setScheduleEnabled, updateSchedule,
  type ScheduleRun, type ScheduleUnit, type StartMode, type TaskSchedule,
} from '@/features/task-schedules/task-schedules'
import { currentLocale, t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import { Button } from '@/components/ui/button'
import { UiDialog, UiIcon, UiSelect } from '@/ui'

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
// Says whether the list was actually read, so a check that failed is never
// taken as a check that passed.
async function load(): Promise<boolean> {
  if (!spaceId.value) return false
  const generation = ++readGeneration
  loading.value = true
  loadError.value = ''
  try {
    const result = await listSchedules(spaceId.value)
    if (generation !== readGeneration) return false
    schedules.value = result.schedules
    loaded.value = true
    return true
  } catch (cause) {
    if (generation !== readGeneration) return false
    if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403)) schedules.value = []
    loadError.value = t('taskSchedules.loadFailed')
    return false
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
// What an unconfirmed create actually sent, and when; never the draft as edited since.
const submitted = ref<{ title: string; project: string; every: string; startMode: StartMode; firstRunAt: string; at: string } | null>(null)
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
  submitted.value = null
  dialogOpen.value = true
}
function openEdit(schedule: TaskSchedule) {
  editing.value = schedule
  editedFrom = schedule
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
  // The default first slot was one interval after the form opened. If that
  // time has passed, move it to one interval from now and ask again.
  if (!editing.value && !draft.firstRunAt && plannedFirst.value && plannedFirst.value.getTime() <= Date.now()) {
    openedAt.value = Date.now()
    return t('taskSchedules.form.plannedMoved', { local: formatDate(plannedFirst.value!.toISOString()) })
  }
  return ''
}
function apiMessage(error: ApiError) {
  try { return (JSON.parse(error.detail) as { error?: string }).error || error.message } catch { return error.detail || error.message }
}
// A create that gets no answer within this time is treated as unconfirmed.
const CREATE_LIMIT_MS = 30_000
let createTimer: ReturnType<typeof setTimeout> | undefined
onBeforeUnmount(() => clearTimeout(createTimer))
// The schedule the person started editing; a conflict compares against it.
let editedFrom: TaskSchedule | null = null
async function save() {
  if (createUnknown.value || saving.value) return
  formError.value = validate()
  if (formError.value) return
  saving.value = true
  const controller = new AbortController()
  const changes = { title: draft.title.trim(), objective: draft.objective.trim(), workKind: draft.workKind.trim(),
    every: { unit: draft.unit, count: Number(draft.count) }, startMode: draft.startMode as StartMode,
    failureThreshold: Number(draft.threshold) }
  try {
    if (editing.value) await updateSchedule(spaceId.value, editing.value, changes)
    else {
      const payload = { personalProjectId: draft.project, ...changes, firstRunAt: plannedFirst.value!.toISOString() }
      submitted.value = { title: payload.title, project: projectName(payload.personalProjectId), startMode: payload.startMode,
        every: t('taskSchedules.every', { count: payload.every.count, unit: t(`taskSchedules.unit.${payload.every.unit}`) }),
        firstRunAt: payload.firstRunAt, at: new Date().toISOString() }
      createTimer = setTimeout(() => controller.abort(), CREATE_LIMIT_MS)
      await createSchedule(spaceId.value, payload, controller.signal)
    }
    dialogOpen.value = false
    await load()
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 409) { await conflict(); return }
    const unknown = !(cause instanceof ApiError) || cause.status >= 500
    if (unknown && !editing.value) createUnknown.value = true
    formError.value = unknown ? t('taskSchedules.form.unknown') : apiMessage(cause)
  } finally {
    clearTimeout(createTimer)
    saving.value = false
  }
}
// Someone else saved first. Read the list again, keep the draft, and say what
// changed on the server; the next save, if the person confirms, uses the
// latest revision. Nothing is sent again on its own.
const CONFLICT_FIELDS = ['title', 'objective', 'workKind', 'every', 'startMode', 'failureThreshold'] as const
async function conflict() {
  const id = editing.value?.id
  if (!(await load()) || !id) { formError.value = t('taskSchedules.conflict'); return }
  const latest = schedules.value.find(item => item.id === id)
  if (!latest) { formError.value = t('taskSchedules.form.gone'); return }
  const before = editedFrom?.body
  const changed = before
    ? CONFLICT_FIELDS.filter(field => JSON.stringify(before[field]) !== JSON.stringify(latest.body[field])).map(field => t(`taskSchedules.field.${field}`))
    : []
  if (editedFrom && latest.enabled !== editedFrom.enabled) changed.push(t('taskSchedules.field.enabled'))
  editing.value = latest
  editedFrom = latest
  formError.value = t('taskSchedules.form.conflictChanged', { revision: latest.revision,
    fields: changed.length ? changed.join('、') : t('taskSchedules.form.noVisibleChange') })
}
// Only a list that was actually read can settle an unconfirmed create.
async function verifyCreate() {
  if (!(await load())) { formError.value = t('taskSchedules.form.verifyFailed'); return }
  dialogOpen.value = false
  createUnknown.value = false
}

// A schedule run names only its task; the task is read when opened, to find
// the Agent whose page shows it.
const route = useRoute()
const router = useRouter()
const openingTask = ref('')
const openTaskError = ref('')
async function openTask(schedule: TaskSchedule, taskId: string) {
  openingTask.value = taskId
  openTaskError.value = ''
  try {
    const query = new URLSearchParams({ personalSpaceId: spaceId.value, personalProjectId: schedule.personalProjectId })
    const task = normalizeTask(await getJson<unknown>(`/api/project-agent-tasks/${encodeURIComponent(taskId)}?${query}`))
    const agent = task?.leadAgentId ?? schedule.body.leadAgentId
    if (!task || !agent) { openTaskError.value = t('taskSchedules.taskUnavailable'); return }
    await router.push({ path: '/project-agents/manage', query: { agent, project: schedule.personalProjectId, task: taskId } })
  } catch {
    openTaskError.value = t('taskSchedules.taskUnavailable')
  } finally {
    openingTask.value = ''
  }
}

// The table: filters and sort in the URL, rows in the chosen order.
const tableQuery = computed(() => readScheduleTableQuery(route.query))
function setTableQuery(change: Partial<ScheduleTableQuery>) {
  void router.replace({ query: scheduleTableLocationQuery(route.query, { ...tableQuery.value, ...change }) })
}
const rows = computed(() => visibleSchedules(schedules.value, tableQuery.value, projectName, currentLocale()))
const stateOptions = computed(() => SCHEDULE_STATE_FILTERS.map(value => ({
  value, label: value === 'all' ? t('taskSchedules.filter.allStates') : t(`taskSchedules.state.${value}`) })))
const sortOptions = computed(() => SCHEDULE_SORTS.map(value => ({
  value, label: t(value === 'next' ? 'taskSchedules.filter.sortNext' : 'taskSchedules.filter.sortName') })))
const stateTone = (schedule: TaskSchedule) =>
  ({ enabled: 'success', paused: 'secondary', circuit_open: 'warning', unknown: 'secondary' } as const)[scheduleState(schedule)]

// Optional columns: low-priority ones appear once the table is wide enough;
// the person's own choice is remembered in this browser only.
const COLUMN_STORAGE_KEY = 'fuli.schedules.columns'
function readColumnChoices(): Partial<Record<ScheduleColumn, boolean>> {
  try { return JSON.parse(localStorage.getItem(COLUMN_STORAGE_KEY) ?? '{}') ?? {} } catch { return {} }
}
const columnChoices = ref(readColumnChoices())
const tableWidth = ref(0)
const tableArea = ref<HTMLElement | null>(null)
let resizeObserver: ResizeObserver | undefined
onMounted(() => {
  if (typeof ResizeObserver === 'undefined') return
  resizeObserver = new ResizeObserver(([entry]) => { tableWidth.value = entry?.contentRect.width ?? 0 })
  if (tableArea.value) resizeObserver.observe(tableArea.value)
})
onBeforeUnmount(() => resizeObserver?.disconnect())
const shows = (column: ScheduleColumn) => scheduleColumnVisible(column, tableWidth.value, columnChoices.value)
function chooseColumn(column: ScheduleColumn, visible: boolean) {
  columnChoices.value = { ...columnChoices.value, [column]: visible }
  try { localStorage.setItem(COLUMN_STORAGE_KEY, JSON.stringify(columnChoices.value)) } catch { /* storage may be unavailable */ }
}

// Details: the name opens a quick look (?item=<space>/<schedule>) that a
// refresh or a shared link reopens once the list is read.
const peek = useRoutePeek()
const peekSchedule = computed(() => peek.item.value && peek.item.value.spaceId === spaceId.value
  ? schedules.value.find(item => item.id === peek.item.value?.id) : undefined)
const peekMissing = computed(() => Boolean(peek.item.value) && !peekSchedule.value
  && (peek.item.value?.spaceId !== spaceId.value || (loaded.value && !loading.value)))
const focusReturn = useFocusReturn(tableArea, 'task-schedules', computed(() => rows.value.length > 0))
let peekOpener: HTMLElement | null = null
let lastPeekId = ''
// While the quick look hands over to the edit or resume dialog, that dialog keeps focus.
let handingOver = false
function openPeek(schedule: TaskSchedule) {
  const active = document.activeElement
  peekOpener = active instanceof HTMLElement && active !== document.body ? active : null
  peek.open({ spaceId: spaceId.value, id: schedule.id })
}
function peekOpenChange(open: boolean) { if (!open) peek.close() }
// Opening lands on Edit, the safe main action, rather than on a task link or Pause.
function focusPeekAction(event: Event) {
  const action = (event.target as HTMLElement | null)?.querySelector<HTMLElement>('[data-peek-edit]')
  if (!action) return
  event.preventDefault()
  action.focus()
}
function returnFocusFromPeek(event: Event) {
  event.preventDefault()
  const opener = peekOpener
  peekOpener = null
  if (handingOver) { handingOver = false; return }
  if (opener?.isConnected) opener.focus({ preventScroll: true })
  else focusReturnTarget(tableArea.value, lastPeekId)
}
function handOver(action: () => void) {
  handingOver = true
  peek.close()
  action()
}

// The latest 50 tasks a schedule created, read when its quick look opens.
const runsLoading = ref(false)
const runsError = ref(false)
const scheduleRunList = ref<ScheduleRun[]>([])
let runsFor = ''
watch(peekSchedule, async (schedule) => {
  if (!schedule) { runsFor = ''; return }
  lastPeekId = schedule.id
  focusReturn.remember(schedule.id)
  if (runsFor === schedule.id) return
  runsFor = schedule.id
  runsLoading.value = true
  runsError.value = false
  scheduleRunList.value = []
  openTaskError.value = ''
  try {
    const result = await scheduleRuns(spaceId.value, schedule.id)
    if (runsFor === schedule.id) scheduleRunList.value = result.runs
  } catch {
    if (runsFor === schedule.id) runsError.value = true
  } finally {
    if (runsFor === schedule.id) runsLoading.value = false
  }
}, { immediate: true })
</script>

<template>
  <section class="view task-schedules-view">
    <div class="mx-auto flex min-h-0 w-full max-w-(--canvas-max) flex-1 flex-col gap-3">
      <p class="page-lede m-0 text-sm text-muted-foreground">{{ t('taskSchedules.lede') }}</p>
      <!-- Toolbar: filters and sort (in the URL), then column choice and actions. -->
      <div class="task-schedules-toolbar flex flex-wrap items-center gap-2">
        <label class="task-schedules-search">
          <span class="ui-sr-only">{{ t('taskSchedules.filter.search') }}</span>
          <input type="search" maxlength="120" :value="tableQuery.search" :placeholder="t('taskSchedules.filter.search')"
            data-schedule-search @input="setTableQuery({ search: ($event.target as HTMLInputElement).value })" />
        </label>
        <UiSelect class="task-schedules-select" :model-value="tableQuery.state" :options="stateOptions" :label="t('taskSchedules.filter.state')"
          data-schedule-state-filter @update:model-value="setTableQuery({ state: $event as ScheduleTableQuery['state'] })" />
        <UiSelect class="task-schedules-select" :model-value="tableQuery.sort" :options="sortOptions" :label="t('taskSchedules.filter.sort')"
          data-schedule-sort @update:model-value="setTableQuery({ sort: $event as ScheduleTableQuery['sort'] })" />
        <div class="ml-auto flex flex-wrap items-center gap-2">
          <GrowthLoading v-if="loading && schedules.length" variant="inline" :label="t('taskSchedules.loading')" />
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <Button variant="outline" size="sm" data-schedule-columns>
                {{ t('taskSchedules.columns.menu') }}<UiIcon name="chevron-down" :size="14" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>{{ t('taskSchedules.columns.menu') }}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuCheckboxItem v-for="column in SCHEDULE_COLUMNS" :key="column.key" :model-value="shows(column.key)"
                :data-schedule-column-toggle="column.key" @update:model-value="chooseColumn(column.key, $event === true)" @select.prevent>
                {{ t(`taskSchedules.columns.${column.key}`) }}
              </DropdownMenuCheckboxItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="ghost" size="sm" :disabled="loading" @click="load">{{ t('taskSchedules.refresh') }}</Button>
          <Button size="sm" data-schedule-new @click="openCreate">{{ t('taskSchedules.new') }}</Button>
        </div>
      </div>
      <p v-if="actionError" role="alert" class="inline-error m-0">{{ actionError }}</p>
      <!-- A failed refresh keeps the rows already read; a failed first read says so in place of the table. -->
      <p v-if="loadError && schedules.length" role="alert" class="inline-error m-0">
        {{ loadError }} <Button size="sm" variant="ghost" @click="load">{{ t('taskSchedules.retryRead') }}</Button>
      </p>

      <!-- The table area is the page's one vertical scroller: the header row
           sticks, and a narrow screen scrolls sideways only inside it. -->
      <div ref="tableArea" class="task-schedules-table-area flex min-h-0 flex-1 flex-col">
        <GrowthLoading v-if="loading && !schedules.length" variant="compact" :label="t('taskSchedules.loading')" />
        <div v-else-if="loadError && !schedules.length" class="ui-empty rounded-lg border bg-card text-destructive" role="alert" data-schedule-load-error>
          <p class="m-0">{{ loadError }}</p>
          <Button class="mt-3" size="sm" variant="outline" @click="load">{{ t('taskSchedules.retryRead') }}</Button>
        </div>
        <div v-else-if="loaded && !schedules.length" class="ui-empty rounded-lg border bg-card" data-schedule-empty>
          <p class="m-0">{{ t('taskSchedules.empty') }}</p>
          <Button class="mt-3" size="sm" @click="openCreate">{{ t('taskSchedules.new') }}</Button>
        </div>
        <Table v-else-if="schedules.length" class="task-schedules-table min-w-[760px]"
          container-class="min-h-0 shrink rounded-lg border bg-card">
          <TableHeader class="sticky top-0 z-[1] bg-card shadow-[0_1px_0_var(--border)] [&_tr]:border-b-0">
            <TableRow class="hover:bg-transparent">
              <TableHead class="min-w-[220px] pl-4">{{ t('taskSchedules.columns.name') }}</TableHead>
              <TableHead v-if="shows('project')">{{ t('taskSchedules.columns.project') }}</TableHead>
              <TableHead v-if="shows('interval')">{{ t('taskSchedules.columns.interval') }}</TableHead>
              <TableHead>{{ t('taskSchedules.columns.state') }}</TableHead>
              <TableHead v-if="shows('next')" :title="t('taskSchedules.nextHint')">{{ t('taskSchedules.columns.next') }}</TableHead>
              <TableHead v-if="shows('startMode')">{{ t('taskSchedules.columns.startMode') }}</TableHead>
              <TableHead v-if="shows('threshold')">{{ t('taskSchedules.columns.threshold') }}</TableHead>
              <TableHead v-if="shows('recent')">{{ t('taskSchedules.columns.recent') }}</TableHead>
              <TableHead class="w-12 pr-4 text-right"><span class="sr-only">{{ t('taskSchedules.columns.actions') }}</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="schedule in rows" :key="schedule.id" :data-schedule-row="schedule.id" :data-return-focus="schedule.id"
              :data-state="peekSchedule?.id === schedule.id ? 'selected' : undefined">
              <TableCell class="pl-4">
                <Button variant="link" class="task-schedule-name h-auto min-h-0 justify-start p-0 text-left text-sm font-semibold whitespace-normal text-foreground hover:text-primary"
                  :title="schedule.body.title" aria-haspopup="dialog" data-schedule-open @click="openPeek(schedule)">
                  <span class="line-clamp-2 [overflow-wrap:anywhere]">{{ schedule.body.title }}</span>
                </Button>
              </TableCell>
              <TableCell v-if="shows('project')" class="max-w-[260px]">
                <span class="line-clamp-2 [overflow-wrap:anywhere]" :title="projectName(schedule.personalProjectId)">{{ projectName(schedule.personalProjectId) }}</span>
              </TableCell>
              <TableCell v-if="shows('interval')" class="whitespace-nowrap">
                {{ t('taskSchedules.every', { count: schedule.body.every.count, unit: t(`taskSchedules.unit.${schedule.body.every.unit}`) }) }}
              </TableCell>
              <TableCell class="whitespace-nowrap">
                <GrowthLoading v-if="busyId === schedule.id" variant="inline" :label="t(schedule.enabled ? 'taskSchedules.pausing' : 'taskSchedules.resuming')" />
                <Badge v-else :variant="stateTone(schedule)">{{ t(`taskSchedules.state.${scheduleState(schedule)}`) }}</Badge>
              </TableCell>
              <TableCell v-if="shows('next')" class="tabular-nums" :title="t('taskSchedules.nextHint')">
                <span class="whitespace-nowrap">{{ formatDate(schedule.nextRunAt) }}</span>
                <span class="block text-xs whitespace-nowrap text-muted-foreground">({{ timeZone }})</span>
              </TableCell>
              <TableCell v-if="shows('startMode')" class="whitespace-nowrap">{{ t(`taskSchedules.startMode.${schedule.body.startMode}`) }}</TableCell>
              <TableCell v-if="shows('threshold')" class="whitespace-nowrap">{{ t('taskSchedules.thresholdCount', { count: schedule.body.failureThreshold }) }}</TableCell>
              <TableCell v-if="shows('recent')" class="text-xs">
                <ul v-if="schedule.recentRuns?.length" class="task-schedule-runs m-0 grid list-none gap-0.5 p-0">
                  <li v-for="run in schedule.recentRuns" :key="run.slot" class="task-schedule-run whitespace-nowrap" :title="run.lastError ?? undefined">
                    <span class="tabular-nums text-muted-foreground">{{ formatDate(run.slot) }}</span> · {{ scheduleRunLabel(run) }}
                  </li>
                </ul>
                <span v-else class="text-muted-foreground">{{ t('taskSchedules.noRuns') }}</span>
              </TableCell>
              <TableCell class="pr-4 text-right">
                <DropdownMenu>
                  <DropdownMenuTrigger as-child>
                    <Button variant="ghost" size="icon-sm" :aria-label="t('taskSchedules.rowActions', { name: schedule.body.title })"
                      :title="t('taskSchedules.columns.actions')" data-schedule-actions>
                      <UiIcon name="more" :size="16" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem data-schedule-runs @select="openPeek(schedule)">{{ t('taskSchedules.details') }}</DropdownMenuItem>
                    <DropdownMenuItem data-schedule-edit @select="openEdit(schedule)">{{ t('taskSchedules.edit') }}</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem v-if="schedule.enabled" :disabled="busyId === schedule.id" data-schedule-pause @select="toggle(schedule, false)">
                      {{ t('taskSchedules.pause') }}
                    </DropdownMenuItem>
                    <DropdownMenuItem v-else :disabled="busyId === schedule.id" data-schedule-resume @select="resumeTarget = schedule">
                      {{ t('taskSchedules.resume') }}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </TableCell>
            </TableRow>
            <TableEmpty v-if="!rows.length" :colspan="9">{{ t('taskSchedules.noMatch') }}</TableEmpty>
          </TableBody>
        </Table>
      </div>
    </div>

    <Dialog :open="Boolean(peek.item.value)" @update:open="peekOpenChange">
      <DialogContent size="lg" data-schedule-peek @open-auto-focus="focusPeekAction" @close-auto-focus="returnFocusFromPeek">
        <SchedulePeek
          :schedule="peekSchedule"
          :missing="peekMissing"
          :project-name="peekSchedule ? projectName(peekSchedule.personalProjectId) : ''"
          :time-zone="timeZone"
          :pausing="busyId === peekSchedule?.id"
          :runs="{ loading: runsLoading, error: runsError, items: scheduleRunList }"
          :opening-task="openingTask"
          :open-task-error="openTaskError"
          @edit="peekSchedule && handOver(() => openEdit(peekSchedule!))"
          @pause="peekSchedule && toggle(peekSchedule, false)"
          @resume="peekSchedule && handOver(() => { resumeTarget = peekSchedule! })"
          @open-task="peekSchedule && openTask(peekSchedule, $event)"
        />
      </DialogContent>
    </Dialog>

    <UiDialog :open="Boolean(resumeTarget)" size="sm" :title="t('taskSchedules.resumeTitle')" :busy="busyId === resumeTarget?.id" @close="resumeTarget = null">
      <p>{{ resumeTarget?.body.title }}</p>
      <p>{{ t('taskSchedules.resumeBody') }}</p>
      <template #footer>
        <Button variant="ghost" :disabled="Boolean(busyId)" @click="resumeTarget = null">{{ t('taskSchedules.form.cancel') }}</Button>
        <Button :loading="Boolean(busyId)" :loading-label="t('taskSchedules.resuming')" data-schedule-resume-confirm
          @click="resumeTarget && toggle(resumeTarget, true)">{{ t('taskSchedules.resumeConfirm') }}</Button>
      </template>
    </UiDialog>

    <UiDialog :open="dialogOpen" form :busy="saving" :error="formError" :title="t(editing ? 'taskSchedules.form.editTitle' : 'taskSchedules.form.title')"
      :description="editing ? undefined : t('taskSchedules.form.description')" @close="dialogOpen = false" @submit="save">
      <dl v-if="createUnknown && submitted" class="task-schedule-submitted" data-schedule-submitted>
        <dt>{{ t('taskSchedules.form.submittedAt') }}</dt><dd>{{ formatDate(submitted.at) }}</dd>
        <dt>{{ t('taskSchedules.form.name') }}</dt><dd>{{ submitted.title }}</dd>
        <dt>{{ t('taskSchedules.form.project') }}</dt><dd>{{ submitted.project }}</dd>
        <dt>{{ t('taskSchedules.form.interval') }}</dt><dd>{{ submitted.every }}</dd>
        <dt>{{ t('taskSchedules.form.startMode') }}</dt><dd>{{ t(`taskSchedules.startMode.${submitted.startMode}`) }}</dd>
        <dt>{{ t('taskSchedules.form.firstRun') }}</dt><dd>{{ formatDate(submitted.firstRunAt) }} ({{ submitted.firstRunAt }})</dd>
      </dl>
      <fieldset class="task-schedule-form" :disabled="createUnknown || saving">
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
          <Button data-schedule-verify @click="verifyCreate">{{ t('taskSchedules.form.verify') }}</Button>
        </template>
        <template v-else>
          <Button variant="ghost" :disabled="saving" @click="dialogOpen = false">{{ t('taskSchedules.form.cancel') }}</Button>
          <Button type="submit" :loading="saving" :loading-label="t('taskSchedules.form.saving')" data-schedule-save>
            {{ editing ? t('taskSchedules.form.saveEdit') : t('taskSchedules.form.save') }}
          </Button>
        </template>
      </template>
    </UiDialog>
  </section>
</template>

<style scoped>
/* The table area scrolls, not the page, so the toolbar and the table's header
   row stay in view without a second scrollbar. */
.task-schedules-view { display: flex; flex-direction: column; overflow: hidden; padding-bottom: 16px; scrollbar-gutter: stable; }
.task-schedules-search { flex: 1 1 220px; max-width: 320px; }
.task-schedules-search input { box-sizing: border-box; width: 100%; }
.task-schedules-view :deep(.task-schedules-select) { flex: 0 0 168px; min-width: 0; }
.task-schedules-table :deep(td), .task-schedules-table :deep(th) { vertical-align: top; }
.task-schedules-table :deep(td) { padding-block: 12px; }
.task-schedules-table :deep(th) { vertical-align: middle; }
.task-schedule-name:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
.task-schedule-form { display: grid; gap: 12px; margin: 0; padding: 0; border: 0; }
.task-schedule-planned { margin: 0; font-size: 13px; }
.task-schedule-interval { display: flex; flex-wrap: wrap; gap: 8px; align-items: end; margin: 0; padding: 0; border: 0; }
.task-schedule-interval input { width: 96px; min-height: 36px; }
.task-schedule-start { display: grid; gap: 6px; margin: 0; padding: 0; border: 0; }
.task-schedule-start label { display: flex; gap: 8px; align-items: center; min-height: 32px; }
.task-schedule-first { display: grid; gap: 4px; }
.task-schedule-submitted { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 4px 12px; margin: 0 0 12px; font-size: 13px; }
.task-schedule-submitted dt { color: var(--color-muted); }
.task-schedule-submitted dd { margin: 0; overflow-wrap: anywhere; }
</style>
