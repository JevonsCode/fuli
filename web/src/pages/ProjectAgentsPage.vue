<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import BackToTop from '@/components/BackToTop.vue'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { focusReturnTarget, useFocusReturn } from '@/composables/useFocusReturn'
import { useRoutePeek } from '@/composables/useRoutePeek'
import { useScrollRestoration } from '@/composables/useScrollRestoration'
import AgentPeek from '@/features/agent-profile/AgentPeek.vue'
import { employeeTemplateIdForAgent, employeeTemplates, type EmployeeRecruitmentResult } from '@/features/employees/catalog'
import EmployeeRecruitDialog from '@/features/employees/EmployeeRecruitDialog.vue'
import ProjectScopePicker from '@/features/employees/ProjectScopePicker.vue'
import { currentAssignmentsFor, currentWorkEntry } from '@/features/project-agents/agent-roster-records'
import { linkedTaskOwner } from '@/features/project-agents/linked-task-owner'
import {
  agentManagementPath,
  agentSearchText,
  compareOrchestrationAgents,
  orchestrationFilterQuery,
  readOrchestrationFilters,
  type OrchestrationFilters,
  type OrchestrationStatus,
} from '@/features/project-agents/orchestration-filters'
import ProjectAgentAutomationPolicyPanel from '@/features/project-agents/ProjectAgentAutomationPolicyPanel.vue'
import ProjectAgentCard from '@/features/project-agents/ProjectAgentCard.vue'
import ProjectAgentFirstTask from '@/features/project-agents/ProjectAgentFirstTask.vue'
import { useProjectAgentRoster } from '@/features/project-agents/useProjectAgentRoster'
import ProjectAgentDialog from '@/features/projects/ProjectAgentDialog.vue'
import { currentLocale, t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import type { ProjectAgentRecord } from '@/types'
import UiSegmented from '@/ui/UiSegmented.vue'

// 编排: every Agent of the space on one canvas. A name opens that Agent's
// management page; a quick look (Peek) answers a quick question in place.
const store = useConsoleStore()
const route = useRoute()
const router = useRouter()
const spaceId = computed(() => store.activePersonalSpace?.id ?? '')
const roster = useProjectAgentRoster(spaceId)
const agents = roster.agents
const projects = computed(() => store.state?.personalProjects ?? [])
const projectById = computed(() => new Map(projects.value.map((project) => [project.project_id, project])))
const projectOptions = computed(() => projects.value.map((project) => ({ id: project.project_id, name: project.profile.name })))
const projectName = (projectId: string) => projectById.value.get(projectId)?.profile.name ?? projectId

const pageLoading = computed(() => roster.loading.value || (!store.state
  && (store.runtimeStatus === 'idle' || store.runtimeStatus === 'loading')))
const pageError = computed(() => roster.error.value || (!store.state && store.runtimeStatus === 'error'
  ? store.feedback?.message || t('projectAgents.loadError') : ''))
function retryPage() {
  if (!store.state) void store.refresh()
  else void roster.load()
}
onMounted(() => {
  if (store.runtimeStatus === 'idle') void store.refresh()
})

// An older link names one Agent (?agent=, often with ?task=): it opens that
// Agent's own page, keeping the task scope and its #task- anchor. A task link
// without an Agent opens the page of the Agent responsible for it, once the
// space's Agents are read: from their open work, or else from the task itself,
// so an ended task opens too.
const linkedAgent = computed(() => typeof route.query.agent === 'string' ? route.query.agent : '')
const linkedTask = computed(() => typeof route.query.task === 'string' ? route.query.task : '')
const linkedProject = computed(() => typeof route.query.project === 'string' ? route.query.project : '')
const resolvingTask = ref('')
const taskLinkUnavailable = ref(false)
function openAgentPage(space: string, agentId: string) {
  const { agent: _linked, ...query } = route.query
  void router.replace({ path: agentManagementPath(space, agentId), query, hash: route.hash })
}
let taskLookup = 0
watch([spaceId, linkedAgent, linkedTask, roster.loading], async ([space, agentId, taskId, rosterLoading]) => {
  const lookup = ++taskLookup
  resolvingTask.value = ''
  taskLinkUnavailable.value = false
  if (!space) return
  if (agentId) return openAgentPage(space, agentId)
  if (!taskId) return
  // Finding the Agent starts with the space's Agents, so one indicator covers both reads.
  resolvingTask.value = taskId
  if (rosterLoading) return
  const owner = agents.value.find((agent) => agent.tasks?.some((task) => task.taskId === taskId))?.agentId
    || await linkedTaskOwner({
      personalSpaceId: space, taskId, personalProjectId: linkedProject.value,
      spaceAgentId: (id) => roster.find(id)?.agentId,
    })
  if (lookup !== taskLookup) return
  resolvingTask.value = ''
  if (owner) openAgentPage(space, owner)
  else taskLinkUnavailable.value = true
}, { immediate: true })

// Filters are the URL (?project=, ?status=, ?q=); see orchestration-filters.
const filters = computed(() => readOrchestrationFilters(route.query))
// Changes made before the URL catches up build on each other, not on the URL.
let pendingFilters: OrchestrationFilters | null = null
watch(() => route.query, () => { pendingFilters = null })
function setFilters(change: Partial<OrchestrationFilters>) {
  pendingFilters = { ...(pendingFilters ?? filters.value), ...change }
  void router.replace({ query: orchestrationFilterQuery(route.query, pendingFilters) })
}
// Unknown project ids (a stale link) do not hide every Agent.
const projectFilter = computed(() => {
  const chosen = filters.value.projects
  if (!chosen) return null
  const known = chosen.filter((id) => projectById.value.has(id))
  return chosen.length && !known.length ? null : known
})
const filterProjectIds = computed({
  get: () => projectFilter.value ?? projectOptions.value.map((project) => project.id),
  set: (ids: string[]) => {
    const selected = projectOptions.value.filter((project) => ids.includes(project.id)).map((project) => project.id)
    setFilters({ projects: selected.length === projectOptions.value.length ? null : selected })
  },
})
const singleFilterProjectId = computed(() => projectFilter.value?.length === 1 ? projectFilter.value[0]! : '')
const statusFilter = computed<OrchestrationStatus>({
  get: () => filters.value.status,
  set: (status) => setFilters({ status }),
})
const search = computed({
  get: () => filters.value.search,
  set: (value: string) => setFilters({ search: value }),
})
const statusOptions = computed(() => (['all', 'active', 'inactive', 'archived'] as const)
  .map((value) => ({ value, label: t(`projectAgents.status.${value}`) })))

function responsibleProjectsFor(agent: ProjectAgentRecord) {
  const templateId = employeeTemplateIdForAgent(agent)
  const employee = templateId ? employeeTemplates.value.find((entry) => entry.id === templateId) : undefined
  // Effective policy membership is not a fabricated Provider assignment or history row.
  return employee?.managedProjects ?? currentAssignmentsFor(agent).map((assignment) => ({
    id: assignment.personalProjectId, name: projectName(assignment.personalProjectId),
  }))
}
const filteredAgents = computed(() => {
  const locale = currentLocale()
  const needle = search.value.trim().toLocaleLowerCase(locale)
  return agents.value
    .filter((agent) => projectFilter.value === null
      || responsibleProjectsFor(agent).some(({ id }) => projectFilter.value!.includes(id)))
    .filter((agent) => statusFilter.value === 'all' || agent.profile.status === statusFilter.value)
    .filter((agent) => !needle || agentSearchText(agent).toLocaleLowerCase(locale).includes(needle))
    .sort((left, right) => compareOrchestrationAgents(left, right, locale))
})
const activeCount = computed(() => agents.value.filter(({ profile }) => profile.status === 'active').length)
const assignmentCount = computed(() => agents.value.reduce((count, agent) => count + currentAssignmentsFor(agent).length, 0))
const representedProjectCount = computed(() => new Set(
  agents.value.flatMap((agent) => currentAssignmentsFor(agent).map(({ personalProjectId }) => personalProjectId)),
).size)

const scroller = ref<HTMLElement | null>(null)
const listed = computed(() => filteredAgents.value.length > 0)
useScrollRestoration(scroller, 'orchestration', listed)
const focusReturn = useFocusReturn(scroller, 'orchestration', listed)

// Quick look: ?item=<space>/<agent>. A direct link opens it once the roster
// has been read; another space's Agent is never shown here.
const peek = useRoutePeek()
const peekId = computed(() => (peek.item.value?.spaceId === spaceId.value ? peek.item.value.id : ''))
const peekAgent = computed(() => (peekId.value ? roster.find(peekId.value) : null) ?? undefined)
const peekState = computed(() => {
  const item = peek.item.value
  if (!item || !spaceId.value) return pageError.value ? 'error' : 'loading'
  if (item.spaceId !== spaceId.value) return 'unavailable'
  if (peekAgent.value) return 'ready'
  if (pageLoading.value) return 'loading'
  return pageError.value ? 'error' : 'unavailable'
})
let peekOpener: HTMLElement | null = null
let lastPeekId = ''
let editAfterPeek: ProjectAgentRecord | null = null
watch(peekId, (id) => { if (id) lastPeekId = id }, { immediate: true })
function openPeek(agentId: string) {
  const active = document.activeElement
  peekOpener = active instanceof HTMLElement && active !== document.body ? active : null
  peek.open({ spaceId: spaceId.value, id: agentId })
}
// Opening lands on the main action (open the full page). A shared link opens
// the Peek while the roster is still being read: focus moves there once the
// Agent is shown.
let focusWhenReady = false
function focusPeekAction(event: Event) {
  const action = (event.target as HTMLElement | null)?.querySelector<HTMLElement>('[data-peek-open-full]')
  focusWhenReady = !action
  if (!action) return
  event.preventDefault()
  action.focus()
}
watch(() => peekState.value === 'ready', async (ready) => {
  if (!ready || !focusWhenReady) return
  focusWhenReady = false
  await nextTick()
  document.querySelector<HTMLElement>('[data-agent-peek-dialog] [data-peek-open-full]')?.focus()
})
function peekOpenChange(open: boolean) {
  if (!open) peek.close()
}
function peekClosed(event: Event) {
  event.preventDefault()
  const opener = peekOpener
  peekOpener = null
  // Editing from the quick look opens the edit dialog only once the Peek is
  // gone, so one dialog is open at a time.
  if (editAfterPeek) {
    openEdit(editAfterPeek)
    editAfterPeek = null
    return
  }
  if (opener?.isConnected) opener.focus({ preventScroll: true })
  else focusReturnTarget(scroller.value, lastPeekId)
}
function editFromPeek() {
  if (!peekAgent.value) return
  editAfterPeek = peekAgent.value
  peek.close()
}
// The full page replaces the Peek in history, so Back returns to the
// collection (filters, scroll and focus on this card), not to the Peek.
function openFullPage() {
  const agent = peekAgent.value
  if (!agent) return
  focusReturn.remember(agent.agentId)
  void router.replace(agentManagementPath(spaceId.value, agent.agentId))
}

const dialogOpen = ref(false)
const editingAgent = ref<ProjectAgentRecord | null>(null)
const recruitDialogOpen = ref(false)
const dialogDefaultProjectId = computed(() => singleFilterProjectId.value
  || editingAgent.value?.assignments?.find(({ status }) => status === 'active')?.personalProjectId
  || editingAgent.value?.personalProjectId
  || projects.value[0]?.project_id
  || null)
function openCreate() { editingAgent.value = null; dialogOpen.value = true }
function openEdit(agent: ProjectAgentRecord) { editingAgent.value = agent; dialogOpen.value = true }
function closeDialog() { dialogOpen.value = false; editingAgent.value = null }
function recordSaved(record: ProjectAgentRecord) {
  const created = !editingAgent.value
  const saved = roster.put(record)
  store.notify(t('projectAgents.saved'))
  if (created) void router.push(agentManagementPath(spaceId.value, saved.agentId))
}
async function employeeRecruited(result: EmployeeRecruitmentResult) {
  recruitDialogOpen.value = false
  await router.push(agentManagementPath(spaceId.value, result.agent.agentId))
}
</script>

<template>
  <section ref="scroller" class="view project-agents-view" :aria-label="t('projectAgents.aria')">
    <GrowthLoading v-if="linkedAgent || resolvingTask" :label="linkedAgent ? t('projectAgents.opening') : t('projectAgents.openingTask')" />
    <div v-else class="@container mx-auto grid w-full max-w-(--canvas-max) gap-4">
      <!-- One toolbar: filters, then a row with the count and the actions. It stays
           in reach on tall screens and scrolls away on short ones. -->
      <div class="project-agents-toolbar">
        <div class="project-agents-filters">
          <ProjectScopePicker v-model="filterProjectIds" class="project-agents-project-filter" compact :projects="projectOptions" :label="t('employees.filterLabel')" :hint="t('employees.filterHint')" :empty-label="t('employees.filterEmpty')" />
          <label class="project-agents-search">
            <span class="ui-sr-only">{{ t('projectAgents.searchLabel') }}</span>
            <input v-model="search" type="search" maxlength="160" :placeholder="t('projectAgents.searchPlaceholder')" />
          </label>
          <UiSegmented v-model="statusFilter" class="project-agents-status-filter" :options="statusOptions" :label="t('projectAgents.fields.status')" />
        </div>
        <div class="project-agents-summary">
          <GrowthLoading v-if="roster.loading.value && agents.length" variant="inline" :label="t('projectAgents.loading')" />
          <p v-if="!pageLoading && !pageError" class="project-agents-header-meta" aria-live="polite">
            <strong>{{ t('projectAgents.stats.active', { count: activeCount }) }}</strong> · {{ t('projectAgents.stats.total', { count: agents.length }) }} · {{ t('projectAgents.stats.assignments', { count: assignmentCount }) }} · {{ t('projectAgents.stats.projects', { count: representedProjectCount }) }}<span class="project-agents-header-note">{{ t('projectAgents.stats.noOnlineClaim') }}</span>
          </p>
          <Button class="project-agents-actions-start" size="sm" variant="ghost" :disabled="!spaceId" @click="openCreate">{{ t('projectAgents.add') }}</Button>
          <Button size="sm" :disabled="!spaceId" @click="recruitDialogOpen = true">{{ t('employees.recruit') }}</Button>
        </div>
      </div>

      <p v-if="taskLinkUnavailable" class="ui-card project-agents-link-notice" role="status" data-task-link-unavailable>{{ t('projectAgents.taskLinkUnavailable') }}</p>

      <ProjectAgentFirstTask v-if="!pageLoading && !pageError && !projects.length" :personal-space-id="spaceId" />

      <ProjectAgentAutomationPolicyPanel
        v-if="singleFilterProjectId"
        :key="singleFilterProjectId"
        :personal-space-id="spaceId"
        :personal-project-id="singleFilterProjectId"
        :project-name="projectName(singleFilterProjectId)"
        :agents="agents"
        @select="openPeek"
      />

      <GrowthLoading v-if="pageLoading && !agents.length" :label="!store.state ? t('common.status.loadingConsole') : t('projectAgents.loading')" />
      <div v-else-if="pageError" class="ui-card project-agents-state is-error" role="alert">
        <p>{{ pageError }}</p>
        <Button size="sm" variant="outline" @click="retryPage">{{ t('projectAgents.retry') }}</Button>
      </div>
      <div v-else-if="!agents.length" class="ui-card project-agents-state">
        <strong>{{ t('projectAgents.emptyTitle') }}</strong>
        <p>{{ t('projectAgents.emptyCopy') }}</p>
        <Button size="sm" :disabled="!spaceId" @click="openCreate">{{ t('projectAgents.add') }}</Button>
      </div>
      <div v-else-if="!filteredAgents.length" class="ui-card project-agents-state">
        <strong>{{ t('projectAgents.noMatchTitle') }}</strong>
        <p>{{ t('projectAgents.noMatchCopy') }}</p>
      </div>
      <!-- 1/2/3/4 columns by the canvas width: a wide screen adds columns
           instead of stretching a card. -->
      <ul v-else class="project-agent-grid grid grid-cols-1 gap-3 @min-[620px]:grid-cols-2 @min-[960px]:grid-cols-3 @min-[1400px]:grid-cols-4" :aria-label="t('projectAgents.listLabel')">
        <li v-for="agent in filteredAgents" :key="agent.agentId" class="min-w-0">
          <ProjectAgentCard
            :agent="agent"
            :space-id="spaceId"
            :projects="responsibleProjectsFor(agent)"
            :selected="peekId === agent.agentId"
            @peek="openPeek(agent.agentId)"
          />
        </li>
      </ul>
    </div>

    <BackToTop :scroller="scroller" />

    <Dialog :open="Boolean(peek.item.value)" @update:open="peekOpenChange">
      <DialogContent class="agent-peek" data-agent-peek-dialog @open-auto-focus="focusPeekAction" @close-auto-focus="peekClosed">
        <AgentPeek
          :state="peekState"
          :error="pageError"
          :agent="peekAgent"
          :entry="peekAgent ? currentWorkEntry(peekAgent) : undefined"
          :project-names="{}"
          :project-labels="peekAgent ? responsibleProjectsFor(peekAgent).map((project) => project.name) : []"
          @open-full="openFullPage"
          @retry="retryPage"
        >
          <template #actions>
            <Button variant="outline" data-peek-edit @click="editFromPeek">{{ t('projectAgents.edit') }}</Button>
          </template>
        </AgentPeek>
      </DialogContent>
    </Dialog>

    <EmployeeRecruitDialog :open="recruitDialogOpen" :personal-space-id="spaceId" :projects="projects" template-id="" :default-project-ids="projectFilter ?? []" @close="recruitDialogOpen = false" @recruited="employeeRecruited" />
    <ProjectAgentDialog :open="dialogOpen" :agent="editingAgent" :projects="projects" :default-project-id="dialogDefaultProjectId" :personal-space-id="spaceId" @close="closeDialog" @saved="recordSaved" />
  </section>
</template>

<style src="@/features/agent-profile/agent-profile.css" />

<style scoped>
.project-agents-view { scrollbar-gutter: stable; }
.project-agents-toolbar {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px 16px;
  padding-block: 4px 0; background: var(--color-bg);
}
/* Tall screens keep the filters in reach while reading a long roster; short
   ones give that height back to the cards. */
@media (min-height: 820px) {
  .project-agents-toolbar { position: sticky; top: -12px; z-index: 2; padding-block: 16px 12px; margin-block: -12px -12px; }
}
.project-agents-filters { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; flex: 1 1 560px; }
.project-agents-project-filter { flex: 0 1 280px; min-width: 220px; }
/* One control height across the toolbar. */
.project-agents-project-filter :deep(.project-scope-trigger) { min-height: var(--control-height); padding-block: 0; }
.project-agents-search { flex: 1 1 200px; min-width: 180px; max-width: 360px; }
.project-agents-search input {
  width: 100%; min-height: var(--control-height); border: 1px solid var(--color-border-strong); border-radius: var(--radius-control);
  background: var(--color-surface); color: var(--color-ink); padding: 0 12px; font-size: 13px;
}
.project-agents-search input:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 1px; }
.project-agents-status-filter { flex: 0 0 auto; }
/* Its own row under the filters at every width: the count starts where the
   filters do, the actions end the row. */
.project-agents-summary { flex: 1 1 100%; display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; min-width: 0; }
.project-agents-actions-start { margin-inline-start: auto; }
.project-agents-header-meta { margin: 0; color: var(--color-muted); font-size: 12px; }
.project-agents-header-meta strong { color: var(--color-ink); font-weight: 700; }
.project-agents-header-note { margin-inline-start: 12px; }
.project-agents-state {
  min-height: 200px; display: grid; place-content: center; justify-items: center; gap: 8px;
  color: var(--color-muted); font-size: 14px; text-align: center;
}
.project-agents-state strong { color: var(--color-ink); font-size: 14px; }
.project-agents-state p { max-width: 52ch; margin: 0; line-height: 1.6; }
.project-agents-state.is-error { color: var(--color-danger); }
.project-agents-link-notice { margin: 0; padding: 12px 16px; color: var(--color-muted); font-size: 13px; }
.project-agent-grid { margin: 0; padding: 0; list-style: none; }
</style>
