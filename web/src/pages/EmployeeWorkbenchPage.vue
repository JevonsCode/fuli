<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { getJson, patchJson, postJson } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import EmployeeTaskBoard, { type EmployeeBoardItem, type EmployeeBoardStatus, type EmployeeProjectBoard } from '@/features/employees/EmployeeTaskBoard.vue'
import EmployeeRecruitDialog from '@/features/employees/EmployeeRecruitDialog.vue'
import BolePeoplePanel from '@/features/employees/BolePeoplePanel.vue'
import EmployeeTaskDialog from '@/features/employees/EmployeeTaskDialog.vue'
import EmployeeShareDialog from '@/features/employees/EmployeeShareDialog.vue'
import { employeeAvatarUrl } from '@/features/employees/avatars'
import { useProjectBoardFilter } from '@/features/employees/project-board-filter'
import { useConsoleStore } from '@/stores/console'
import { t } from '@/i18n'
import { employeeTemplates, employeeCatalogError, employeeCatalogLoading, employeeErrorMessage, refreshEmployeeCatalog, type EmployeeWorkspace } from '@/features/employees/catalog'

const route = useRoute()
const router = useRouter()
const store = useConsoleStore()
const projectId = ref('')
const workspace = ref<EmployeeWorkspace | null>(null)
const projectBoards = ref<EmployeeProjectBoard[]>([])
const failedProjectIds = ref<string[]>([])
const excludedProjectIds = ref<string[]>([])
const movingItemKeys = ref<string[]>([])
const boardActionError = ref('')
const error = ref('')
const loading = ref(false)
const catalogReady = ref(false)
const pendingWorkspaceReload = ref(false)
const manageProjectsOpen = ref(false)
const shareOpen = ref(false)
const taskOpen = ref(false)
const selectedTask = ref<EmployeeBoardItem | null>(null)
const personalSpaceId = computed(() => store.activePersonalSpace?.id ?? '')
const templateId = computed(() => String(route.params.templateId ?? ''))
const template = computed(() => employeeTemplates.value.find((entry) => entry.id === templateId.value))
const isNativePeople = computed(() => template.value?.workbench?.kind === 'native' && template.value.workbench.view === 'people')
const isJefa = computed(() => templateId.value === 'jefa')
const pageLoading = computed(() => (!store.state
  && (store.runtimeStatus === 'idle' || store.runtimeStatus === 'loading'))
  || !catalogReady.value || loading.value)
const pageLoadingLabel = computed(() => !store.state
  ? t('common.status.loadingConsole')
  : employeeCatalogLoading.value || !catalogReady.value
    ? t('employees.loading') : t('employees.loadingBoard'))
const pageError = computed(() => !store.state && store.runtimeStatus === 'error'
  ? store.feedback?.message || t('employees.loadError') : '')
const visibleError = computed(() => pageError.value || employeeCatalogError.value
  || (isJefa.value && projectFilter.invalidScope.value ? t('employees.invalidScope') : error.value))
const ALL_PROJECTS = 'all'
const managedProjectOptions = computed(() => template.value?.managedProjects !== undefined
  ? template.value.managedProjects.map(project => ({ value: project.id, label: project.name }))
  : (template.value?.assignments ?? []).filter(assignment => assignment.status === 'active').map((assignment) => ({
  value: assignment.personalProjectId,
  label: store.state?.personalProjects?.find((project) => project.project_id === assignment.personalProjectId)?.profile.name ?? assignment.personalProjectId,
})))
const managedProjectSignature = computed(() => JSON.stringify(
  [...new Set(managedProjectOptions.value.map(project => project.value))].sort(),
))
watch(personalSpaceId, (id) => {
  catalogReady.value = false
  void refreshEmployeeCatalog(id)
}, { immediate: true })
const projectFilter = useProjectBoardFilter({
  enabled: isJefa,
  spaceId: personalSpaceId,
  projectIds: computed(() => managedProjectOptions.value.map(project => project.value)),
  ready: computed(() => !employeeCatalogLoading.value && !employeeCatalogError.value && Boolean(template.value)),
})
const visibleProjectIds = computed({
  get: () => {
    if (isJefa.value) return projectFilter.selection.value
    const excluded = new Set(excludedProjectIds.value)
    return managedProjectOptions.value.filter((project) => !excluded.has(project.value)).map((project) => project.value)
  },
  set: (projectIds: string[]) => {
    if (isJefa.value) { projectFilter.selection.value = projectIds; return }
    const managed = new Set(managedProjectOptions.value.map((project) => project.value))
    const visible = new Set(projectIds)
    excludedProjectIds.value = [
      ...excludedProjectIds.value.filter((projectId) => !managed.has(projectId)),
      ...managedProjectOptions.value.filter((project) => !visible.has(project.value)).map((project) => project.value),
    ]
  },
})
const visibleProjectBoards = computed(() => {
  const visible = new Set(visibleProjectIds.value)
  return projectBoards.value.filter((board) => visible.has(board.project.id))
})
const visibleFailedProjects = computed(() => {
  const visible = new Set(visibleProjectIds.value)
  return failedProjectIds.value.filter((projectId) => visible.has(projectId)).length
})
const supportsAllProjects = computed(() => template.value?.runtimeStatus === 'ready'
  && template.value.permissions.includes('board.read')
  && managedProjectOptions.value.length > 0)
