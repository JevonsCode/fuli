<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { postJson } from '@/api/client'
import SearchableSelect from '@/components/SearchableSelect.vue'
import ProjectScopePicker from './ProjectScopePicker.vue'
import { employeeAvatarUrl } from './avatars'
import { useModalDialog } from '@/composables/useModalDialog'
import { t } from '@/i18n'
import { personalProjectsPath } from '@/router/paths'
import type { PersonalProject } from '@/types'
import {
  employeeTemplates, employeeCatalogLoading, employeeCatalogError,
  refreshEmployeeCatalog, employeeErrorMessage, type EmployeeRecruitmentResult,
} from './catalog'

const props = defineProps<{
  open: boolean
  personalSpaceId: string
  projects: PersonalProject[]
  defaultProjectId?: string
  defaultProjectIds?: string[]
  templateId?: string
}>()
const emit = defineEmits<{ close: []; recruited: [result: EmployeeRecruitmentResult] }>()
const projectIds = ref<string[]>([])
const baselineProjectIds = ref<string[]>([])
const scopeMode = ref<'all' | 'selected'>('selected')
const excludedIds = ref<string[]>([])
const titleMode = ref('auto')
const titleStyle = ref('emoji')
const baselinePolicy = ref('')
const expectedVersion = ref('')
const selectionLoading = ref(false)
const requiresReload = ref(false)
const templateId = ref('')
const busy = ref(false)
const error = ref('')
const success = ref<EmployeeRecruitmentResult | null>(null)
const { dialogRef, initialFocusRef, onCancel, onKeydown } = useModalDialog(() => props.open, close)
const selected = computed(() => props.templateId
  ? employeeTemplates.value.find((entry) => entry.id === props.templateId)
  : employeeTemplates.value.find((entry) => entry.id === templateId.value) ?? employeeTemplates.value[0])
const title = computed(() => selected.value?.agentId
  ? t('employees.manageProjectsTitle', { name: selected.value.name }) : t('employees.recruit'))
const projectOptions = computed(() => props.projects.filter((project) => project.profile.lifecycle !== 'archived')
  .map((project) => ({ id: project.project_id, name: project.profile.name })))
const supportsPolicy = computed(() => selected.value?.management !== undefined)
const selectionIds = computed({
  get: () => scopeMode.value === 'all'
    ? projectOptions.value.filter(project => !excludedIds.value.includes(project.id)).map(project => project.id) : projectIds.value,
  set: (ids: string[]) => {
    if (scopeMode.value === 'all') {
      const available = new Set(projectOptions.value.map(project => project.id))
      excludedIds.value = [...excludedIds.value.filter(id => !available.has(id)), ...projectOptions.value.filter(project => !ids.includes(project.id)).map(project => project.id)]
    } else projectIds.value = ids
  },
})
const draftPolicy = computed(() => ({ mode: scopeMode.value,
  projectIds: scopeMode.value === 'selected' ? [...projectIds.value].sort() : [],
  excludedProjectIds: scopeMode.value === 'all' ? [...excludedIds.value].sort() : [],
  titleMode: titleMode.value, titleStyle: titleStyle.value,
}))
const titleModeOptions = computed(() => ['auto', 'suggest', 'off'].map(value => ({ value, label: t(`employees.titles.${value}`) })))
const titleStyleOptions = computed(() => ['emoji', 'text'].map(value => ({ value, label: t(`employees.titles.${value}`) })))
const assignedIds = computed(() => new Set(baselineProjectIds.value))
const removals = computed(() => [...assignedIds.value].filter((id) => !selectionIds.value.includes(id)))
const reactivating = computed(() => Boolean(selected.value?.agentStatus && selected.value.agentStatus !== 'active'))
const noChange = computed(() => selected.value?.agentStatus === 'active' && (supportsPolicy.value
  ? JSON.stringify(draftPolicy.value) === baselinePolicy.value && (scopeMode.value === 'all'
    || (projectIds.value.length === assignedIds.value.size && projectIds.value.every(id => assignedIds.value.has(id))))
  : projectIds.value.length === assignedIds.value.size && projectIds.value.every((id) => assignedIds.value.has(id))))
