<script setup lang="ts">
import UiButton from '@/ui/UiButton.vue'
import { computed, reactive, ref, watch } from 'vue'
import { isEmployeeBoardItem } from '@/features/employees/task-board-model'
import { useJefaBoardLoad } from '@/features/employees/useJefaBoardLoad'
import JefaReadStatus from '@/features/employees/JefaReadStatus.vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { getJson, patchJson, postJson } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import EmployeeTaskBoard, { type EmployeeBoardItem, type EmployeeBoardStatus, type EmployeeProjectBoard } from '@/features/employees/EmployeeTaskBoard.vue'
import EmployeeRecruitDialog from '@/features/employees/EmployeeRecruitDialog.vue'
import BolePeoplePanel from '@/features/employees/BolePeoplePanel.vue'
import UnassignedConversationsPanel from '@/features/agent-profile/UnassignedConversationsPanel.vue'
import { isFormalProject } from '@/features/projects/project-origin'
import EmployeeTaskDialog from '@/features/employees/EmployeeTaskDialog.vue'
import EmployeeShareDialog from '@/features/employees/EmployeeShareDialog.vue'
import { employeeAvatarUrl } from '@/features/employees/avatars'
import { useProjectBoardFilter } from '@/features/employees/project-board-filter'
import JudgmentWorkbench from '@/features/judgment/JudgmentWorkbench.vue'
import { agentProfilePath } from '@/features/agent-profile/profile-model'
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
const isJefa = computed(() => templateId.value === 'jefa')
const jefaRead = reactive(useJefaBoardLoad({
  enabled: isJefa, spaceId: personalSpaceId, boards: projectBoards, scopeValid: () => !projectFilter.invalidScope.value,
  consoleError: computed(() => !store.state && store.runtimeStatus === 'error' ? store.feedback?.message || t('employees.loadError') : ''),
  projectNames: computed(() => new Map((store.state?.personalProjects ?? []).filter(p => p.personal_space_id === personalSpaceId.value).map(p => [p.project_id, p.profile.name]))),
}))
const template = computed(() => isJefa.value ? jefaRead.template : employeeTemplates.value.find((entry) => entry.id === templateId.value))
const nativeWorkbenchView = computed(() => {
  const workbench = template.value?.workbench
  return workbench?.kind === 'native' ? (workbench as { view?: string }).view ?? null : null
})
const isNativePeople = computed(() => nativeWorkbenchView.value === 'people')
const isNativeJudgment = computed(() => nativeWorkbenchView.value === 'judgment')
// Astro receives conversations no project has claimed yet.
const isNativeUnclaimed = computed(() => nativeWorkbenchView.value === 'unclaimed')
const isNativeWorkbench = computed(() => isNativePeople.value || isNativeJudgment.value || isNativeUnclaimed.value)
const spaceProjects = computed(() => (store.state?.personalProjects ?? []).filter(project => project.personal_space_id === personalSpaceId.value))
const pageLoading = computed(() => isJefa.value ? jefaRead.loading && !jefaRead.hasContent : (!store.state
  && (store.runtimeStatus === 'idle' || store.runtimeStatus === 'loading'))
  || !catalogReady.value || loading.value)
const pageLoadingLabel = computed(() => !store.state
  ? t('common.status.loadingConsole')
  : employeeCatalogLoading.value || !catalogReady.value
    ? t('employees.loading') : t('employees.loadingBoard'))
const pageError = computed(() => !store.state && store.runtimeStatus === 'error'
  ? store.feedback?.message || t('employees.loadError') : '')
