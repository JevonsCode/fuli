<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { currentWork, overviewOpenRequest, overviewOwnerId, overviewTaskHref, overviewTaskTitle, overviewTime } from '@/features/overview/overview-data'
import { useOverviewData } from '@/features/overview/useOverviewData'
import { useScopeBootstrap } from '@/features/overview/useScopeBootstrap'
import ProblemState from '@/features/problem/ProblemState.vue'
import { recentlyDone, taskKey } from '@/features/overview/workbench-model'
import WorkbenchFeed from '@/features/overview/WorkbenchFeed.vue'
import WorkbenchStage from '@/features/overview/WorkbenchStage.vue'
import { inboxLocation, useAgentAttention } from '@/features/project-agents/attention-store'
import { taskStatusLabel } from '@/features/project-agents/task-labels'
import { projectDisplayName } from '@/features/projects/project-origin'
import { t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import type { ProjectAgentTaskRecord } from '@/types'
import { usePageRefresh } from '@/layouts/page-refresh'

// 工作台 (client redesign, 2026-11-01; at /workbench since 今天 took the home
// route): a fixed left stage with the one piece of work you are looking at,
// and one scrolling right column with what waits for you, the other work in
// progress and what was just finished. Reads stay page-local and are dropped
// on a space or permission change (useOverviewData).
const store = useConsoleStore()
const attentionCache = useAgentAttention()
const state = computed(() => store.state)
const activeSpaceId = computed(() => store.activePersonalSpace?.id ?? state.value?.activePersonalSpaceId ?? '')
const projects = computed(() => (state.value?.personalProjects ?? []).filter(project => project.personal_space_id === activeSpaceId.value))
const projectNames = computed(() => new Map(projects.value.map(project => [project.project_id, projectDisplayName(project)])))
const data = useOverviewData(activeSpaceId, projects)
const { tasks, requests, agentName } = data
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
// The feed shows seven and opens the rest itself.
const done = computed(() => recentlyDone(data.taskItems.value, Infinity))
function select(task: ProjectAgentTaskRecord) {
  flying.value = taskKey(task)
  void nextTick(() => { selectedKey.value = taskKey(task) })
  clearTimeout(flyingTimer)
  flyingTimer = setTimeout(() => { flying.value = '' }, 900)
}
watch(() => [activeSpaceId.value, data.denied.value, projects.value.map(item => item.project_id).join('\0')], () => { selectedKey.value = '' })

const scope = useScopeBootstrap(data.denied, () => { attentionCache.setSpace(activeSpaceId.value); data.retryScope() })
onBeforeUnmount(() => { clearTimeout(flyingTimer) })

function projectName(id?: string | null) { return (id && projectNames.value.get(id)) || t('overview.missing.project') }
function owner(task: ProjectAgentTaskRecord) { const id = overviewOwnerId(task); return id ? agentName(id) : t('overview.missing.owner') }
function taskTitle(task: ProjectAgentTaskRecord) { return overviewTaskTitle(task) || t('overview.missing.taskTitle') }
function statusLabel(status: string) { return taskStatusLabel(status, { unrecognized: t('overview.missing.status') }) }
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
// The top bar's 刷新 reads the work, the requests and the names again in place.
usePageRefresh(() => Promise.all([data.loadTasks(), data.loadRequests(), data.loadNames()]))
</script>

<template>
  <section class="view overview-view">
    <template v-if="scope.loading.value">
      <GrowthLoading :label="t('overview.read.scope')" />
      <p v-if="scope.slow.value" role="status">{{ t('overview.read.slow') }}</p>
    </template>
    <ProblemState v-else-if="scope.failed.value" class="overview-scope-error" :title="scope.problem.value.title" :detail="scope.problem.value.detail"
      :error="scope.error.value" :retrying="scope.retrying.value" :retrying-label="t('overview.read.scope')" @retry="scope.retry" />
    <div v-else class="workbench">
      <GrowthLoading v-if="!tasks.data && tasks.loading" class="workbench-loading" variant="compact" :label="t('overview.work.loading')" />
      <WorkbenchStage v-else :task="staged" :space-id="activeSpaceId" :title="taskTitle" :project-name="projectName" :agent-name="agentName"
        :status-label="statusLabel" :next="next" :flying="flying" :partial="tasks.data?.partial === true" @cleared="blockerCleared" />
      <WorkbenchFeed :requests="data.requestItems.value" :requests-state="requests" :request-total="requests.data?.total ?? 0"
        :running="others" :tasks-state="tasks" :done="done" :title="taskTitle" :agent-name="agentName" :owner="owner"
        :status-label="statusLabel" :format-time="overviewTime" @select="select" @retry-requests="data.loadRequests" @retry-tasks="data.loadTasks" />
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
  width: 100%; min-height: 0;
}
.workbench > :first-child { margin-bottom: 76px; }
/* Centred in the stage column: `.workbench > :first-child` would otherwise keep its 76px bottom
   margin and push the indicator down beside the dock. */
.workbench > .workbench-loading { margin: auto; }
/* Small windows and phones: one column, the stage first, the page scrolls. */
@media (max-width: 860px) {
  .overview-view { display: block; overflow: auto; padding-bottom: calc(112px + env(safe-area-inset-bottom)) !important; }
  .workbench { display: flex; flex-direction: column; }
  .workbench > :first-child { margin-bottom: 0; }
}
</style>