const projectOptions = computed(() => supportsAllProjects.value
  ? [{ value: ALL_PROJECTS, label: t('employees.allProjects.option'), meta: t('employees.allProjects.optionMeta', { count: managedProjectOptions.value.length }) }, ...managedProjectOptions.value]
  : managedProjectOptions.value)
let version = 0
watch([templateId, personalSpaceId], () => { excludedProjectIds.value = []; taskOpen.value = false; shareOpen.value = false; selectedTask.value = null })
watch([projectOptions, () => route.query.project, () => route.query.empty, templateId, isNativePeople], () => {
  if (isNativePeople.value) {
    ++version
    projectId.value = ''
    loading.value = false
    error.value = ''
    if (route.query.project !== undefined) {
      const { project: _project, ...query } = route.query
      void router.replace({ query })
    }
    return
  }
  if (isJefa.value) {
    projectId.value = managedProjectOptions.value.length ? ALL_PROJECTS : ''
    return
  }
  const requested = typeof route.query.project === 'string' ? route.query.project : ''
  const options = projectOptions.value
  projectId.value = requested || (options.some((entry) => entry.value === projectId.value)
    ? projectId.value : options[0]?.value ?? '')
  // Make the displayed project reloadable, including a sidebar click from another board.
  if (!requested && projectId.value) {
    void router.replace({ query: { ...route.query, project: projectId.value } })
  }
}, { immediate: true })
watch([templateId, projectId, personalSpaceId, supportsAllProjects, catalogReady], () => {
  if (!isNativePeople.value && catalogReady.value) void loadWorkspace()
}, { immediate: true })
watch(employeeCatalogLoading, (catalogLoading) => {
  // Only the first catalog read gates the workbench. A management dialog refresh
  // must not clear or remount an already loaded board.
  if (catalogLoading) return
  if (!catalogReady.value) {
    catalogReady.value = true
    return
  }
  if (pendingWorkspaceReload.value) {
    pendingWorkspaceReload.value = false
    void loadWorkspace()
  }
}, { immediate: true })
watch(projectFilter.invalidScope, (invalid) => { if (!invalid && isJefa.value && catalogReady.value) void loadWorkspace() })
watch(managedProjectSignature, (signature, previous) => {
  if (signature === previous || !catalogReady.value || isNativePeople.value) return
  void loadWorkspace()
})
async function loadWorkspace() {
  const current = ++version
  workspace.value = null
  projectBoards.value = []
  failedProjectIds.value = []
  boardActionError.value = ''
  error.value = ''
  if (isNativePeople.value || !template.value || !projectId.value || !personalSpaceId.value) { loading.value = false; return }
  if (isJefa.value && !supportsAllProjects.value) { loading.value = false; return }
  if (isJefa.value && projectFilter.invalidScope.value) { loading.value = false; return }
  if (employeeCatalogLoading.value) {
    pendingWorkspaceReload.value = true
    loading.value = true
    return
  }
  pendingWorkspaceReload.value = false
  const requestedTemplate = templateId.value
  const requestedProject = projectId.value
  loading.value = true
  try {
    if (requestedProject === ALL_PROJECTS && supportsAllProjects.value) {
      const results = await Promise.all(managedProjectOptions.value.map(async (project) => {
        try {
          const board = await postJson<EmployeeProjectBoard>(`/api/employee-templates/${encodeURIComponent(requestedTemplate)}/call`, {
            personalSpaceId: personalSpaceId.value,
            personalProjectId: project.value,
            tool: 'read_board',
            arguments: { limit: 100 },
          })
          let items = Array.isArray(board.items) ? board.items.filter(isEmployeeBoardItem).filter(item => item.projectId === project.value) : []
          let truncated = board.truncated
          if (requestedTemplate === 'jefa' && truncated) {
            try {
              const snapshot = await getJson<{ snapshot: { workItems: unknown[] } }>(`/employee-workspaces/jefa/${encodeURIComponent(project.value)}/api/snapshot`)
              if (!Array.isArray(snapshot.snapshot.workItems)) throw new Error('Invalid board snapshot')
              items = snapshot.snapshot.workItems.filter(isEmployeeBoardItem).filter(item => item.projectId === project.value)
              truncated = false
            } catch { /* Keep the explicitly marked partial board if the full snapshot is unavailable. */ }
          }
          return { ok: true as const, board: { ...board, truncated, project: { id: project.value, name: project.label }, items } }
        } catch (cause) {
          return { ok: false as const, cause, projectId: project.value }
        }
      }))
      if (current !== version) return
      projectBoards.value = results.filter(result => result.ok).map(result => result.board)
      failedProjectIds.value = results.flatMap((result) => result.ok ? [] : [result.projectId])
      if (!projectBoards.value.length && failedProjectIds.value.length) {
        error.value = employeeErrorMessage(results.find(result => !result.ok)?.cause)
      }
      return
    }
    const result = await getJson<EmployeeWorkspace>(`/api/employee-templates/${encodeURIComponent(requestedTemplate)}/workspace?${new URLSearchParams({ personalSpaceId: personalSpaceId.value, personalProjectId: requestedProject })}`)
    const prefix = `/employee-workspaces/${encodeURIComponent(requestedTemplate)}/${encodeURIComponent(requestedProject)}/`
    if (result.workbenchUrl !== prefix) throw new Error(t('employees.loadError'))
    if (current === version) workspace.value = result
  } catch (cause) { if (current === version) error.value = employeeErrorMessage(cause) }
  finally { if (current === version) loading.value = false }
}
function openTask(item: EmployeeBoardItem | null = null) { selectedTask.value = item; taskOpen.value = true }
function boardItemKey(item: EmployeeBoardItem) { return `${item.projectId}:${item.id}` }
function replaceBoardItem(projectId: string, itemId: string, replacement: EmployeeBoardItem) {
  projectBoards.value = projectBoards.value.map((board) => board.project.id !== projectId ? board : {
    ...board,
    items: board.items.map((item) => item.id === itemId ? replacement : item),
  })
}
function taskMoveRequestId() {
  const suffix = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `aggregate-board-move-${suffix}`
}
async function moveTask(item: EmployeeBoardItem, status: EmployeeBoardStatus) {
  if (item.status === status) return
  const key = boardItemKey(item)
  if (movingItemKeys.value.includes(key)) return
  const context = `${templateId.value}:${personalSpaceId.value}`
  const optimistic = { ...item, status }
  boardActionError.value = ''
  movingItemKeys.value = [...movingItemKeys.value, key]
  replaceBoardItem(item.projectId, item.id, optimistic)
  try {
    let updated: EmployeeBoardItem | undefined
    if (templateId.value === 'jefa' && status === 'done') {
      const result = await patchJson<{ workItem?: EmployeeBoardItem }>(
        `/employee-workspaces/${encodeURIComponent(templateId.value)}/${encodeURIComponent(item.projectId)}/api/work-items/${encodeURIComponent(item.id)}/status`,
        { status },
      )
      updated = result.workItem
    } else {
      if (!item.updatedAt) throw new Error(t('employees.allProjects.refreshRequired'))
      const result = await postJson<{ updatedWorkItems?: EmployeeBoardItem[] }>(`/api/employee-templates/${encodeURIComponent(templateId.value)}/call`, {
        personalSpaceId: personalSpaceId.value,
        personalProjectId: item.projectId,
        tool: 'update_tasks',
        arguments: {
          requestId: taskMoveRequestId(),
          updates: [{
            id: item.id,
            expectedUpdatedAt: item.updatedAt,
            status,
          }],
        },
      })
      updated = result.updatedWorkItems?.find((candidate) => candidate.id === item.id)
    }
    if (`${templateId.value}:${personalSpaceId.value}` !== context) return
    if (!updated || !isEmployeeBoardItem(updated) || updated.projectId !== item.projectId || updated.id !== item.id || !updated.updatedAt) throw new Error(t('employees.allProjects.refreshRequired'))
    replaceBoardItem(item.projectId, item.id, updated)
  } catch (cause) {
    if (`${templateId.value}:${personalSpaceId.value}` !== context) return
    replaceBoardItem(item.projectId, item.id, item)
    boardActionError.value = t('employees.allProjects.moveFailed', { error: employeeErrorMessage(cause) })
  } finally {
    movingItemKeys.value = movingItemKeys.value.filter((candidate) => candidate !== key)
  }
}
function isEmployeeBoardItem(value: unknown): value is EmployeeBoardItem {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<EmployeeBoardItem>
  return typeof item.id === 'string' && typeof item.projectId === 'string' && typeof item.title === 'string'
    && ['planned', 'active', 'blocked', 'review', 'done'].includes(item.status ?? '')
}
async function retry() {
  if (!store.state) {
    await store.refresh()
    return
  }
  await refreshEmployeeCatalog(personalSpaceId.value)
  if (!employeeCatalogError.value) await loadWorkspace()
}
async function projectsSaved() {
  if (isJefa.value) {
    await router.replace({ query: { ...route.query, project: ALL_PROJECTS, empty: undefined } })
    await loadWorkspace()
    return
  }
  const current = projectId.value === ALL_PROJECTS && supportsAllProjects.value
    ? ALL_PROJECTS
    : managedProjectOptions.value.find((option) => option.value === projectId.value)?.value
      ?? projectOptions.value[0]?.value
  // Only an explicit successful scope edit may replace a project that was just removed.
  await router.replace({ query: current ? { project: current } : {} })
  await loadWorkspace()
}
</script>

