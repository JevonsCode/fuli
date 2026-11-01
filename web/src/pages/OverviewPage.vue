<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { agentDisplayName } from '@/features/agent-profile/profile-model'
import { currentWork, overviewOpenRequest, overviewOwnerId, overviewTaskHref, overviewTaskTitle } from '@/features/overview/overview-data'
import { useOverviewData } from '@/features/overview/useOverviewData'
import ProblemState from '@/features/problem/ProblemState.vue'
import { recentlyDone, taskKey } from '@/features/overview/workbench-model'
import WorkbenchFeed from '@/features/overview/WorkbenchFeed.vue'
import WorkbenchStage from '@/features/overview/WorkbenchStage.vue'
import { inboxLocation, useAgentAttention } from '@/features/project-agents/attention-store'
import { taskStatusLabel } from '@/features/project-agents/task-labels'
import { projectDisplayName } from '@/features/projects/project-origin'
import { currentLocale, t } from '@/i18n'
import { formatDateTime } from '@/lib/date-time'
import { useConsoleStore } from '@/stores/console'
import type { ProjectAgentTaskRecord } from '@/types'

// 工作台 (client redesign, 2026-11-01): a fixed left stage with the one piece
// of work you are looking at, and one scrolling right column with what waits
// for you, the other work in progress and what was just finished. Reads stay
// page-local and are dropped on a space or permission change (useOverviewData).
const store = useConsoleStore()
const attentionCache = useAgentAttention()
const state = computed(() => store.state)
const activeSpaceId = computed(() => store.activePersonalSpace?.id ?? state.value?.activePersonalSpaceId ?? '')
const projects = computed(() => (state.value?.personalProjects ?? []).filter(project => project.personal_space_id === activeSpaceId.value))
const projectNames = computed(() => new Map(projects.value.map(project => [project.project_id, projectDisplayName(project)])))
const data = useOverviewData(activeSpaceId, projects)
const { tasks, requests, names } = data
watch(data.denied, denied => { if (denied) attentionCache.setSpace('') }, { flush: 'sync' })

const current = computed(() => currentWork(data.taskItems.value, Infinity))
// The stage shows the work you picked, else the first that needs you most.
const selectedKey = ref('')
// The picked title flies from the column to the stage; only that one title
// shares a layout, so reads that reflow the page never animate it.
const flying = ref('')
let flyingTimer: ReturnType<typeof setTimeout> | undefined
const staged = computed(() => current.value.find(task => taskKey(task) === selectedKey.value) ?? current.value[0] ?? null)
const others = computed(() => current.value.filter(task => task !== staged.value))
const done = computed(() => recentlyDone(data.taskItems.value))
function select(task: ProjectAgentTaskRecord) {
  flying.value = taskKey(task)
  void nextTick(() => { selectedKey.value = taskKey(task) })
  clearTimeout(flyingTimer)
  flyingTimer = setTimeout(() => { flying.value = '' }, 900)
}
watch(() => [activeSpaceId.value, data.denied.value, projects.value.map(item => item.project_id).join('\0')], () => { selectedKey.value = '' })

// Bootstrap is owned by the shared console store. Bound the visible wait and
// do not accept a late initial result after this page's 30-second budget.
const scopeTimedOut = ref(false), scopeSlow = ref(false)
let scopeSlowTimer: ReturnType<typeof setTimeout> | undefined, scopeEndTimer: ReturnType<typeof setTimeout> | undefined
const bootstrapLoading = computed(() => !scopeTimedOut.value && !state.value && ['idle', 'loading'].includes(store.runtimeStatus))
function clearScopeTimers() { clearTimeout(scopeSlowTimer); clearTimeout(scopeEndTimer) }
watch(bootstrapLoading, loading => {
  clearScopeTimers(); scopeSlow.value = false
  if (loading) { scopeSlowTimer = setTimeout(() => { scopeSlow.value = true }, 8000); scopeEndTimer = setTimeout(() => { scopeTimedOut.value = true; scopeSlow.value = false }, 30000) }
}, { immediate: true })
const scopeRetrying = ref(false)
async function retryScope() { if (scopeRetrying.value) return; scopeTimedOut.value = false; scopeRetrying.value = true; try { await store.refresh(); if (store.runtimeStatus === 'ready') { attentionCache.setSpace(activeSpaceId.value); data.retryScope() } else if (store.refreshError === 'timeout') scopeTimedOut.value = true } finally { scopeRetrying.value = false } }
onMounted(() => { if (store.runtimeStatus === 'idle') void store.refresh() })
onBeforeUnmount(() => { clearScopeTimers(); clearTimeout(flyingTimer) })