const visibleError = computed(() => isJefa.value ? (projectFilter.invalidScope.value ? t('employees.invalidScope') : '') : pageError.value || employeeCatalogError.value || error.value)
const ALL_PROJECTS = 'all'
const managedProjectOptions = computed(() => isJefa.value ? jefaRead.projects.map(p => ({ value: p.id, label: p.name })) : template.value?.managedProjects !== undefined
  ? template.value.managedProjects.map(project => ({ value: project.id, label: project.name }))
  : (template.value?.assignments ?? []).filter(assignment => assignment.status === 'active').map((assignment) => ({
  value: assignment.personalProjectId,
  label: store.state?.personalProjects?.find((project) => project.project_id === assignment.personalProjectId)?.profile.name ?? assignment.personalProjectId,
})))
const managedProjectSignature = computed(() => JSON.stringify(
  [...new Set(managedProjectOptions.value.map(project => project.value))].sort(),
))
watch([personalSpaceId, isJefa], ([id]) => {
  if (isJefa.value) return
  catalogReady.value = false
  void refreshEmployeeCatalog(id)
}, { immediate: true })
const projectFilter = useProjectBoardFilter({
  enabled: isJefa,
  spaceId: personalSpaceId,
  projectIds: computed(() => managedProjectOptions.value.map(project => project.value)),
  ready: computed(() => isJefa.value ? Boolean(jefaRead.template) : !employeeCatalogLoading.value && !employeeCatalogError.value && Boolean(template.value)),
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
watch([projectOptions, () => route.query.project, () => route.query.empty, templateId, isNativeWorkbench], () => {
  if (isNativeWorkbench.value) {
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
  if (!isJefa.value && !isNativeWorkbench.value && catalogReady.value) void loadWorkspace()
}, { immediate: true })
watch(employeeCatalogLoading, (catalogLoading) => {
  if (isJefa.value) return
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
watch(managedProjectSignature, (signature, previous) => {
  if (isJefa.value || signature === previous || !catalogReady.value || isNativeWorkbench.value) return
  void loadWorkspace()
})
watch(projectFilter.invalidScope, (invalid, previous) => {
  if (isJefa.value && previous && !invalid) jefaRead.scopeChanged()
})
watch([employeeTemplates, employeeCatalogLoading, employeeCatalogError], ([templates, catalogLoading, catalogError]) => {
  if (!isJefa.value || !jefaRead.template || catalogLoading || catalogError) return
  const candidate = templates.find(t => t.id === 'jefa')
  const signature = (value: typeof candidate) => JSON.stringify(value && [value.assignmentsVersion, value.managedProjects, value.assignments, value.permissions, value.runtimeStatus])
  if (signature(candidate) !== signature(jefaRead.template)) jefaRead.scopeChanged(candidate ?? null)
})
watch([() => jefaRead.projects, () => jefaRead.failures, () => jefaRead.template], () => {
  if (!isJefa.value || !taskOpen.value) return
  const project = selectedTask.value?.projectId
  const revoked = project && (!jefaRead.projects.some(p => p.id === project)
    || jefaRead.failures.some(f => f.projectId === project && ['HTTP 401', 'HTTP 403', 'HTTP 404'].includes(f.category)))
  if (revoked || !jefaRead.template?.permissions.includes('board.read')) {
    taskOpen.value = false
    selectedTask.value = null
  }
})
async function loadWorkspace() {
  if (isJefa.value) { jefaRead.reload(); return }
  const current = ++version
  workspace.value = null
  projectBoards.value = []
  failedProjectIds.value = []
  boardActionError.value = ''
  error.value = ''
  if (isNativeWorkbench.value || !template.value || !projectId.value || !personalSpaceId.value) { loading.value = false; return }
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
  if (isJefa.value && jefaRead.readOnly) return
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
async function retry() {
  if (isJefa.value) { if (!store.state) void store.refresh(); jefaRead.reload(); return }
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
    jefaRead.scopeChanged()
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
        <h1>{{ template?.name ?? (isJefa ? 'Jefa' : t('employees.workbench')) }} <span>{{ isJefa ? t('employees.read.role') : template?.role }}</span></h1>
        <button v-if="isJefa && supportsAllProjects" class="employee-share-button" type="button" :aria-label="t('employees.share.title')" :title="t('employees.share.title')" @click="shareOpen = true">
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3h7v7m0-7-9 9M10 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/><path d="M7 16v-3m4 3v-1"/></svg>
        </button>
      </div>
      <div class="employee-workbench-actions">
        <RouterLink v-if="isNativeWorkbench && template?.agentId && personalSpaceId" class="employee-native-link" :to="agentProfilePath(personalSpaceId, template.agentId)" :title="t('agentProfiles.profile')">
          {{ t('agentProfiles.profile') }}
        </RouterLink>
        <button v-if="template && !isNativeWorkbench" class="employee-manage-projects" type="button" :disabled="!personalSpaceId" @click="manageProjectsOpen = true">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M4 7h9m4 0h3M4 17h3m4 0h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></svg>
          {{ t('employees.manageProjects') }}
        </button>
      </div>
    </header>
    <EmployeeRecruitDialog v-if="!isNativeWorkbench" :open="manageProjectsOpen" :personal-space-id="personalSpaceId" :projects="store.state?.personalProjects ?? []" :template-id="templateId" @close="manageProjectsOpen = false" @recruited="projectsSaved" />
    <EmployeeTaskDialog v-if="isJefa" :open="taskOpen" :item="selectedTask" :projects="managedProjectOptions.map(project => ({ id: project.value, name: project.label }))" :default-project-id="visibleProjectIds.length === 1 ? visibleProjectIds[0] : undefined" :personal-space-id="personalSpaceId" :can-write="!jefaRead.readOnly && (template?.permissions.includes('board.write') ?? false)" @close="taskOpen = false" @saved="loadWorkspace" />
    <EmployeeShareDialog v-if="isJefa" :open="shareOpen" :projects="managedProjectOptions.map(project => ({ id: project.value, name: project.label }))" @close="shareOpen = false" />
    <JefaReadStatus v-if="isJefa && !projectFilter.invalidScope.value"
      :loading="jefaRead.loading" :long-wait="jefaRead.longWait" :stage="jefaRead.stage"
      :timed-out="jefaRead.timedOut" :failure="jefaRead.failure" :failures="jefaRead.failures"
      :total="jefaRead.projects.length" :loaded="jefaRead.loadedIds.length" :pending="jefaRead.pendingIds.length"
      :has-content="jefaRead.hasContent" :stale="jefaRead.stale" :updated-at="jefaRead.updatedAt" @reload="retry"
    />
    <GrowthLoading v-if="pageLoading && !isJefa" :label="pageLoadingLabel" />
    <div v-else-if="visibleError" class="employee-workbench-state" role="alert"><p>{{ visibleError }}</p><UiButton size="sm" variant="ghost" @click="retry">{{ t('employees.retry') }}</UiButton></div>
    <div v-else-if="!template && !(isJefa && (jefaRead.loading || jefaRead.timedOut || jefaRead.failure))" class="employee-workbench-state"><p>{{ t('employees.unavailable') }}</p><RouterLink to="/project-agents">{{ t('employees.backToAgents') }}</RouterLink></div>
    <BolePeoplePanel v-else-if="isNativePeople" :personal-space-id="personalSpaceId" :projects="store.state?.personalProjects ?? []" />
    <JudgmentWorkbench v-else-if="isNativeJudgment" :personal-space-id="personalSpaceId" />
    <UnassignedConversationsPanel v-else-if="isNativeUnclaimed" class="employee-workbench-unclaimed" :space-id="personalSpaceId" :formal-projects="spaceProjects.filter(isFormalProject)" :existing-project-ids="spaceProjects.map(project => project.project_id)" @project-created="store.rememberPersonalProject" />
    <div v-else-if="isJefa && template && !jefaRead.loading && template.runtimeStatus !== 'ready'" class="employee-workbench-state"><p>{{ t('employees.installRequired') }}</p><small>{{ t('employees.installHelp') }}</small></div>
    <div v-else-if="!projectId && !(isJefa && (jefaRead.loading || jefaRead.timedOut || jefaRead.failure))" class="employee-workbench-state"><h2>{{ t('employees.emptyWorkbench') }}</h2><p>{{ t('employees.manageHint') }}</p><UiButton size="sm" variant="ghost" @click="manageProjectsOpen = true">{{ t('employees.manageProjects') }}</UiButton></div>
    <EmployeeTaskBoard
      v-else-if="projectId === ALL_PROJECTS && supportsAllProjects && (!isJefa || jefaRead.hasContent)"
      v-model:visible-project-ids="visibleProjectIds"
      :boards="visibleProjectBoards"
      :projects="managedProjectOptions.map((project) => ({ id: project.value, name: project.label }))"
      :failed-projects="isJefa ? 0 : visibleFailedProjects"
      :can-move-tasks="(!isJefa || !jefaRead.readOnly) && (template?.permissions.includes('board.write') ?? false)"
      :read-only="isJefa && jefaRead.readOnly"
      :allow-read-only-details="isJefa"
      :incomplete="isJefa && (jefaRead.loading || jefaRead.failures.length > 0)"
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
.employee-workbench-view { display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0; overflow: hidden; background: var(--color-surface); }
.employee-workbench-toolbar { display: flex; flex: 0 0 auto; align-items: center; justify-content: space-between; gap: 20px; padding: 16px 24px 10px; }
.employee-workbench-identity { display: flex; align-items: center; gap: 10px; min-width: 0; }
.employee-workbench-mark { display: grid; place-items: center; flex: 0 0 32px; height: 32px; overflow: hidden; border-radius: var(--radius-control); background: var(--color-surface-subtle); color: var(--color-ink); font-size: 17px; font-weight: 650; }
.employee-workbench-mark img { width: 100%; height: 100%; object-fit: cover; }
.employee-share-button { display: grid; place-items: center; flex: 0 0 40px; width: 40px; height: 40px; border: 0; border-radius: var(--radius-control); color: var(--color-ink); background: transparent; cursor: pointer; }
.employee-share-button:hover { background: var(--color-surface-subtle); }
.employee-share-button:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }
.employee-workbench-toolbar h1 { margin: 0; color: var(--color-ink); font-size: 18px; font-weight: 650; line-height: 1.4; overflow-wrap: anywhere; }
.employee-workbench-toolbar h1 span { margin-left: 8px; color: var(--color-muted); font-size: 12px; font-weight: 400; }
.employee-workbench-actions { display: flex; align-items: center; gap: 12px; min-width: 0; }
.employee-native-link { display: inline-flex; align-items: center; min-height: 40px; padding: 8px 10px; border-radius: var(--radius-control); color: var(--color-ink); font-size: 13px; text-decoration: none; }
.employee-native-link:hover { background: var(--color-surface-subtle); }
.employee-native-link:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 3px; }
.employee-manage-projects, .employee-back-to-all { display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-height: 40px; padding: 8px 10px; border: 0; border-radius: var(--radius-control); background: transparent; color: var(--color-ink); font: inherit; font-size: 13px; cursor: pointer; white-space: nowrap; }
.employee-manage-projects:hover:not(:disabled), .employee-back-to-all:hover { background: var(--color-surface-subtle); }
.employee-manage-projects:disabled { color: var(--color-muted); cursor: default; }
.employee-manage-projects:focus-visible, .employee-back-to-all:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 3px; }
.employee-workbench-frame { flex: 1; width: 100%; height: 100%; min-height: 0; border: 0; }
.employee-workbench-unclaimed { margin: 16px 24px; }
@media (max-width: 640px) { .employee-workbench-unclaimed { margin: 12px; } }
.employee-workbench-state { display: grid; flex: 1; gap: 14px; place-content: center; justify-items: center; padding: 30px; color: var(--color-muted); font-size: 14px; text-align: center; }
.employee-workbench-state a { color: var(--color-ink); }
.employee-workbench-state h2 { font-size: 20px; font-weight: 600; color: var(--color-ink); }
.employee-workbench-state p { margin: 0; max-width: 48ch; line-height: 1.7; }
@media (max-width: 640px) { .employee-workbench-toolbar { flex-wrap: wrap; gap: 10px; padding: 8px 16px 10px; }.employee-workbench-actions { width: 100%; justify-content: flex-end; gap: 8px; }.employee-workbench-toolbar h1 span { margin-left: 6px; } }
</style>
