<script setup lang="ts">
import { Button } from '@/components/ui/button'
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { isEmployeeBoardItem } from '@/features/employees/task-board-model'
import { useJefaBoardLoad } from '@/features/employees/useJefaBoardLoad'
import JefaReadStatus from '@/features/employees/JefaReadStatus.vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { getJson, patchJson, postJson } from '@/api/client'
import BackLink from '@/components/BackLink.vue'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { useRoutePeek } from '@/composables/useRoutePeek'
import { usePageTitle } from '@/layouts/page-title'
import { boardTaskAccessRevoked, boardTaskPeekId, readBoardTaskPeekId } from '@/features/employees/board-task-peek'
import EmployeeTaskBoard, { type EmployeeBoardItem, type EmployeeBoardStatus, type EmployeeProjectBoard } from '@/features/employees/EmployeeTaskBoard.vue'
import EmployeeRecruitDialog from '@/features/employees/EmployeeRecruitDialog.vue'
import BolePeoplePanel from '@/features/employees/BolePeoplePanel.vue'
import UnassignedConversationsPanel from '@/features/agent-profile/UnassignedConversationsPanel.vue'
import { isFormalProject } from '@/features/projects/project-origin'
import EmployeeTaskDialog from '@/features/employees/EmployeeTaskDialog.vue'
import EmployeeShareDialog from '@/features/employees/EmployeeShareDialog.vue'
import { employeeAvatarUrl } from '@/features/employees/avatars'
import { useProjectBoardFilter } from '@/features/employees/project-board-filter'
import { provideWorkbenchToolbarActions } from '@/features/employees/workbench-toolbar'
import JudgmentWorkbench from '@/features/judgment/JudgmentWorkbench.vue'
import UiIcon from '@/ui/UiIcon.vue'
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
const createTaskOpen = ref(false)
const personalSpaceId = computed(() => store.activePersonalSpace?.id ?? '')
const templateId = computed(() => String(route.params.templateId ?? ''))
const isJefa = computed(() => templateId.value === 'jefa')
const jefaRead = reactive(useJefaBoardLoad({
  enabled: isJefa, spaceId: personalSpaceId, boards: projectBoards, scopeValid: () => !projectFilter.invalidScope.value,
  consoleError: computed(() => !store.state && store.runtimeStatus === 'error' ? store.feedback?.message || t('employees.loadError') : ''),
  projectNames: computed(() => new Map((store.state?.personalProjects ?? []).filter(p => p.personal_space_id === personalSpaceId.value).map(p => [p.project_id, p.profile.name]))),
}))
const template = computed(() => isJefa.value ? jefaRead.template : employeeTemplates.value.find((entry) => entry.id === templateId.value))
// The shell's H1 is the Agent's own name; the route title stands in until it is read.
usePageTitle(() => template.value?.name ?? (isJefa.value ? 'Jefa' : ''))
const openedFromAgents = /^\/project-agents(\?|$)/
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
watch([templateId, personalSpaceId], () => { excludedProjectIds.value = []; createTaskOpen.value = false; shareOpen.value = false })
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
// A board task's details are a quick look in the URL (?item=<space>/<project>:<task>):
// a refresh or a shared link reads that exact task, whether or not the board has it yet.
const peek = useRoutePeek()
const openTaskRef = computed(() => isJefa.value && peek.item.value && peek.item.value.spaceId === personalSpaceId.value
  ? readBoardTaskPeekId(peek.item.value.id) : null)