// The scope could not be read: say why in words, the way the person can act on it.
const scopeProblem = computed(() => {
  if (data.denied.value) return { title: t('overview.read.denied'), detail: '' }
  if (scopeTimedOut.value || store.refreshError === 'timeout') return { title: t('problem.timeout.title'), detail: t('problem.timeout.detail') }
  if (store.runtimeStatus !== 'ready') return { title: t('problem.serviceDown.title'), detail: t('problem.serviceDown.detail') }
  return { title: t('problem.failed.title'), detail: t('problem.failed.detail') }
})
function projectName(id?: string | null) { return (id && projectNames.value.get(id)) || t('overview.missing.project') }
function agentName(id?: string | null) {
  const record = id ? names.data?.records[id] : undefined
  if (record) { const name = agentDisplayName(record).trim(); if (name && name !== id && !record.legacyAgentIds?.includes(name)) return name }
  return names.loading ? t('overview.missing.nameLoading') : names.error || names.data?.partial ? t('overview.missing.nameUnavailable') : t('overview.missing.name')
}
function owner(task: ProjectAgentTaskRecord) { const id = overviewOwnerId(task); return id ? agentName(id) : t('overview.missing.owner') }
function taskTitle(task: ProjectAgentTaskRecord) { return overviewTaskTitle(task) || t('overview.missing.taskTitle') }
function statusLabel(status: string) { return taskStatusLabel(status, { unrecognized: t('overview.missing.status') }) }
function formatTime(value?: string | null) { return formatDateTime(value, currentLocale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }, { missing: t('overview.missing.time'), invalid: t('overview.missing.time') }) }
// A block the person marked cleared also closes its open decision requests.
function blockerCleared() { void data.loadTasks(); void data.loadRequests() }
// The stage's one action: answer the FLA waiting on this work, else open the task.
const next = computed(() => {
  const task = staged.value
  if (!task) return null
  const request = overviewOpenRequest(task, data.requestItems.value, activeSpaceId.value)
  if (request) return { to: inboxLocation(request.agentId, request.requestId), label: t('overview.actions.request') }
  return { to: overviewTaskHref(task), label: t(`overview.actions.${['blocked', 'failed', 'awaiting_review'].includes(task.status) ? task.status : 'task'}`) }
})
</script>

<template>
  <section class="view overview-view">
    <template v-if="bootstrapLoading">
      <GrowthLoading :label="t('overview.read.scope')" />
      <p v-if="scopeSlow" role="status">{{ t('overview.read.slow') }}</p>
    </template>
    <ProblemState v-else-if="scopeTimedOut || !state || data.denied.value" class="overview-scope-error" :title="scopeProblem.title" :detail="scopeProblem.detail"
      :error="store.refreshError === 'failed' ? store.refreshMessage || null : null" :retrying="scopeRetrying" :retrying-label="t('overview.read.scope')" @retry="retryScope" />
    <div v-else class="workbench">
      <GrowthLoading v-if="!tasks.data && tasks.loading" class="workbench-loading" variant="compact" :label="t('overview.work.loading')" />
      <WorkbenchStage v-else :task="staged" :space-id="activeSpaceId" :title="taskTitle" :project-name="projectName" :agent-name="agentName"
        :status-label="statusLabel" :next="next" :flying="flying" :partial="tasks.data?.partial === true" @cleared="blockerCleared" />
      <WorkbenchFeed :requests="data.requestItems.value" :requests-state="requests" :request-total="requests.data?.total ?? 0"
        :running="others" :tasks-state="tasks" :done="done" :title="taskTitle" :agent-name="agentName" :owner="owner"
        :status-label="statusLabel" :format-time="formatTime" :flying="flying" @select="select" @retry-requests="data.loadRequests" @retry-tasks="data.loadTasks" />
    </div>
  </section>
</template>

<style scoped>
/* The workbench fills the window: the page itself never scrolls; the right
   column does. Halves on the client's default 1280px window and up; the
   largest screens keep a centred canvas instead of stretching the halves. */
.overview-view { display: flex; overflow: hidden; padding-bottom: 20px !important; overflow-wrap: anywhere; }
.workbench {
  display: grid; flex: 1; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 18px;
  width: 100%; max-width: var(--canvas-max); min-height: 0; margin-inline: auto;
}
.workbench > :first-child { margin-bottom: 76px; }
.workbench-loading { margin: auto; }
/* Small windows and phones: one column, the stage first, the page scrolls. */
@media (max-width: 860px) {
  .overview-view { display: block; overflow: auto; padding-bottom: calc(112px + env(safe-area-inset-bottom)) !important; }
  .workbench { display: flex; flex-direction: column; }
  .workbench > :first-child { margin-bottom: 0; }
}
</style>