<template>
  <section class="employee-workbench-view" :aria-label="template?.name ?? t('employees.workbench')">
    <header class="employee-workbench-toolbar">
      <div class="employee-workbench-identity">
        <span class="employee-workbench-mark" aria-hidden="true">
          <img v-if="employeeAvatarUrl(templateId)" :src="employeeAvatarUrl(templateId)" alt="" />
          <template v-else>{{ template?.name.slice(0, 1) ?? 'A' }}</template>
        </span>
        <h1>{{ template?.name ?? t('employees.workbench') }} <span>{{ template?.role }}</span></h1>
        <button v-if="isJefa && supportsAllProjects" class="employee-share-button" type="button" :aria-label="t('employees.share.title')" :title="t('employees.share.title')" @click="shareOpen = true">
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3h7v7m0-7-9 9M10 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/><path d="M7 16v-3m4 3v-1"/></svg>
        </button>
      </div>
      <div class="employee-workbench-actions">
        <button v-if="template && !isNativePeople" class="employee-manage-projects" type="button" :disabled="!personalSpaceId" @click="manageProjectsOpen = true">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M4 7h9m4 0h3M4 17h3m4 0h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></svg>
          {{ t('employees.manageProjects') }}
        </button>
      </div>
    </header>
    <EmployeeRecruitDialog v-if="!isNativePeople" :open="manageProjectsOpen" :personal-space-id="personalSpaceId" :projects="store.state?.personalProjects ?? []" :template-id="templateId" @close="manageProjectsOpen = false" @recruited="projectsSaved" />
    <EmployeeTaskDialog v-if="isJefa" :open="taskOpen" :item="selectedTask" :projects="managedProjectOptions.map(project => ({ id: project.value, name: project.label }))" :default-project-id="visibleProjectIds.length === 1 ? visibleProjectIds[0] : undefined" :personal-space-id="personalSpaceId" :can-write="template?.permissions.includes('board.write') ?? false" @close="taskOpen = false" @saved="loadWorkspace" />
    <EmployeeShareDialog v-if="isJefa" :open="shareOpen" :projects="managedProjectOptions.map(project => ({ id: project.value, name: project.label }))" @close="shareOpen = false" />
    <GrowthLoading v-if="pageLoading" :label="pageLoadingLabel" />
    <div v-else-if="visibleError" class="employee-workbench-state" role="alert"><p>{{ visibleError }}</p><button class="quiet-button" type="button" @click="retry">{{ t('employees.retry') }}</button></div>
    <div v-else-if="!template" class="employee-workbench-state"><p>{{ t('employees.unavailable') }}</p><RouterLink to="/project-agents">{{ t('employees.backToAgents') }}</RouterLink></div>
    <BolePeoplePanel v-else-if="isNativePeople" :personal-space-id="personalSpaceId" :projects="store.state?.personalProjects ?? []" />
    <div v-else-if="isJefa && template.runtimeStatus !== 'ready'" class="employee-workbench-state"><p>{{ t('employees.installRequired') }}</p><small>{{ t('employees.installHelp') }}</small></div>
    <div v-else-if="!projectId" class="employee-workbench-state"><h2>{{ t('employees.emptyWorkbench') }}</h2><p>{{ t('employees.manageHint') }}</p><button class="quiet-button" type="button" @click="manageProjectsOpen = true">{{ t('employees.manageProjects') }}</button></div>
    <EmployeeTaskBoard
      v-else-if="projectId === ALL_PROJECTS && supportsAllProjects"
      v-model:visible-project-ids="visibleProjectIds"
      :boards="visibleProjectBoards"
      :projects="managedProjectOptions.map((project) => ({ id: project.value, name: project.label }))"
      :failed-projects="visibleFailedProjects"
      :can-move-tasks="template.permissions.includes('board.write')"
      :moving-item-keys="movingItemKeys"
      :action-error="boardActionError"
      :resettable-filter="isJefa"
      :filter-storage-unavailable="projectFilter.storageUnavailable.value"
      @reset-project-filter="projectFilter.reset"
      @move-task="moveTask"
      @select-task="openTask"
      @create-task="openTask()"
      @retry="loadWorkspace"
    />
    <div v-else-if="workspace && workspace.runtimeStatus !== 'ready'" class="employee-workbench-state"><p>{{ t('employees.installRequired') }}</p><small>{{ t('employees.installHelp') }}</small></div>
    <iframe v-else-if="workspace" :key="workspace.workbenchUrl" :src="workspace.workbenchUrl" :title="`${workspace.name} · ${workspace.project.name}`" class="employee-workbench-frame" />
  </section>