const actionLabel = computed(() => {
  if (busy.value) return t('employees.recruiting')
  if (reactivating.value) return t('employees.rehire', { name: selected.value?.name ?? '' })
  if (noChange.value) return t('employees.assign')
  if (selected.value?.agentId) return t('employees.assign')
  return t('employees.recruitName', { name: selected.value?.name ?? '' })
})
const workbenchLink = computed(() => selected.value && selectionIds.value.length
  ? `/employees/${encodeURIComponent(selected.value.id)}?project=${encodeURIComponent(selectionIds.value[0]!)}` : '')

let loadVersion = 0
watch([() => props.open, () => props.personalSpaceId, () => props.templateId], ([open]) => {
  loadVersion += 1
  if (!open) return
  void reloadSelection(true)
}, { immediate: true })
watch(templateId, () => { if (props.open && !selectionLoading.value) initializeSelection(true) })
watch(draftPolicy, () => { error.value = requiresReload.value ? error.value : ''; success.value = null }, { flush: 'sync' })

function initializeSelection(includeDefault = false) {
  const available = new Set(projectOptions.value.map((project) => project.id))
  baselineProjectIds.value = [...new Set((selected.value?.assignments ?? [])
    .filter((entry) => entry.status === 'active' && available.has(entry.personalProjectId))
    .map((entry) => entry.personalProjectId))]
  // Viewing a project filter must never silently extend an existing employee's permissions.
  const defaults = includeDefault && !selected.value?.agentId
    ? props.defaultProjectIds ?? (props.defaultProjectId ? [props.defaultProjectId] : []) : []
  projectIds.value = [...new Set([...baselineProjectIds.value, ...defaults.filter((id) => available.has(id))])]
  const management = selected.value?.management
  scopeMode.value = management?.mode ?? 'selected'
  excludedIds.value = [...(management?.excludedProjectIds ?? [])]
  titleMode.value = management?.titleMode ?? 'auto'
  titleStyle.value = management?.titleStyle ?? 'emoji'
  if (management?.mode === 'selected' && selected.value?.agentId) projectIds.value = management.projectIds.filter(id => available.has(id))
  if (management?.mode === 'all' && selected.value?.agentId) baselineProjectIds.value = [...selectionIds.value]
  baselinePolicy.value = JSON.stringify(draftPolicy.value)
  expectedVersion.value = selected.value?.assignmentsVersion ?? ''
  requiresReload.value = false
  error.value = ''
  success.value = null
}

async function reloadSelection(includeDefault = false) {
  const current = ++loadVersion
  selectionLoading.value = true
  await refreshEmployeeCatalog(props.personalSpaceId)
  if (current !== loadVersion || !props.open) return
  if (!employeeCatalogError.value) initializeSelection(includeDefault)
  selectionLoading.value = false
}

function close() { if (!busy.value) emit('close') }
async function recruit() {
  if (!selected.value || selected.value.identityConflict || !props.personalSpaceId
    || busy.value || selectionLoading.value || requiresReload.value || !expectedVersion.value || noChange.value) return
  busy.value = true
  error.value = ''
  const id = selected.value.id
  try {
    const result = await postJson<EmployeeRecruitmentResult>(`/api/employee-templates/${encodeURIComponent(id)}/recruit`, {
      personalSpaceId: props.personalSpaceId,
      ...(supportsPolicy.value ? { management: draftPolicy.value } : { personalProjectIds: [...projectIds.value] }),
      replaceAssignments: true,
      expectedAssignmentsVersion: expectedVersion.value,
      ...(reactivating.value ? { reactivate: true } : {}),
    })
    await refreshEmployeeCatalog(props.personalSpaceId)
    initializeSelection()
    success.value = result
    emit('recruited', result)
  } catch (cause) {
    error.value = employeeErrorMessage(cause)
    try {
      const body = JSON.parse(cause instanceof Error ? cause.message : '') as { code?: string }
      requiresReload.value = body.code === 'assignment_scope_conflict' || body.code === 'assignment_update_incomplete'
    } catch { /* Non-API errors can be retried without replacing the selection. */ }
  }
  finally { busy.value = false }
}
function changeScope(mode: 'all' | 'selected') {
  if (mode === 'selected') projectIds.value = [...selectionIds.value]
  scopeMode.value = mode
}
function scopeKeydown(event: KeyboardEvent) {
  if (busy.value || selectionLoading.value || requiresReload.value) return
  if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
    event.preventDefault()
    const mode = event.key === 'Home' ? 'all' : event.key === 'End' ? 'selected' : scopeMode.value === 'all' ? 'selected' : 'all'
    changeScope(mode)
    ;(event.currentTarget as HTMLElement).querySelector<HTMLButtonElement>(`[data-scope="${mode}"]`)?.focus()
  }
}
</script>

