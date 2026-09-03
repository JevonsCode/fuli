<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { getJson, postJson } from '@/api/client'
import EmployeeAllProjectsBoard, { type EmployeeBoardItem, type EmployeeBoardStatus, type EmployeeProjectBoard } from '@/features/employees/EmployeeAllProjectsBoard.vue'
import EmployeeRecruitDialog from '@/features/employees/EmployeeRecruitDialog.vue'
import { employeeAvatarUrl } from '@/features/employees/avatars'
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
const manageProjectsOpen = ref(false)
const personalSpaceId = computed(() => store.activePersonalSpace?.id ?? '')
const templateId = computed(() => String(route.params.templateId ?? ''))
const template = computed(() => employeeTemplates.value.find((entry) => entry.id === templateId.value))
const visibleError = computed(() => employeeCatalogError.value || error.value)
const ALL_PROJECTS = '__all__'
const managedProjectOptions = computed(() => template.value?.managedProjects !== undefined
  ? template.value.managedProjects.map(project => ({ value: project.id, label: project.name }))
  : (template.value?.assignments ?? []).filter(assignment => assignment.status === 'active').map((assignment) => ({
  value: assignment.personalProjectId,
  label: store.state?.personalProjects?.find((project) => project.project_id === assignment.personalProjectId)?.profile.name ?? assignment.personalProjectId,
})))
const visibleProjectIds = computed({
  get: () => {
    const excluded = new Set(excludedProjectIds.value)
    return managedProjectOptions.value.filter((project) => !excluded.has(project.value)).map((project) => project.value)
  },
  set: (projectIds: string[]) => {
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
watch(personalSpaceId, (id) => { void refreshEmployeeCatalog(id) }, { immediate: true })
watch([templateId, personalSpaceId], () => { excludedProjectIds.value = [] })
watch([projectOptions, () => route.query.project, templateId], () => {
  const requested = typeof route.query.project === 'string' ? route.query.project : ''
  const options = projectOptions.value
  projectId.value = requested || (options.some((entry) => entry.value === projectId.value)
    ? projectId.value : options[0]?.value ?? '')
  // Make the displayed project reloadable, including a sidebar click from another board.
  if (!requested && projectId.value) {
    void router.replace({ query: { ...route.query, project: projectId.value } })
  }
}, { immediate: true })
watch([templateId, projectId, personalSpaceId, supportsAllProjects], () => {
  void loadWorkspace()
}, { immediate: true })
watch(employeeCatalogLoading, (catalogLoading) => {
  if (!catalogLoading && projectId.value === ALL_PROJECTS) void loadWorkspace()
})
async function loadWorkspace() {
  const current = ++version
  workspace.value = null
  projectBoards.value = []
  failedProjectIds.value = []
  boardActionError.value = ''
  error.value = ''
  if (!projectId.value || !personalSpaceId.value) { loading.value = false; return }
  const requestedTemplate = templateId.value
  const requestedProject = projectId.value
  if (requestedProject === ALL_PROJECTS && (employeeCatalogLoading.value || !template.value)) {
    loading.value = employeeCatalogLoading.value
    return
  }
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
          const items = Array.isArray(board.items) ? board.items.filter(isEmployeeBoardItem) : []
          return { ok: true as const, board: { ...board, project: { id: project.value, name: project.label }, items } }
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
function changeProject(value: string) { void router.replace({ query: { ...route.query, project: value } }) }
function boardItemKey(item: EmployeeBoardItem) { return `${item.projectId}:${item.id}` }
function replaceBoardItem(projectId: string, itemId: string, replacement: EmployeeBoardItem) {
  projectBoards.value = projectBoards.value.map((board) => board.project.id !== projectId ? board : {
    ...board,
    items: board.items.map((item) => item.id === itemId ? replacement : item),
  })
}
async function moveTask(item: EmployeeBoardItem, status: EmployeeBoardStatus) {
  if (item.status === status) return
  const key = boardItemKey(item)
  const optimistic = { ...item, status }
  boardActionError.value = ''
  movingItemKeys.value = [...movingItemKeys.value, key]
  replaceBoardItem(item.projectId, item.id, optimistic)
  try {
    const result = await postJson<{ updatedWorkItem?: EmployeeBoardItem; updatedWorkItems?: EmployeeBoardItem[] }>(`/api/employee-templates/${encodeURIComponent(templateId.value)}/call`, {
      personalSpaceId: personalSpaceId.value,
      personalProjectId: item.projectId,
      tool: 'move_task',
      arguments: {
        workItemId: item.id,
        status,
        ...(item.updatedAt ? { expectedUpdatedAt: item.updatedAt } : {}),
      },
    })
    const updated = result.updatedWorkItem ?? result.updatedWorkItems?.find((candidate) => candidate.id === item.id)
    replaceBoardItem(item.projectId, item.id, updated && isEmployeeBoardItem(updated) ? updated : optimistic)
  } catch (cause) {
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
  await refreshEmployeeCatalog(personalSpaceId.value)
  if (!employeeCatalogError.value) await loadWorkspace()
}
async function projectsSaved() {
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
      </div>
      <div class="employee-workbench-actions">
        <button v-if="projectId && projectId !== ALL_PROJECTS && supportsAllProjects" class="employee-back-to-all" type="button" @click="changeProject(ALL_PROJECTS)">{{ t('employees.allProjects.back') }}</button>
        <button v-if="template" class="employee-manage-projects" type="button" :disabled="!personalSpaceId" @click="manageProjectsOpen = true">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M4 7h9m4 0h3M4 17h3m4 0h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></svg>
          {{ t('employees.manageProjects') }}
        </button>
      </div>
    </header>
    <EmployeeRecruitDialog :open="manageProjectsOpen" :personal-space-id="personalSpaceId" :projects="store.state?.personalProjects ?? []" :template-id="templateId" @close="manageProjectsOpen = false" @recruited="projectsSaved" />
    <div v-if="loading || (!template && employeeCatalogLoading)" class="employee-workbench-state" role="status">{{ t('employees.loadingWorkbench') }}</div>
    <div v-else-if="visibleError" class="employee-workbench-state" role="alert"><p>{{ visibleError }}</p><button class="quiet-button" type="button" @click="retry">{{ t('employees.retry') }}</button></div>
    <div v-else-if="!template" class="employee-workbench-state"><p>{{ t('employees.unavailable') }}</p><RouterLink to="/project-agents">{{ t('employees.backToAgents') }}</RouterLink></div>
    <div v-else-if="!projectId" class="employee-workbench-state"><h2>{{ t('employees.emptyWorkbench') }}</h2><p>{{ t('employees.manageHint') }}</p><button class="quiet-button" type="button" @click="manageProjectsOpen = true">{{ t('employees.manageProjects') }}</button></div>
    <EmployeeAllProjectsBoard
      v-else-if="projectId === ALL_PROJECTS && supportsAllProjects"
      v-model:visible-project-ids="visibleProjectIds"
      :boards="visibleProjectBoards"
      :projects="managedProjectOptions.map((project) => ({ id: project.value, name: project.label }))"
      :failed-projects="visibleFailedProjects"
      :can-move-tasks="template.permissions.includes('board.write')"
      :moving-item-keys="movingItemKeys"
      :action-error="boardActionError"
      @move-task="moveTask"
      @select-project="changeProject"
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
