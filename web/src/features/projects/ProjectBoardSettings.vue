<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch, type ObjectDirective } from 'vue'
import { RouterLink } from 'vue-router'

import { ApiError, apiErrorCode } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import type { ProjectBoardRecord } from '@/features/employees/project-board-layout'
import { EMPLOYEE_BOARD_STATUSES } from '@/features/employees/task-board-model'
import { t } from '@/i18n'
import { UiIconButton, UiNotice } from '@/ui'
import { bindColumnRow, monitorColumnReorder } from './board-column-dnd'
import {
  boardFromDraft, builtinDraftColumns, draftFromRecord, draftProblem, managerCandidates, moveDraftColumn, newDraftColumn,
  projectBoardErrorMessage, readProjectBoard, recruitProjectManager, saveProjectBoard, type BoardDraft,
} from './project-board-settings'
import { readProjectTeam, type ProjectTeam } from './project-team-api'
import { OptionSelect } from '@/components/ui/select'
import { OptionCombobox } from '@/components/ui/combobox'

// 项目看板 on the project page: the project's own project manager and its
// board (the person's columns, each standing for a built-in status, or an
// external board link). Jefa stays the global lead either way.
const props = defineProps<{ spaceId: string; projectId: string; projectName: string }>()

type Pending = 'loading' | 'saving' | 'recruiting'
const record = ref<ProjectBoardRecord | null>(null)
const team = ref<ProjectTeam | null>(null)
const draft = ref<BoardDraft>({ kind: 'builtin', columns: [], url: '', label: '' })
const managerId = ref('')
const pending = ref<Pending | null>(null)
const error = ref('')
const notice = ref('')
const notManaged = ref(false)
const recruitOpen = ref(false)
const recruitName = ref('')
const listId = Symbol('project-board-columns')
let sequence = 0

const JEFA = ''
const candidates = computed(() => managerCandidates(team.value))
const managerOptions = computed(() => [
  { value: JEFA, label: t('employees.projectBoard.managerJefa') },
  ...candidates.value.map((person) => ({ value: person.agentId, label: person.name })),
])
// The saved manager whose assignment ended since: named, so the person chooses again.
const goneManager = computed(() => {
  const id = record.value?.managerAgentId
  return id && team.value && !candidates.value.some((person) => person.agentId === id) ? id : null
})
const statusOptions = computed(() => EMPLOYEE_BOARD_STATUSES.map(({ value, labelKey }) => ({ value, label: t(labelKey) })))
const pendingLabel = computed(() => pending.value ? t(`employees.projectBoard.${pending.value}`) : '')
const busy = computed(() => pending.value !== null)
const boardTo = computed(() => ({ path: '/employees/jefa', query: { project: props.projectId } }))

watch(() => [props.spaceId, props.projectId], () => { void load() }, { immediate: true })

function apply(value: ProjectBoardRecord) {
  record.value = value
  draft.value = draftFromRecord(value)
  managerId.value = value.managerAgentId ?? JEFA
}

async function load() {
  if (!props.spaceId || !props.projectId) return
  const current = ++sequence
  pending.value = 'loading'
  error.value = ''
  notManaged.value = false
  try {
    const [board, people] = await Promise.all([readProjectBoard(props.spaceId, props.projectId), readProjectTeam(props.spaceId, props.projectId)])
    if (current !== sequence) return
    team.value = people
    apply(board)
  } catch (cause) {
    if (current !== sequence) return
    record.value = null
    if (cause instanceof ApiError && cause.status === 403 && apiErrorCode(cause) === 'assignment_required') notManaged.value = true
    else error.value = projectBoardErrorMessage(cause)
  } finally {
    if (current === sequence) pending.value = null
  }
}

function problem() {
  const key = draftProblem(draft.value)
  error.value = key ? t(key) : ''
  return Boolean(key)
}