<template>
  <dialog v-if="open" ref="dialogRef" class="employee-recruit-dialog" aria-modal="true" aria-labelledby="employee-recruit-title" @cancel="onCancel" @keydown="onKeydown">
    <header class="employee-recruit-heading">
      <h2 id="employee-recruit-title">{{ title }}</h2>
      <button ref="initialFocusRef" type="button" class="quiet-button" :disabled="busy" @click="close">{{ t('employees.close') }}</button>
    </header>
    <p v-if="employeeCatalogLoading && !employeeTemplates.length" role="status">{{ t('employees.loading') }}</p>
    <div v-else-if="employeeCatalogError" role="alert" class="employee-message">
      <p>{{ employeeCatalogError }}</p>
      <button class="quiet-button" type="button" @click="reloadSelection(true)">{{ t('employees.retry') }}</button>
    </div>
    <p v-else-if="!selected">{{ t('employees.noTemplates') }}</p>
    <form v-else @submit.prevent="recruit">
      <div class="employee-recruit-body">
      <div v-if="employeeTemplates.length > 1 && !props.templateId" class="employee-picker-field">
        <span>{{ t('employees.choose') }}</span>
        <SearchableSelect v-model="templateId" control-id="employee-template" :label="t('employees.choose')" :options="employeeTemplates.map((entry) => ({ value: entry.id, label: entry.name, meta: entry.role }))" :disabled="busy || selectionLoading" />
      </div>
      <div class="employee-profile">
        <span class="employee-avatar" aria-hidden="true">
          <img v-if="employeeAvatarUrl(selected.id)" :src="employeeAvatarUrl(selected.id)" alt="" />
          <template v-else>{{ selected.name.slice(0, 1) }}</template>
        </span>
        <div><h3>{{ selected.name }} <span>{{ selected.role }}</span></h3><p>{{ selected.description }}</p></div>
      </div>
      <p class="employee-specialties">{{ selected.capabilities.join(' · ') }}</p>
      <p v-if="selectionLoading" class="employee-muted" role="status">{{ t('employees.loadingScope') }}</p>
      <div v-if="supportsPolicy" class="employee-scope-mode" role="radiogroup" :aria-label="t('employees.scope.rule')" @keydown="scopeKeydown">
        <button v-for="mode in (['all', 'selected'] as const)" :key="mode" type="button" role="radio" :data-scope="mode" :aria-checked="scopeMode === mode" :tabindex="scopeMode === mode ? 0 : -1" :disabled="busy || selectionLoading || requiresReload" @click="changeScope(mode)">
          {{ t(`employees.scope.${mode === 'all' ? 'continuousAll' : 'onlySelected'}`) }}
        </button>
      </div>
      <p v-if="supportsPolicy" class="employee-scope-rule" role="status">{{ scopeMode === 'all' ? t('employees.scope.allHint', { name: selected.name }) : t('employees.scope.selectedHint') }}</p>
      <ProjectScopePicker v-model="selectionIds" :projects="projectOptions" inline :hint="scopeMode === 'all' ? t('employees.scope.excludeHint') : undefined" :disabled="busy || selectionLoading || requiresReload" />
      <p v-if="scopeMode === 'all' && excludedIds.length" class="employee-muted">{{ t('employees.scope.excludedCount', { count: excludedIds.length }) }}</p>
      <p v-if="!projectOptions.length" class="employee-muted">{{ t('employees.noProjects') }} <RouterLink :to="personalProjectsPath(personalSpaceId, 'directory')" @click="close">{{ t('employees.createProject') }}</RouterLink></p>
      <p v-if="removals.length && !success" class="employee-muted">{{ t('employees.scopeRemoved', { count: removals.length }) }}</p>
      <section v-if="supportsPolicy && selected.permissions.includes('session.title')" class="employee-title-settings" :aria-label="t('employees.titles.heading')">
        <h3>{{ t('employees.titles.heading') }}</h3>
        <div class="employee-title-controls">
          <div class="employee-picker-field"><span>{{ t('employees.titles.mode') }}</span><SearchableSelect v-model="titleMode" control-id="employee-title-mode" :label="t('employees.titles.mode')" :options="titleModeOptions" :disabled="busy || selectionLoading || requiresReload" /></div>
          <div class="employee-picker-field"><span>{{ t('employees.titles.style') }}</span><SearchableSelect v-model="titleStyle" control-id="employee-title-style" :label="t('employees.titles.style')" :options="titleStyleOptions" :disabled="busy || selectionLoading || requiresReload || titleMode === 'off'" /></div>
        </div>
        <p class="employee-title-preview">{{ t('employees.titles.example') }} <span>【P1｜{{ titleStyle === 'emoji' ? '🔧 ' : '' }}FIX｜{{ t('employees.titles.exampleTask') }}】</span></p>
        <p class="employee-muted">{{ t('employees.titles.boundary') }}</p>
      </section>
      <section class="employee-permissions" :aria-label="t('employees.permissions')">
        <strong>{{ t('employees.permissions') }}</strong>
        <ul><li v-for="permission in selected.permissions" :key="permission">{{ permission === 'board.read' ? t('employees.boardRead') : permission === 'board.write' ? t('employees.boardWrite') : permission === 'session.title' ? t('employees.titles.heading') : permission }}</li></ul>
        <p>{{ t('employees.noExecutor') }}</p>
      </section>
      <p v-if="selected.runtime" class="employee-runtime" :class="{ 'is-warning': selected.runtimeStatus !== 'ready' }">{{ selected.runtimeStatus === 'ready' ? t('employees.hostReady') : t('employees.installRequired') }}</p>
      <p v-if="error || selected.identityConflict" class="employee-error" role="alert">{{ error || t('employees.errors.identity_conflict') }}</p>
      <button v-if="requiresReload" type="button" class="quiet-button" :disabled="selectionLoading" @click="reloadSelection()">{{ t('employees.reloadScope') }}</button>
      <div v-if="success" class="employee-success" role="status">
        <strong>{{ t('employees.scopeSaved') }}</strong>
        <p>{{ scopeMode === 'all' ? t('employees.scope.successAll', { count: selectionIds.length }) : selectionIds.length ? t('employees.successMultiple', { count: selectionIds.length }) : t('employees.successUnassigned') }}</p>
      </div>
      </div>
      <footer class="employee-recruit-actions">
        <button class="quiet-button" type="button" :disabled="busy" @click="close">{{ t('employees.cancel') }}</button>
        <RouterLink v-if="noChange && workbenchLink && !busy && !selectionLoading && !requiresReload && selected.runtimeStatus === 'ready'" class="employee-primary" :to="workbenchLink" @click="close">{{ t('employees.open') }}</RouterLink>
        <button v-else class="employee-primary" type="submit" :disabled="busy || selectionLoading || requiresReload || !expectedVersion || noChange || selected.identityConflict || !personalSpaceId">{{ actionLabel }}</button>
      </footer>
    </form>
  </dialog>