// Only an authoritative answer closes it; a pending or failed read keeps the link.
const openTaskRevoked = computed(() => Boolean(openTaskRef.value) && boardTaskAccessRevoked(openTaskRef.value!, jefaRead))
watch(openTaskRevoked, (revoked) => { if (revoked) void peek.close() }, { immediate: true })
// A revoked task leaves the dialog at once (ending its read in flight), before the URL catches up.
const shownTaskRef = computed(() => (openTaskRevoked.value ? null : openTaskRef.value))
const pageRoot = ref<HTMLElement | null>(null)
// Bole and Tonborg put their actions in this row instead of a title row of their own.
const toolbarActions = ref<HTMLElement | null>(null)
provideWorkbenchToolbarActions(toolbarActions)
// A shared link scrolls its card into view once, after the board shows it.
let scrolledTo = ''
watch([openTaskRef, visibleProjectBoards], async ([task, boards]) => {
  if (!task) { scrolledTo = ''; return }
  const key = boardTaskPeekId(task)
  if (scrolledTo === key || !boards.some(board => board.items.some(item => item.projectId === task.projectId && item.id === task.id))) return
  scrolledTo = key
  await nextTick()
  pageRoot.value?.querySelector(`[data-board-task="${key.replace(/["\\]/g, '\\$&')}"]`)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
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
function openTask(item: EmployeeBoardItem | null = null) {
  if (item) void peek.open({ spaceId: personalSpaceId.value, id: boardTaskPeekId(item) })
  else createTaskOpen.value = true
}
function closeTaskDialog() {
  createTaskOpen.value = false
  if (openTaskRef.value) void peek.close()
}
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
  <section ref="pageRoot" class="view employee-workbench-view" :class="{ 'fills-height': !isNativeWorkbench }" :aria-label="template?.name ?? t('employees.workbench')">
   <!-- The board and the iframe fill the canvas and scroll inside; a native panel scrolls with the page. -->
   <div class="employee-workbench-canvas mx-auto flex w-full max-w-(--canvas-max) flex-col gap-3">
    <!-- The Agent's name is the shell's H1; this row says only what the name does not. -->
    <header class="employee-workbench-toolbar">
      <BackLink class="employee-workbench-back" to="/project-agents" :from="openedFromAgents">{{ t('agentProfiles.back') }}</BackLink>
      <div class="employee-workbench-identity">
        <span class="employee-workbench-mark" aria-hidden="true">
          <img v-if="employeeAvatarUrl(templateId)" :src="employeeAvatarUrl(templateId)" alt="" />
          <template v-else>{{ template?.name.slice(0, 1) ?? 'A' }}</template>
        </span>
        <span class="employee-workbench-role" data-employee-role>{{ isJefa ? t('employees.read.role') : template?.role }}</span>
        <Button v-if="isJefa && supportsAllProjects" variant="ghost" size="icon" class="employee-share-button" :aria-label="t('employees.share.title')" :title="t('employees.share.title')" @click="shareOpen = true">
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3h7v7m0-7-9 9M10 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/><path d="M7 16v-3m4 3v-1"/></svg>
        </Button>
        <Button v-if="isNativeWorkbench && template?.agentId && personalSpaceId" as-child variant="ghost" size="icon" class="employee-native-link">
          <RouterLink :to="agentProfilePath(personalSpaceId, template.agentId)" :aria-label="t('agentProfiles.profile')" :title="t('agentProfiles.profile')">
            <UiIcon name="agents" :size="18" />
          </RouterLink>
        </Button>
      </div>
      <div ref="toolbarActions" class="employee-workbench-actions">
        <Button v-if="template && !isNativeWorkbench" variant="ghost" class="employee-manage-projects" :disabled="!personalSpaceId" @click="manageProjectsOpen = true">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M4 7h9m4 0h3M4 17h3m4 0h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></svg>
          {{ t('employees.manageProjects') }}
        </Button>
      </div>
    </header>
    <EmployeeRecruitDialog v-if="!isNativeWorkbench" :open="manageProjectsOpen" :personal-space-id="personalSpaceId" :projects="store.state?.personalProjects ?? []" :template-id="templateId" @close="manageProjectsOpen = false" @recruited="projectsSaved" />
    <EmployeeTaskDialog v-if="isJefa" :open="createTaskOpen || Boolean(shownTaskRef)" :item="shownTaskRef" :projects="managedProjectOptions.map(project => ({ id: project.value, name: project.label }))" :default-project-id="visibleProjectIds.length === 1 ? visibleProjectIds[0] : undefined" :personal-space-id="personalSpaceId" :can-write="!jefaRead.readOnly && (template?.permissions.includes('board.write') ?? false)" @close="closeTaskDialog" @saved="loadWorkspace" />
    <EmployeeShareDialog v-if="isJefa" :open="shareOpen" :projects="managedProjectOptions.map(project => ({ id: project.value, name: project.label }))" @close="shareOpen = false" />
    <JefaReadStatus v-if="isJefa && !projectFilter.invalidScope.value"
      :loading="jefaRead.loading" :long-wait="jefaRead.longWait" :stage="jefaRead.stage"
      :timed-out="jefaRead.timedOut" :failure="jefaRead.failure" :failures="jefaRead.failures"
      :total="jefaRead.projects.length" :loaded="jefaRead.loadedIds.length" :pending="jefaRead.pendingIds.length"
      :has-content="jefaRead.hasContent" :stale="jefaRead.stale" :updated-at="jefaRead.updatedAt" @reload="retry"
    />
    <GrowthLoading v-if="pageLoading && !isJefa" :label="pageLoadingLabel" />
    <div v-else-if="visibleError" class="employee-workbench-state" role="alert"><p>{{ visibleError }}</p><Button size="sm" variant="ghost" @click="retry">{{ t('employees.retry') }}</Button></div>
    <div v-else-if="!template && !(isJefa && (jefaRead.loading || jefaRead.timedOut || jefaRead.failure))" class="employee-workbench-state"><p>{{ t('employees.unavailable') }}</p></div>
    <BolePeoplePanel v-else-if="isNativePeople" :personal-space-id="personalSpaceId" :projects="store.state?.personalProjects ?? []" />
    <JudgmentWorkbench v-else-if="isNativeJudgment" :personal-space-id="personalSpaceId" />
    <UnassignedConversationsPanel v-else-if="isNativeUnclaimed" :space-id="personalSpaceId" :formal-projects="spaceProjects.filter(isFormalProject)" :existing-project-ids="spaceProjects.map(project => project.project_id)" @project-created="store.rememberPersonalProject" />
    <div v-else-if="isJefa && template && !jefaRead.loading && template.runtimeStatus !== 'ready'" class="employee-workbench-state"><p>{{ t('employees.installRequired') }}</p><small>{{ t('employees.installHelp') }}</small></div>
    <div v-else-if="!projectId && !(isJefa && (jefaRead.loading || jefaRead.timedOut || jefaRead.failure))" class="employee-workbench-state"><h2>{{ t('employees.emptyWorkbench') }}</h2><p>{{ t('employees.manageHint') }}</p><Button size="sm" variant="ghost" @click="manageProjectsOpen = true">{{ t('employees.manageProjects') }}</Button></div>
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
      :selected-task="openTaskRef"
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
   </div>
  </section>
</template>

<style scoped>
.employee-workbench-view { display: flex; flex-direction: column; }
/* The board and the workbench iframe take the rest of the canvas and scroll
   inside it, so the page itself does not scroll behind them. */
.employee-workbench-view.fills-height { overflow: hidden; padding-bottom: 16px; }
.employee-workbench-canvas { flex: 1 0 auto; }
.fills-height .employee-workbench-canvas { flex: 1 1 0; min-height: 0; }
.employee-workbench-toolbar { display: flex; flex: 0 0 auto; flex-wrap: wrap; align-items: center; gap: 8px 16px; }
.employee-workbench-back { color: var(--color-muted); font-size: 13px; text-decoration: none; }
.employee-workbench-back:hover { color: var(--color-ink); }
.employee-workbench-identity { display: flex; align-items: center; gap: 8px; min-width: 0; }
.employee-workbench-mark { display: grid; place-items: center; flex: 0 0 28px; height: 28px; overflow: hidden; border-radius: var(--radius-control); background: var(--color-surface-subtle); color: var(--color-ink); font-size: 15px; font-weight: 650; }
.employee-workbench-mark img { width: 100%; height: 100%; object-fit: cover; }
.employee-workbench-role { color: var(--color-muted); font-size: 13px; overflow-wrap: anywhere; }
.employee-workbench-actions { display: flex; align-items: center; gap: 8px; min-width: 0; margin-left: auto; }
/* On the canvas the board needs no frame of its own. */
.employee-workbench-view :deep(.employee-all-projects) { padding: 0; background: transparent; }
.employee-workbench-frame { flex: 1; width: 100%; min-height: 0; border: 1px solid var(--color-border); border-radius: var(--radius-card); background: var(--color-surface); }
.employee-workbench-state { display: grid; flex: 1; gap: 14px; place-content: center; justify-items: center; padding: 30px; color: var(--color-muted); font-size: 14px; text-align: center; }
.employee-workbench-state h2 { font-size: 20px; font-weight: 600; color: var(--color-ink); }
.employee-workbench-state p { margin: 0; max-width: 48ch; line-height: 1.7; }
</style>