async function save() {
  if (!record.value || busy.value || problem()) return
  pending.value = 'saving'
  notice.value = ''
  try {
    apply(await saveProjectBoard(props.spaceId, props.projectId, {
      expectedRevision: record.value.revision, managerAgentId: managerId.value || null, board: boardFromDraft(draft.value),
    }))
    notice.value = t('employees.projectBoard.saved')
  } catch (cause) {
    const message = projectBoardErrorMessage(cause)
    pending.value = null
    if (apiErrorCode(cause) === 'version_conflict') await load()
    error.value = message
  } finally {
    if (pending.value === 'saving') pending.value = null
  }
}

function openRecruit() {
  recruitName.value = t('employees.projectBoard.recruitDefaultName', { project: props.projectName })
  recruitOpen.value = true
}

async function recruit() {
  const name = recruitName.value.trim()
  if (!name || busy.value || problem()) return
  pending.value = 'recruiting'
  notice.value = ''
  try {
    await recruitProjectManager({ personalSpaceId: props.spaceId, projectId: props.projectId, projectName: props.projectName,
      name, board: boardFromDraft(draft.value) })
    recruitOpen.value = false
    pending.value = null
    await load()
    notice.value = t('employees.projectBoard.saved')
  } catch (cause) {
    error.value = projectBoardErrorMessage(cause)
  } finally {
    if (pending.value === 'recruiting') pending.value = null
  }
}

function chooseKind(kind: unknown) {
  if (kind === 'builtin' || kind === 'external') draft.value = { ...draft.value, kind }
}
function startFromDefaults() { draft.value = { ...draft.value, columns: builtinDraftColumns() } }
function addColumn() { draft.value = { ...draft.value, columns: [...draft.value.columns, newDraftColumn()] } }
function removeColumn(index: number) { draft.value = { ...draft.value, columns: draft.value.columns.filter((_, at) => at !== index) } }
function moveColumn(from: number, to: number) {
  if (to < 0 || to >= draft.value.columns.length) return
  draft.value = { ...draft.value, columns: moveDraftColumn(draft.value.columns, from, to) }
}

const boundRows = new WeakMap<HTMLElement, { row: { index: number }; cleanup: () => void }>()
const vColumnRow: ObjectDirective<HTMLElement, number> = {
  mounted(element, { value }) {
    const handle = element.querySelector<HTMLElement>('[data-column-handle]')
    if (!handle) return
    const row = { index: value }
    boundRows.set(element, { row, cleanup: bindColumnRow({ listId, element, handle, row }) })
  },
  updated(element, { value }) { const bound = boundRows.get(element); if (bound) bound.row.index = value },
  beforeUnmount(element) { boundRows.get(element)?.cleanup(); boundRows.delete(element) },
}
let stopMonitor = () => {}
onMounted(() => { stopMonitor = monitorColumnReorder({ listId, onReorder: moveColumn }) })
onBeforeUnmount(() => stopMonitor())
</script>