</template>

<style scoped>
.employee-recruit-dialog { width: min(560px, calc(100vw - 32px)); max-height: calc(100dvh - 48px); margin: auto; padding: 0; overflow: hidden; border: 0; border-radius: 16px; background: #fff; color: #25392e; box-shadow: 0 20px 70px #12291c30; font-size: 14px; line-height: 1.6; }
.employee-recruit-dialog[open] { display: flex; flex-direction: column; }
.employee-recruit-dialog > form { display: flex; flex-direction: column; min-height: 0; }
.employee-recruit-body { min-height: 0; padding: 0 28px 20px; overflow-y: auto; overscroll-behavior: contain; }
.employee-recruit-dialog > :is(p, .employee-message) { margin: 0 28px 28px; }
.employee-recruit-dialog::backdrop { background: #14291f52; }
.employee-recruit-heading { display: flex; flex: 0 0 auto; justify-content: space-between; align-items: center; gap: 16px; padding: 22px 28px; }
.employee-recruit-heading h2 { margin: 0; font-size: 20px; line-height: 1.4; }
.employee-profile { display: flex; align-items: center; gap: 16px; margin-bottom: 12px; }
.employee-profile h3 { margin: 0 0 4px; font-size: 21px; line-height: 1.35; }
.employee-profile h3 span { display: inline-block; margin-left: 8px; color: #5a6960; font-size: 13px; font-weight: 500; }
.employee-profile p, .employee-success p { margin: 0; color: #536259; }
.employee-avatar { display: grid; flex: 0 0 52px; height: 52px; place-items: center; overflow: hidden; border-radius: 14px; background: #e7eee9; color: #315c43; font-size: 27px; font-weight: 650; }
.employee-avatar img { width: 100%; height: 100%; object-fit: cover; }
.employee-specialties { margin: 0 0 24px; color: #59695f; font-size: 12px; }
.employee-scope-mode { display: flex; gap: 4px; padding: 4px; margin: 0 0 10px; border-radius: 10px; background: #f0f3f1; }
.employee-scope-mode button { flex: 1; min-height: 40px; padding: 8px 10px; border: 0; border-radius: 7px; background: transparent; color: #52645a; font: inherit; font-size: 13px; cursor: pointer; }
.employee-scope-mode button[aria-checked="true"] { background: #fff; color: #294f39; font-weight: 600; box-shadow: 0 1px 3px #142b1e17; }
.employee-scope-mode button:hover:not(:disabled) { color: #234c34; background: #e6eee8; }
.employee-scope-mode button:focus-visible { outline: 2px solid #356448; outline-offset: 2px; }
.employee-scope-mode button:disabled { opacity: .55; cursor: default; }
.employee-scope-rule { margin: 0 0 16px; color: #526259; font-size: 13px; }
.employee-title-settings { margin-top: 24px; }
.employee-title-settings h3 { margin: 0 0 12px; font-size: 14px; font-weight: 600; }
.employee-title-controls { display: grid; grid-template-columns: 1.2fr 1fr; gap: 12px; }
.employee-title-controls .employee-picker-field { min-width: 0; margin-bottom: 8px; }
.employee-title-preview { margin: 4px 0 0; color: #5a685f; font-size: 12px; overflow-wrap: anywhere; }
.employee-title-preview span { color: #304c3b; }
.employee-picker-field { display: grid; gap: 7px; margin-bottom: 18px; color: #33483c; font-size: 13px; }
.employee-picker-field :deep(.searchable-select) { width: 100%; }
.employee-picker-field :deep(.searchable-select-trigger) { width: 100%; min-height: 42px; }
.employee-title-controls :deep(.searchable-select-panel) { width: 100%; min-width: 0; box-sizing: border-box; }
.employee-title-controls :deep(.searchable-select-option-copy strong) { white-space: normal; overflow-wrap: anywhere; }
.employee-permissions { margin-top: 20px; font-size: 12px; }
.employee-permissions strong { color: #33483c; font-weight: 600; }
.employee-permissions ul { display: flex; flex-wrap: wrap; gap: 4px 18px; padding-left: 16px; margin: 6px 0; }
.employee-permissions p, .employee-muted { margin-top: 8px; color: #58675d; font-size: 12px; }
.employee-runtime { margin: 20px 0 0; color: #356448; font-size: 12px; }
.employee-runtime.is-warning { color: #80501e; }
.employee-error { margin-top: 16px; color: #a13e37; }
.employee-success { margin-top: 18px; color: #306344; }
.employee-recruit-actions { display: flex; flex: 0 0 auto; align-items: center; justify-content: flex-end; gap: 12px; padding: 16px 28px; background: #f7f9f7; }
.employee-recruit-dialog .quiet-button { min-height: 40px; padding: 8px 12px; border: 0; border-radius: 8px; background: transparent; color: #536259; font: inherit; font-size: 13px; cursor: pointer; }
.employee-recruit-dialog .quiet-button:hover:not(:disabled) { background: #edf2ee; }
.employee-recruit-dialog .quiet-button:focus-visible { outline: 2px solid #356448; outline-offset: 2px; }
.employee-primary { display: inline-flex; justify-content: center; align-items: center; min-height: 42px; padding: 9px 20px; border: 0; border-radius: 9px; background: #315c43; color: #fff; font: inherit; font-weight: 600; text-decoration: none; cursor: pointer; }
.employee-primary:hover:not(:disabled) { background: #244b34; }
.employee-primary:disabled { background: #e1e7e3; color: #59675e; cursor: default; }
.employee-primary:focus-visible, .employee-recruit-dialog a:focus-visible { outline: 2px solid #356448; outline-offset: 3px; }
.employee-message { display: grid; gap: 12px; justify-items: start; }
@media (max-width: 540px) { .employee-recruit-heading { padding: 18px 20px; }.employee-recruit-body { padding: 0 20px 18px; }.employee-recruit-actions { padding: 14px 20px; }.employee-recruit-actions .employee-primary { flex: 1; }.employee-profile { align-items: flex-start; }.employee-profile h3 span { display: block; margin: 2px 0 0; }.employee-title-controls { grid-template-columns: minmax(0, 1fr); gap: 4px; } }
</style>
