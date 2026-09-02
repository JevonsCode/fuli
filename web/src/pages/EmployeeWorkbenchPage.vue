<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { getJson } from '@/api/client'
import SearchableSelect from '@/components/SearchableSelect.vue'
import EmployeeRecruitDialog from '@/features/employees/EmployeeRecruitDialog.vue'
import { useConsoleStore } from '@/stores/console'
import { t } from '@/i18n'
import { employeeTemplates, employeeCatalogError, employeeCatalogLoading, employeeErrorMessage, refreshEmployeeCatalog, type EmployeeWorkspace } from '@/features/employees/catalog'

const route = useRoute()
const router = useRouter()
const store = useConsoleStore()
const projectId = ref('')
const workspace = ref<EmployeeWorkspace | null>(null)
const error = ref('')
const loading = ref(false)
const manageProjectsOpen = ref(false)
const personalSpaceId = computed(() => store.activePersonalSpace?.id ?? '')
const templateId = computed(() => String(route.params.templateId ?? ''))
const template = computed(() => employeeTemplates.value.find((entry) => entry.id === templateId.value))
const visibleError = computed(() => employeeCatalogError.value || error.value)
const projectOptions = computed(() => template.value?.managedProjects !== undefined
  ? template.value.managedProjects.map(project => ({ value: project.id, label: project.name }))
  : (template.value?.assignments ?? []).filter(assignment => assignment.status === 'active').map((assignment) => ({
  value: assignment.personalProjectId,
  label: store.state?.personalProjects?.find((project) => project.project_id === assignment.personalProjectId)?.profile.name ?? assignment.personalProjectId,
})))
let version = 0
watch(personalSpaceId, (id) => { void refreshEmployeeCatalog(id) }, { immediate: true })
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
watch([templateId, projectId, personalSpaceId], () => { void loadWorkspace() }, { immediate: true })
async function loadWorkspace() {
  const current = ++version
  workspace.value = null
  error.value = ''
  if (!projectId.value || !personalSpaceId.value) { loading.value = false; return }
  loading.value = true
  const requestedTemplate = templateId.value
  const requestedProject = projectId.value
  try {
    const result = await getJson<EmployeeWorkspace>(`/api/employee-templates/${encodeURIComponent(requestedTemplate)}/workspace?${new URLSearchParams({ personalSpaceId: personalSpaceId.value, personalProjectId: requestedProject })}`)
    const prefix = `/employee-workspaces/${encodeURIComponent(requestedTemplate)}/${encodeURIComponent(requestedProject)}/`
    if (result.workbenchUrl !== prefix) throw new Error(t('employees.loadError'))
    if (current === version) workspace.value = result
  } catch (cause) { if (current === version) error.value = employeeErrorMessage(cause) }
  finally { if (current === version) loading.value = false }
}
function changeProject(value: string) { void router.replace({ query: { ...route.query, project: value } }) }
async function retry() {
  await refreshEmployeeCatalog(personalSpaceId.value)
  if (!employeeCatalogError.value) await loadWorkspace()
}
async function projectsSaved() {
  const current = projectOptions.value.find((option) => option.value === projectId.value)?.value
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
        <span class="employee-workbench-mark" aria-hidden="true">{{ template?.name.slice(0, 1) ?? 'A' }}</span>
        <h1>{{ template?.name ?? t('employees.workbench') }} <span>{{ template?.role }}</span></h1>
      </div>
      <div class="employee-workbench-actions">
        <div v-if="projectOptions.length" class="employee-workbench-project-view" :title="t('employees.viewingHint')">
          <SearchableSelect :model-value="projectId" control-id="workbench-project" :label="t('employees.viewingProject')" :options="projectOptions" @update:model-value="changeProject" />
        </div>
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
    <div v-else-if="workspace?.runtimeStatus !== 'ready'" class="employee-workbench-state"><p>{{ t('employees.installRequired') }}</p><small>{{ t('employees.installHelp') }}</small></div>
    <iframe v-else-if="workspace" :key="workspace.workbenchUrl" :src="workspace.workbenchUrl" :title="`${workspace.name} · ${workspace.project.name}`" class="employee-workbench-frame" />
  </section>
</template>

<style scoped>
.employee-workbench-view { display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0; overflow: hidden; background: #fff; }
.employee-workbench-toolbar { display: flex; flex: 0 0 auto; align-items: center; justify-content: space-between; gap: 20px; padding: 16px 24px 10px; }
.employee-workbench-identity { display: flex; align-items: center; gap: 10px; min-width: 0; }
.employee-workbench-mark { display: grid; place-items: center; flex: 0 0 32px; height: 32px; border-radius: 9px; background: #eaf0ec; color: #315c43; font-size: 17px; font-weight: 650; }
.employee-workbench-toolbar h1 { margin: 0; color: #253c2f; font-size: 18px; font-weight: 650; line-height: 1.4; overflow-wrap: anywhere; }
.employee-workbench-toolbar h1 span { margin-left: 8px; color: #59685f; font-size: 12px; font-weight: 400; }
.employee-workbench-toolbar :deep(.searchable-select) { width: min(240px, 30vw); }
.employee-workbench-actions { display: flex; align-items: center; gap: 12px; min-width: 0; }
.employee-workbench-project-view { min-width: 0; }
.employee-manage-projects { display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-height: 40px; padding: 8px 10px; border: 0; border-radius: 8px; background: transparent; color: #465b4d; font: inherit; font-size: 13px; cursor: pointer; white-space: nowrap; }
.employee-manage-projects:hover:not(:disabled) { background: #e2ece5; }
.employee-manage-projects:disabled { color: #647568; cursor: default; }
.employee-manage-projects:focus-visible { outline: 2px solid #356448; outline-offset: 3px; }
.employee-workbench-frame { flex: 1; width: 100%; height: 100%; min-height: 0; border: 0; }
.employee-workbench-state { display: grid; flex: 1; gap: 14px; place-content: center; justify-items: center; padding: 30px; color: #58695e; font-size: 14px; text-align: center; }
.employee-workbench-state a { color: #315c43; }
.employee-workbench-state h2 { font-size: 20px; font-weight: 600; color: #253c2f; }
.employee-workbench-state p { margin: 0; max-width: 48ch; line-height: 1.7; }
@media (max-width: 640px) { .employee-workbench-toolbar { flex-wrap: wrap; gap: 10px; padding: 8px 16px 10px; }.employee-workbench-actions { width: 100%; gap: 8px; }.employee-workbench-project-view { flex: 1; }.employee-workbench-project-view :deep(.searchable-select) { width: 100%; }.employee-workbench-toolbar h1 span { margin-left: 6px; } }
</style>