<template>
  <section class="project-board-settings" aria-labelledby="project-board-heading" data-project-board-settings>
    <header class="project-board-header">
      <h3 id="project-board-heading">{{ t('employees.projectBoard.title') }}</h3>
      <RouterLink class="project-board-open" :to="boardTo">{{ t('employees.projectBoard.openBoard') }}</RouterLink>
    </header>

    <GrowthLoading v-if="pending === 'loading' && !record" variant="compact" :label="pendingLabel" />
    <p v-else-if="notManaged" class="project-board-state" role="status" data-project-board-not-managed>{{ t('employees.projectBoard.notManaged') }}</p>
    <div v-else-if="!record" class="project-board-state" role="alert">
      <p>{{ error }}</p>
      <Button size="sm" variant="ghost" @click="load">{{ t('employees.retry') }}</Button>
    </div>

    <form v-else class="project-board-form" @submit.prevent="save">
      <div class="project-board-manager">
        <OptionCombobox v-model="managerId" field size="sm" name="project-board-manager" :label="t('employees.projectBoard.manager')"
          :options="managerOptions" :disabled="busy" />
        <p class="ui-meta">{{ t('employees.projectBoard.managerHint') }}</p>
        <UiNotice v-if="goneManager" tone="warning" data-manager-gone>
          {{ t('employees.projectBoard.managerGone', { name: goneManager }) }}
        </UiNotice>
        <Button v-if="!recruitOpen" type="button" size="sm" variant="outline" :disabled="busy" data-action="open-recruit" @click="openRecruit">
          {{ t('employees.projectBoard.recruit') }}
        </Button>
        <div v-else class="project-board-recruit">
          <label class="project-board-field">
            <span>{{ t('employees.projectBoard.recruitName') }}</span>
            <Input v-model="recruitName" maxlength="160" :disabled="busy" data-recruit-name />
          </label>
          <Button type="button" :disabled="!recruitName.trim() || busy" :loading="pending === 'recruiting'" :loading-label="pendingLabel"
            data-action="recruit" @click="recruit">
            {{ t('employees.projectBoard.recruitConfirm') }}
          </Button>
          <Button type="button" variant="ghost" :disabled="busy" @click="recruitOpen = false">{{ t('employees.projectBoard.recruitCancel') }}</Button>
        </div>
      </div>

      <div class="project-board-kind">
        <span id="project-board-kind-label" class="project-board-label">{{ t('employees.projectBoard.kind') }}</span>
        <RadioGroup :model-value="draft.kind" aria-labelledby="project-board-kind-label" class="project-board-kinds" :disabled="busy"
          @update:model-value="chooseKind">
          <label v-for="kind in (['builtin', 'external'] as const)" :key="kind" class="project-board-kind-option" :data-board-kind="kind">
            <RadioGroupItem :value="kind" />
            <span>{{ t(kind === 'builtin' ? 'employees.projectBoard.kindBuiltin' : 'employees.projectBoard.kindExternal') }}</span>
          </label>
        </RadioGroup>
      </div>

      <div v-if="draft.kind === 'builtin'" class="project-board-columns">
        <p class="ui-meta">{{ t('employees.projectBoard.columnsHint') }}</p>
        <div v-if="!draft.columns.length" class="project-board-empty">
          <span class="ui-meta">{{ t('employees.projectBoard.defaultColumns') }}</span>
          <Button type="button" size="sm" variant="outline" :disabled="busy" data-action="start-defaults" @click="startFromDefaults">
            {{ t('employees.projectBoard.startFromDefaults') }}
          </Button>
        </div>
        <ol v-else class="project-board-column-list" :aria-label="t('employees.projectBoard.columns')">
          <li v-for="(column, index) in draft.columns" :key="column.key" v-column-row="index" class="project-board-column" :data-column-row="index">
            <Button type="button" variant="ghost" size="icon-sm" class="project-board-handle" data-column-handle :disabled="busy"
              :aria-label="t('employees.projectBoard.dragColumn', { label: column.label })" :title="t('employees.projectBoard.dragColumn', { label: column.label })">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="5" cy="4" r="1" /><circle cx="11" cy="4" r="1" /><circle cx="5" cy="8" r="1" /><circle cx="11" cy="8" r="1" /><circle cx="5" cy="12" r="1" /><circle cx="11" cy="12" r="1" /></svg>
            </Button>
            <Input v-model="column.label" size="sm" class="project-board-column-label" maxlength="40" :disabled="busy"
              :aria-label="t('employees.projectBoard.columnLabel')" data-column-label />
            <OptionSelect v-model="column.mapsTo" size="sm" :name="`project-board-maps-to-${index}`" :label="t('employees.projectBoard.columnMapsTo')"
              :options="statusOptions" :disabled="busy" />
            <span class="project-board-column-actions">
              <UiIconButton icon="chevron-up" size="sm" :label="t('employees.projectBoard.moveUp', { label: column.label })" :disabled="busy || index === 0"
                @click="moveColumn(index, index - 1)" />
              <UiIconButton icon="chevron-down" size="sm" :label="t('employees.projectBoard.moveDown', { label: column.label })"
                :disabled="busy || index === draft.columns.length - 1" @click="moveColumn(index, index + 1)" />
              <UiIconButton icon="close" size="sm" :label="t('employees.projectBoard.removeColumn', { label: column.label })" :disabled="busy"
                data-action="remove-column" @click="removeColumn(index)" />
            </span>
          </li>
        </ol>
        <Button v-if="draft.columns.length && draft.columns.length < 12" type="button" size="sm" variant="ghost" :disabled="busy"
          data-action="add-column" @click="addColumn">+ {{ t('employees.projectBoard.addColumn') }}</Button>
      </div>

      <div v-else class="project-board-external">
        <label class="project-board-field">
          <span>{{ t('employees.projectBoard.externalUrl') }}</span>
          <Input v-model="draft.url" type="url" inputmode="url" maxlength="2048" placeholder="https://" :disabled="busy" data-external-url />
        </label>
        <label class="project-board-field">
          <span>{{ t('employees.projectBoard.externalLabel') }}</span>
          <Input v-model="draft.label" maxlength="80" :disabled="busy" data-external-label />
        </label>
      </div>

      <div class="project-board-footer">
        <p v-if="error" class="project-board-error" role="alert">{{ error }}</p>
        <p v-else-if="notice" class="ui-meta" role="status">{{ notice }}</p>
        <Button type="submit" size="sm" :disabled="busy" :loading="pending === 'saving'" :loading-label="pendingLabel" data-action="save-board">
          {{ t('employees.projectBoard.save') }}
        </Button>
      </div>
      <GrowthLoading v-if="pending === 'loading'" variant="inline" :label="pendingLabel" />
    </form>
  </section>