</template>

<style scoped>
.employee-workbench-view { display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0; overflow: hidden; background: #fff; }
.employee-workbench-toolbar { display: flex; flex: 0 0 auto; align-items: center; justify-content: space-between; gap: 20px; padding: 16px 24px 10px; }
.employee-workbench-identity { display: flex; align-items: center; gap: 10px; min-width: 0; }
.employee-workbench-mark { display: grid; place-items: center; flex: 0 0 32px; height: 32px; overflow: hidden; border-radius: 9px; background: #eaf0ec; color: #315c43; font-size: 17px; font-weight: 650; }
.employee-workbench-mark img { width: 100%; height: 100%; object-fit: cover; }
.employee-share-button { display: grid; place-items: center; flex: 0 0 40px; width: 40px; height: 40px; border: 0; border-radius: 8px; color: #42624c; background: transparent; cursor: pointer; }
.employee-share-button:hover { background: #edf3ee; }
.employee-share-button:focus-visible { outline: 2px solid #356448; outline-offset: 2px; }
.employee-workbench-toolbar h1 { margin: 0; color: #253c2f; font-size: 18px; font-weight: 650; line-height: 1.4; overflow-wrap: anywhere; }
.employee-workbench-toolbar h1 span { margin-left: 8px; color: #59685f; font-size: 12px; font-weight: 400; }
.employee-workbench-actions { display: flex; align-items: center; gap: 12px; min-width: 0; }
.employee-manage-projects, .employee-back-to-all { display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-height: 40px; padding: 8px 10px; border: 0; border-radius: 8px; background: transparent; color: #465b4d; font: inherit; font-size: 13px; cursor: pointer; white-space: nowrap; }
.employee-manage-projects:hover:not(:disabled), .employee-back-to-all:hover { background: #e2ece5; }
.employee-manage-projects:disabled { color: #647568; cursor: default; }
.employee-manage-projects:focus-visible, .employee-back-to-all:focus-visible { outline: 2px solid #356448; outline-offset: 3px; }
.employee-workbench-frame { flex: 1; width: 100%; height: 100%; min-height: 0; border: 0; }
.employee-workbench-state { display: grid; flex: 1; gap: 14px; place-content: center; justify-items: center; padding: 30px; color: #58695e; font-size: 14px; text-align: center; }
.employee-workbench-state a { color: #315c43; }
.employee-workbench-state h2 { font-size: 20px; font-weight: 600; color: #253c2f; }
.employee-workbench-state p { margin: 0; max-width: 48ch; line-height: 1.7; }
@media (max-width: 640px) { .employee-workbench-toolbar { flex-wrap: wrap; gap: 10px; padding: 8px 16px 10px; }.employee-workbench-actions { width: 100%; justify-content: flex-end; gap: 8px; }.employee-workbench-toolbar h1 span { margin-left: 6px; } }
</style>
