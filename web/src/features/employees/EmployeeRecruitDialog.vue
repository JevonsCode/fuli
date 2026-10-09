<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { postJson } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import UiSelect from '@/components/ui/UiSelect.vue'
import ProjectScopePicker from './ProjectScopePicker.vue'
import { employeeAvatarUrl } from './avatars'
import UiButton from '@/components/ui/UiButton.vue'
import UiDialog from '@/components/ui/UiDialog.vue'
import { t } from '@/i18n'
import { personalProjectsPath } from '@/router/paths'
import type { PersonalProject } from '@/types'
import {
  employeeTemplates, fetchEmployeeCatalog, refreshEmployeeCatalog,
  employeeErrorMessage, type EmployeeRecruitmentResult, type EmployeeTemplate,
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
const catalogTemplates = ref<EmployeeTemplate[]>([])
const catalogError = ref('')
const templates = computed(() => props.templateId ? catalogTemplates.value : catalogTemplates.value.filter((entry) => !entry.fixed))
const selected = computed(() => props.templateId
  ? templates.value.find((entry) => entry.id === props.templateId)
  : templates.value.find((entry) => entry.id === templateId.value) ?? templates.value[0])
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
  catalogTemplates.value = []
  catalogError.value = ''
  try {
    const nextTemplates = await fetchEmployeeCatalog(props.personalSpaceId)
    if (current !== loadVersion || !props.open) return
    catalogTemplates.value = nextTemplates
    initializeSelection(includeDefault)
  } catch (cause) {
    if (current === loadVersion && props.open) {
      catalogTemplates.value = []
      catalogError.value = employeeErrorMessage(cause)
    }
  } finally {
    if (current === loadVersion) selectionLoading.value = false
  }
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
    catalogTemplates.value = [...employeeTemplates.value]
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
  <UiDialog :open="open" class="employee-recruit-dialog" :title="title" :busy="busy" form @close="close" @submit="recruit">
    <GrowthLoading v-if="selectionLoading && !templates.length" variant="compact" :label="t('employees.loading')" />
    <div v-else-if="catalogError" role="alert" class="ui-dialog__error employee-message">
      <p>{{ catalogError }}</p>
      <UiButton size="sm" @click="reloadSelection(true)">{{ t('employees.retry') }}</UiButton>
    </div>
    <p v-else-if="!selected" class="ui-muted">{{ t('employees.noTemplates') }}</p>
    <template v-else>
      <UiSelect v-if="templates.length > 1 && !props.templateId" v-model="templateId" class="ui-field" control-id="employee-template" :label="t('employees.choose')" :options="templates.map((entry) => ({ value: entry.id, label: entry.name, meta: entry.role }))" :disabled="busy || selectionLoading" />
      <div class="employee-profile">
        <span class="employee-avatar" aria-hidden="true">
          <img v-if="employeeAvatarUrl(selected.id)" :src="employeeAvatarUrl(selected.id)" alt="" />
          <template v-else>{{ selected.name.slice(0, 1) }}</template>
        </span>
        <div>
          <h3>{{ selected.name }} <span>{{ selected.role }}</span></h3>
          <p>{{ selected.description }}</p>
          <p class="ui-meta">{{ selected.capabilities.join(' · ') }}</p>
        </div>
      </div>
      <GrowthLoading v-if="selectionLoading" variant="compact" :label="t('employees.loadingScope')" />
      <div v-if="supportsPolicy" class="employee-scope">
        <div class="ui-segmented" role="radiogroup" :aria-label="t('employees.scope.rule')" @keydown="scopeKeydown">
          <button v-for="mode in (['all', 'selected'] as const)" :key="mode" type="button" role="radio" :data-scope="mode" :aria-checked="scopeMode === mode" :tabindex="scopeMode === mode ? 0 : -1" :disabled="busy || selectionLoading || requiresReload" @click="changeScope(mode)">
            {{ t(`employees.scope.${mode === 'all' ? 'continuousAll' : 'onlySelected'}`) }}
          </button>
        </div>
        <p class="ui-meta" role="status">{{ scopeMode === 'all' ? t('employees.scope.allHint', { name: selected.name }) : t('employees.scope.selectedHint') }}</p>
      </div>
      <ProjectScopePicker v-model="selectionIds" :projects="projectOptions" inline :hint="scopeMode === 'all' ? t('employees.scope.excludeHint') : undefined" :disabled="busy || selectionLoading || requiresReload" />
      <p v-if="scopeMode === 'all' && excludedIds.length" class="ui-meta">{{ t('employees.scope.excludedCount', { count: excludedIds.length }) }}</p>
      <p v-if="!projectOptions.length" class="ui-meta">{{ t('employees.noProjects') }} <RouterLink :to="personalProjectsPath(personalSpaceId, 'directory')" @click="close">{{ t('employees.createProject') }}</RouterLink></p>
      <p v-if="removals.length && !success" class="ui-meta">{{ t('employees.scopeRemoved', { count: removals.length }) }}</p>
      <section v-if="supportsPolicy && selected.permissions.includes('session.title')" class="employee-title-settings" :aria-label="t('employees.titles.heading')">
        <h3>{{ t('employees.titles.heading') }}</h3>
        <div class="employee-title-controls">
          <UiSelect v-model="titleMode" field control-id="employee-title-mode" :label="t('employees.titles.mode')" :options="titleModeOptions" :disabled="busy || selectionLoading || requiresReload" />
          <UiSelect v-model="titleStyle" field control-id="employee-title-style" :label="t('employees.titles.style')" :options="titleStyleOptions" :disabled="busy || selectionLoading || requiresReload || titleMode === 'off'" />
        </div>
        <p class="ui-meta">{{ t('employees.titles.example') }} <span class="employee-title-example">【P1｜{{ titleStyle === 'emoji' ? '🔧 ' : '' }}FIX｜{{ t('employees.titles.exampleTask') }}】</span></p>
        <p class="ui-meta">{{ t('employees.titles.boundary') }}</p>
      </section>
      <section class="employee-permissions" :aria-label="t('employees.permissions')">
        <strong>{{ t('employees.permissions') }}</strong>
        <ul><li v-for="permission in selected.permissions" :key="permission">{{ permission === 'board.read' ? t('employees.boardRead') : permission === 'board.write' ? t('employees.boardWrite') : permission === 'session.title' ? t('employees.titles.heading') : permission }}</li></ul>
        <p class="ui-meta">{{ t('employees.noExecutor') }}</p>
      </section>
      <p v-if="selected.runtime" class="employee-runtime" :class="{ 'is-warning': selected.runtimeStatus !== 'ready' }">{{ selected.runtimeStatus === 'ready' ? t('employees.hostReady') : t('employees.installRequired') }}</p>
      <p v-if="error || selected.identityConflict" class="ui-dialog__error" role="alert">{{ error || t('employees.errors.identity_conflict') }}</p>
      <UiButton v-if="requiresReload" size="sm" :disabled="selectionLoading" @click="reloadSelection()">{{ t('employees.reloadScope') }}</UiButton>
      <div v-if="success" class="employee-success" role="status">
        <strong>{{ t('employees.scopeSaved') }}</strong>
        <p>{{ scopeMode === 'all' ? t('employees.scope.successAll', { count: selectionIds.length }) : selectionIds.length ? t('employees.successMultiple', { count: selectionIds.length }) : t('employees.successUnassigned') }}</p>
      </div>
    </template>
    <template v-if="selected && !catalogError" #footer>
      <UiButton variant="ghost" :disabled="busy" @click="close">{{ t('employees.cancel') }}</UiButton>
      <RouterLink v-if="noChange && workbenchLink && !busy && !selectionLoading && !requiresReload && selected.runtimeStatus === 'ready'" class="ui-button ui-button--primary" :to="workbenchLink" @click="close">{{ t('employees.open') }}</RouterLink>
      <UiButton v-else variant="primary" type="submit" :busy="busy" :busy-label="actionLabel" :disabled="selectionLoading || requiresReload || !expectedVersion || noChange || selected.identityConflict || !personalSpaceId">{{ actionLabel }}</UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.employee-profile { display: flex; align-items: center; gap: 14px; }
.employee-profile h3 { margin: 0 0 2px; font-size: 18px; line-height: 1.35; }
.employee-profile h3 span { margin-left: 8px; color: var(--color-muted); font-size: 13px; font-weight: 500; }
.employee-profile p { margin: 0; }
.employee-avatar { display: grid; flex: 0 0 48px; height: 48px; place-items: center; overflow: hidden; border-radius: 14px; background: var(--color-surface-subtle); font-size: 24px; font-weight: 650; }
.employee-avatar img { width: 100%; height: 100%; object-fit: cover; }
.employee-scope { display: grid; gap: 8px; }
.employee-scope .ui-segmented { display: flex; }
.employee-scope .ui-segmented > button { flex: 1; }
.employee-title-settings { display: grid; gap: 8px; }
.employee-title-settings h3 { margin: 0; font-size: 14px; font-weight: 600; }
.employee-title-controls { display: grid; grid-template-columns: 1.2fr 1fr; gap: 12px; }
.employee-title-example { color: var(--color-ink); overflow-wrap: anywhere; }
.employee-permissions { font-size: 12px; }
.employee-permissions strong { font-weight: 600; }
.employee-permissions ul { display: flex; flex-wrap: wrap; gap: 4px 18px; margin: 6px 0; padding-left: 16px; }
.employee-runtime { margin: 0; font-size: 12px; }
.employee-runtime.is-warning { color: var(--color-warning); }
.employee-success { color: var(--color-success); }
.employee-success p { margin: 0; }
.employee-message { display: grid; gap: 10px; justify-items: start; }
.employee-message p { margin: 0; }
@media (max-width: 540px) { .employee-title-controls { grid-template-columns: minmax(0, 1fr); } }
</style>