</template>

<style scoped>
.project-board-settings { display: grid; gap: 12px; min-width: 0; }
.project-board-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.project-board-header h3 { margin: 0; font-size: 15px; font-weight: 600; }
.project-board-open { color: var(--color-accent); font-size: 13px; }
.project-board-state { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 0; color: var(--color-muted); font-size: 13px; line-height: 1.6; }
.project-board-state p { margin: 0; }
.project-board-form { display: grid; gap: 16px; }
.project-board-manager { display: grid; gap: 8px; justify-items: start; }
.project-board-manager > :first-child { width: min(100%, 360px); }
.project-board-manager p { margin: 0; }
.project-board-recruit { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 8px; }
.project-board-field { display: grid; gap: 5px; min-width: min(100%, 260px); color: var(--color-ink); font-size: 12px; }
.project-board-label { color: var(--color-ink); font-size: 12px; }
.project-board-kind { display: grid; gap: 6px; }
.project-board-kinds { display: flex; flex-wrap: wrap; gap: 8px 18px; }
.project-board-kind-option { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer; }
.project-board-columns { display: grid; gap: 8px; }
.project-board-columns > p { margin: 0; }
.project-board-empty { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.project-board-column-list { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
/* Each row is a small card; nothing marks it with a side bar. */
.project-board-column { display: grid; grid-template-columns: auto minmax(120px, 1fr) minmax(130px, 180px) auto; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 10px; background: var(--color-surface-subtle); }
.project-board-handle { color: var(--color-muted); cursor: grab; touch-action: none; }
.project-board-column-actions { display: inline-flex; gap: 2px; }
.project-board-external { display: flex; flex-wrap: wrap; gap: 12px; }
.project-board-external .project-board-field:first-child { flex: 1 1 320px; }
.project-board-footer { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 12px; }
.project-board-footer p { margin: 0 auto 0 0; }
.project-board-error { color: var(--color-danger); font-size: 13px; }
@media (max-width: 640px) {
  .project-board-column { grid-template-columns: auto minmax(0, 1fr); }
  .project-board-column > :nth-child(3), .project-board-column-actions { grid-column: 2; }
}
</style>
