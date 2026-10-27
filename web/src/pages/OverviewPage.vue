<script lang="ts">
// Navigation convenience only; no task, name, request or private text is retained.
const returnPosition = { spaceId: '', expanded: false, scrollTop: 0 }
</script>
<script setup lang="ts">
import { agentAvatarUrl } from '@/features/agent-profile/agent-avatar'
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import UiSelect from '@/ui/UiSelect.vue'
import { agentDisplayName } from '@/features/agent-profile/profile-model'
import { currentWork, overviewTaskTitle, overviewOwnerId, overviewOpenRequest, overviewAttentionTaskHref, overviewTaskHref, recentProjects } from '@/features/overview/overview-data'
import { useOverviewData } from '@/features/overview/useOverviewData'
import OverviewReadStatus from '@/features/overview/OverviewReadStatus.vue'
import OverviewExcerpt from '@/features/overview/OverviewExcerpt.vue'
import TaskBlockerNotice from '@/features/project-agents/TaskBlockerNotice.vue'
import { taskReason } from '@/features/project-agents/task-reason'
import { inboxLocation, useAgentAttention } from '@/features/project-agents/attention-store'
import { taskStatusLabel, taskStatusTone } from '@/features/project-agents/task-labels'
import { currentLocale, t } from '@/i18n'
import { formatDateTime } from '@/lib/date-time'
import { personalProjectsPath } from '@/router/paths'
import { projectDisplayName } from '@/features/projects/project-origin'
import { useConsoleStore } from '@/stores/console'
import { designLab } from '@/features/design-lab/design-lab'
import ConstellationBoard from '@/features/workbench/ConstellationBoard.vue'
import type { WorkbenchBoard } from '@/features/workbench/workbench-board'
import type { ProjectAgentTaskRecord } from '@/types'

const store = useConsoleStore()
const attentionCache = useAgentAttention()
const state = computed(() => store.state)
const activeSpaceId = computed(() => store.activePersonalSpace?.id ?? state.value?.activePersonalSpaceId ?? '')
const projects = computed(() => (state.value?.personalProjects ?? []).filter(project => project.personal_space_id === activeSpaceId.value))
const projectNames = computed(() => new Map(projects.value.map(project => [project.project_id, projectDisplayName(project)])))
const data = useOverviewData(activeSpaceId, projects)
const { tasks, requests, names } = data
watch(data.denied, denied => { if (denied) attentionCache.setSpace('') }, { flush: 'sync' })
const page = ref<HTMLElement | null>(null)
const restorePosition = returnPosition.spaceId === activeSpaceId.value
const expanded = ref(restorePosition && returnPosition.expanded)
let restoreScroll = restorePosition ? returnPosition.scrollTop : 0
const selected = ref('')
const selectedRequestId = ref('')
const selectedRequest = computed(() => data.requestItems.value.find(item => item.requestId === selectedRequestId.value))
const view = ref('list')
const sceneFailed = ref(false)
const narrow = ref(typeof window !== 'undefined' && window.innerWidth <= 720)
const supported = (value: string) => ['constellation', 'office'].includes(value) ? value : 'list'
view.value = narrow.value ? 'list' : supported(designLab.value.workbench)
const viewOptions = computed(() => ['list', 'constellation', 'office'].map(value => ({ value, label: t(`overview.views.${value}`) })))
function chooseView(value: string) {
  view.value = supported(value); selected.value = ''; selectedRequestId.value = ''; sceneFailed.value = false
  if (!narrow.value) designLab.value.workbench = view.value === 'list' ? 'current' : view.value
}
function resize() {
  const next = window.innerWidth <= 720
  if (next && !narrow.value) { view.value = 'list'; selected.value = '' }
  narrow.value = next
}
function sceneFallback() { view.value = 'list'; selected.value = ''; selectedRequestId.value = ''; sceneFailed.value = true }
const Workbench3D = defineAsyncComponent({ loader: () => import('@/features/workbench/Workbench3D.vue'), timeout: 30000,
  onError(_cause, _retry, fail) { sceneFallback(); fail() } })
const currentTasks = computed(() => currentWork(data.taskItems.value, expanded.value || view.value !== 'list' ? Infinity : 6))
const taskGroups = computed(() => {
  if (view.value === 'list') return [{ id: 'all', items: currentTasks.value, requests: [] }]
  const groups = new Map<string, ProjectAgentTaskRecord[]>()
  for (const task of currentTasks.value) {
    const id = task.personalProjectId || ''
    if (!groups.has(id)) groups.set(id, [])
    groups.get(id)!.push(task)
  }
  for (const request of data.requestItems.value) if (!groups.has(request.personalProjectId)) groups.set(request.personalProjectId, [])
  return [...groups].map(([id, items]) => ({ id, items, requests: data.requestItems.value.filter(item => item.personalProjectId === id) }))
})
const allTaskCount = computed(() => currentWork(data.taskItems.value, Infinity).length)
const attentionItem = computed(() => data.requestItems.value[0])
const recentProjectItems = computed(() => data.denied.value ? [] : recentProjects(data.taskItems.value, projects.value))
const selectedTask = computed(() => currentTasks.value.find(task => `${task.personalProjectId}:${task.taskId}` === selected.value))
const board = computed<WorkbenchBoard>(() => ({
  personalSpaceId: activeSpaceId.value, tasks: currentWork(data.taskItems.value, Infinity).map(task => ({ ...task, title: taskTitle(task) })), attention: data.requestItems.value,
  projectName, agentFace: id => ({ name: agentName(id), image: id ? agentAvatarUrl(id) : null, color: null, softColor: null }),
  taskHref: overviewTaskHref, questionHref: item => inboxLocation(item.agentId, item.requestId), statusLabel, since: formatDate,
}))
function pick(href: unknown) {
  const task = currentTasks.value.find(task => overviewTaskHref(task) === href)
  const request = data.requestItems.value.find(item => JSON.stringify(inboxLocation(item.agentId, item.requestId)) === JSON.stringify(href))
  const match = task || (request && currentTasks.value.find(task => task.taskId === request.taskId && task.personalProjectId === request.personalProjectId))
  selectedRequestId.value = match ? '' : request?.requestId ?? ''
  selected.value = match ? `${match.personalProjectId}:${match.taskId}` : ''
}
watch(activeSpaceId, () => { returnPosition.spaceId = ''; restoreScroll = 0; expanded.value = false; selected.value = ''; selectedRequestId.value = ''; view.value = narrow.value ? 'list' : supported(designLab.value.workbench); sceneFailed.value = false })
watch(() => [data.denied.value, projects.value.map(item => item.project_id).join('\0')], () => { returnPosition.spaceId = ''; restoreScroll = 0; selected.value = ''; selectedRequestId.value = ''; expanded.value = false })
watch(() => tasks.updatedAt, () => { if (restoreScroll) void nextTick(() => { if (page.value) page.value.scrollTop = restoreScroll; restoreScroll = 0 }) })

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
onMounted(() => { window.addEventListener('resize', resize); if (store.runtimeStatus === 'idle') void store.refresh() })
onBeforeUnmount(() => { if (!data.denied.value && !scopeTimedOut.value) Object.assign(returnPosition, { spaceId: activeSpaceId.value, expanded: expanded.value, scrollTop: page.value?.scrollTop ?? 0 }); clearScopeTimers(); window.removeEventListener('resize', resize) })

function projectName(id?: string | null) { return (id && projectNames.value.get(id)) || t('overview.missing.project') }
function agentName(id?: string | null) {
  const record = id ? names.data?.records[id] : undefined
  if (record) { const name = agentDisplayName(record).trim(); if (name && name !== id && !record.legacyAgentIds?.includes(name)) return name }
  return names.loading ? t('overview.missing.nameLoading') : names.error || names.data?.partial ? t('overview.missing.nameUnavailable') : t('overview.missing.name')
}
function owner(task: ProjectAgentTaskRecord) { const id = overviewOwnerId(task); return id ? agentName(id) : t('overview.missing.owner') }
function taskTitle(task: ProjectAgentTaskRecord) { return overviewTaskTitle(task) || t('overview.missing.taskTitle') }
function statusLabel(status: string) { return taskStatusLabel(status, { unrecognized: t('overview.missing.status') }) }
function formatDate(value?: string | null) { return formatDateTime(value, currentLocale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }, { missing: t('overview.missing.time'), invalid: t('overview.missing.time') }) }
function requestFor(task: ProjectAgentTaskRecord) { return overviewOpenRequest(task, data.requestItems.value, activeSpaceId.value) }
function nextHref(task: ProjectAgentTaskRecord) { const request = requestFor(task); return request ? inboxLocation(request.agentId, request.requestId) : overviewTaskHref(task) }
function nextLabel(task: ProjectAgentTaskRecord) { if (requestFor(task)) return t('overview.actions.request'); return t(`overview.actions.${['blocked', 'failed', 'awaiting_review'].includes(task.status) ? task.status : 'task'}`) }
const localServiceStatus = computed(() => store.runtimeStatus === 'error' || state.value?.providers?.personal?.status === 'error' ? 'error' : store.runtimeStatus === 'ready' && state.value?.providers?.personal?.status !== 'loading' ? 'ready' : 'loading')
const publicServiceStatus = computed(() => store.publicRuntimeStatus)
</script>

<template>
  <section ref="page" class="view overview-view">
    <div class="@container mx-auto w-full max-w-(--layout-max)">
      <template v-if="bootstrapLoading">
        <GrowthLoading :label="t('overview.read.scope')" />
        <p v-if="scopeSlow" role="status">{{ t('overview.read.slow') }}</p>
      </template>
      <Card v-else-if="scopeTimedOut || !state || data.denied.value" class="overview-scope-error flex-row flex-wrap items-center gap-3 px-5" role="alert">
        <p class="m-0 min-w-0 flex-1">{{ t(data.denied.value ? 'overview.read.denied' : scopeTimedOut || store.refreshError === 'timeout' ? 'overview.read.timeout' : 'overview.read.scopeFailed') }}</p>
        <GrowthLoading v-if="scopeRetrying" variant="inline" :label="t('overview.read.scope')" />
        <Button variant="outline" :disabled="scopeRetrying" @click="retryScope">{{ t('overview.read.reload') }}</Button>
      </Card>
      <div v-else class="overview-content-grid grid items-start gap-6">
        <Card as="section" class="overview-attention-section col-span-full gap-3" aria-labelledby="overview-attention-heading">
          <header class="flex flex-wrap items-center justify-between gap-2 px-5">
            <h2 id="overview-attention-heading" class="text-lg font-semibold">{{ t('overview.sections.attention') }}</h2>
            <div class="flex flex-wrap items-center gap-1">
              <Button variant="ghost" size="sm" :disabled="requests.loading" data-testid="overview-attention-retry" @click="data.loadRequests">{{ t('overview.attention.refresh') }}</Button>
              <Button as-child variant="ghost" size="sm"><RouterLink data-testid="overview-attention-all" :to="inboxLocation()">{{ requests.data && !requests.data.partial ? t('overview.attention.all', { count: requests.data.total }) : t('overview.attention.open') }}</RouterLink></Button>
            </div>
          </header>
          <OverviewReadStatus class="px-5" :state="requests" :label="t('overview.attention.loading')" :failed="t('overview.attention.loadFailed')" @retry="data.loadRequests" />
          <div v-if="attentionItem" :key="`${activeSpaceId}:${attentionItem.requestId}`" class="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 px-5" data-testid="overview-attention-item">
            <div class="min-w-0 flex-[1_1_420px]">
              <h3 class="text-base font-semibold">{{ attentionItem.title?.trim() || t('overview.missing.requestTitle') }}</h3>
              <p class="overview-meta">{{ t('overview.attention.agent', { id: agentName(attentionItem.agentId) }) }} · {{ projectName(attentionItem.personalProjectId) }}</p>
              <OverviewExcerpt :text="attentionItem.requestedAction?.trim() || t('overview.attention.viewContent')" />
              <details v-if="attentionItem.detail" class="overview-request-detail"><summary>{{ t('overview.attention.detail') }}</summary><p>{{ attentionItem.detail }}</p></details>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <Button as-child><RouterLink data-testid="overview-attention-open" :to="inboxLocation(attentionItem.agentId, attentionItem.requestId)">{{ t(requests.error ? 'overview.attention.recheck' : 'overview.attention.respond') }}</RouterLink></Button>
              <Button v-if="attentionItem.taskId" as-child variant="outline"><RouterLink data-testid="overview-attention-task" :to="overviewAttentionTaskHref({ ...attentionItem, taskId: attentionItem.taskId })">{{ t('overview.attention.openTask') }}</RouterLink></Button>
            </div>
          </div>
          <p v-else-if="requests.data && !requests.error && !requests.loading" class="overview-empty px-5">{{ t(requests.data.partial ? 'overview.read.partial' : 'overview.attention.empty') }}</p>
        </Card>

        <section class="overview-work-section @container min-w-0" aria-labelledby="overview-work-heading">
          <header class="mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <div class="flex flex-wrap items-center gap-2">
              <h2 id="overview-work-heading" class="text-lg font-semibold">{{ t('overview.sections.currentWork') }}</h2>
              <Badge v-if="tasks.data?.partial" variant="secondary">{{ t('overview.read.partial') }}</Badge>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <UiSelect class="overview-view-select" :model-value="view" :options="viewOptions" :label="t('overview.views.label')" @update:model-value="chooseView" />
              <Button v-if="!tasks.error" :disabled="tasks.loading" variant="ghost" size="sm" data-testid="overview-work-retry" @click="data.loadTasks">{{ t('overview.work.refresh') }}</Button>
            </div>
          </header>
          <OverviewReadStatus :state="tasks" :label="t('overview.work.loading')" :failed="t('overview.work.loadFailed')" test-id="overview-work-retry" @retry="data.loadTasks" />
          <OverviewReadStatus :state="names" :label="t('overview.missing.nameLoading')" :failed="t('overview.missing.nameUnavailable')" @retry="data.loadNames" />
          <p v-if="names.data?.partial" class="overview-notice">{{ t('overview.missing.nameUnavailable') }} <Button variant="ghost" size="sm" :disabled="names.loading" @click="data.loadNames">{{ t('overview.read.reload') }}</Button></p>
          <p v-if="sceneFailed" class="overview-notice" role="status">{{ t('overview.views.fallback') }}</p>
          <ConstellationBoard v-if="view === 'constellation' && (currentTasks.length || data.requestItems.value.length)" :board="board" />
          <Workbench3D v-if="view === 'office' && (currentTasks.length || data.requestItems.value.length)" :key="activeSpaceId" :board="board" scene="office" @fallback="sceneFallback" @pick="pick" />
          <Card v-if="selectedTask && view !== 'list'" class="overview-selected my-3 gap-1 px-4 py-3 shadow-md" role="status">
            <strong>{{ owner(selectedTask) }}</strong><p>{{ taskTitle(selectedTask) }} · {{ statusLabel(selectedTask.status) }}</p>
            <Button as-child variant="ghost" size="sm" class="self-start"><RouterLink :to="nextHref(selectedTask)">{{ nextLabel(selectedTask) }}</RouterLink></Button>
          </Card>
          <Card v-else-if="selectedRequest && view !== 'list'" class="overview-selected my-3 gap-1 px-4 py-3 shadow-md" role="status">
            <strong>{{ agentName(selectedRequest.agentId) }}</strong><p>{{ selectedRequest.title?.trim() || t('overview.missing.requestTitle') }} · {{ t('workbench.projection.waiting') }}</p>
            <Button as-child variant="ghost" size="sm" class="self-start"><RouterLink :to="inboxLocation(selectedRequest.agentId, selectedRequest.requestId)">{{ t('overview.actions.request') }}</RouterLink></Button>
          </Card>
          <p v-if="view !== 'list' && currentTasks.length" class="overview-meta">{{ t('overview.views.equivalent') }}</p>
          <div v-if="currentTasks.length || (view !== 'list' && data.requestItems.value.length)" class="grid gap-4">
            <component :is="view === 'list' ? 'div' : 'details'" v-for="group in taskGroups" :key="group.id" :open="view === 'list' ? undefined : true" class="overview-task-group">
              <summary v-if="view !== 'list'">{{ projectName(group.id) }}</summary>
              <ul v-if="view !== 'list' && group.requests.length" class="overview-request-members">
                <li v-for="request in group.requests" :key="request.requestId">
                  <p><strong>{{ agentName(request.agentId) }}</strong> · {{ request.title?.trim() || t('overview.missing.requestTitle') }} · {{ t('workbench.projection.waiting') }}</p>
                  <Button as-child variant="ghost" size="sm"><RouterLink :to="inboxLocation(request.agentId, request.requestId)">{{ t('overview.actions.request') }}</RouterLink></Button>
                </li>
              </ul>
              <!-- Wider canvases add columns instead of stretching a card. -->
              <ul class="overview-work-list grid grid-cols-1 gap-3 @min-[640px]:grid-cols-2 @min-[1080px]:grid-cols-3 @min-[1440px]:grid-cols-4">
                <li v-for="task in group.items" :key="`${activeSpaceId}:${task.personalProjectId}:${task.taskId}`"
                  class="overview-current-work-item flex min-w-0 flex-col gap-1.5 rounded-lg border bg-card px-4 pt-3.5 pb-2.5 transition-[border-color,box-shadow]"
                  :class="{ 'is-selected border-border-strong shadow-md': selected === `${task.personalProjectId}:${task.taskId}` }" data-testid="overview-current-work-item">
                  <div class="flex items-start justify-between gap-3">
                    <h3 class="overview-task-title min-w-0 flex-1 text-base font-semibold" :title="taskTitle(task)">{{ taskTitle(task) }}</h3>
                    <Badge :variant="taskStatusTone(task.status)" :title="statusLabel(task.status)">{{ statusLabel(task.status) }}</Badge>
                  </div>
                  <p class="overview-meta">{{ t('overview.work.owner', { name: owner(task) }) }} · {{ projectName(task.personalProjectId) }}</p>
                  <TaskBlockerNotice v-if="task.status === 'blocked' && task.blocker" compact :blocker="task.blocker" :updated-at="task.updatedAt" />
                  <OverviewExcerpt v-else-if="task.status === 'blocked' || task.status === 'failed'" class="overview-reason" :text="taskReason(task.failureReason)?.text || t('overview.missing.reason')" />
                  <div class="mt-auto flex flex-wrap items-center justify-between gap-x-3 gap-y-1 pt-1">
                    <time class="overview-meta" :datetime="task.updatedAt || task.createdAt || undefined">{{ formatDate(task.updatedAt || task.createdAt) }}</time>
                    <div class="ml-auto flex min-w-0 max-w-full flex-wrap gap-1">
                      <Button v-if="view !== 'list'" variant="ghost" size="sm" :aria-label="t('overview.views.select', { name: owner(task) })" :aria-expanded="selected === `${task.personalProjectId}:${task.taskId}`" @click="selected = selected === `${task.personalProjectId}:${task.taskId}` ? '' : `${task.personalProjectId}:${task.taskId}`">{{ t('overview.views.inspect') }}</Button>
                      <Button as-child variant="ghost" size="sm"><RouterLink :to="nextHref(task)">{{ nextLabel(task) }}</RouterLink></Button>
                    </div>
                  </div>
                </li>
              </ul>
            </component>
          </div>
          <p v-else-if="tasks.data && !tasks.error && !tasks.loading" class="overview-empty">{{ t(tasks.data.partial ? 'overview.read.partial' : 'overview.work.empty') }}</p>
          <Button v-if="allTaskCount > 6 && view === 'list'" variant="ghost" class="mt-2" :aria-expanded="expanded" @click="expanded = !expanded">{{ t(expanded ? 'overview.work.collapse' : 'overview.work.expand', { count: allTaskCount }) }}</Button>
          <p v-if="tasks.data?.partial" class="overview-meta">{{ t('overview.work.loaded', { count: data.taskItems.value.length }) }}</p>
        </section>

        <aside class="overview-column grid min-w-0 gap-6">
          <Card as="section" class="gap-1 pb-2" aria-labelledby="overview-projects-heading">
            <h2 id="overview-projects-heading" class="px-5 text-lg font-semibold">{{ t('overview.sections.recentProjects') }}</h2>
            <ul class="overview-project-list">
              <li v-for="project in recentProjectItems" :key="project.id" data-testid="overview-recent-project">
                <RouterLink :to="personalProjectsPath(activeSpaceId, 'overview', project.id)"><strong>{{ project.name }}</strong><span>{{ project.updatedAt ? formatDate(project.updatedAt) : t('overview.projects.noActivity') }}</span></RouterLink>
              </li>
            </ul>
            <p v-if="!recentProjectItems.length" class="overview-empty px-5">{{ t('overview.projects.empty') }}</p>
          </Card>
          <Card as="section" class="gap-1 pb-2" aria-labelledby="overview-services-heading">
            <h2 id="overview-services-heading" class="px-5 text-lg font-semibold">{{ t('overview.sections.services') }}</h2>
            <ul class="overview-service-list">
              <li><strong>{{ t('overview.services.local') }}</strong><Badge :variant="localServiceStatus === 'ready' ? 'success' : localServiceStatus === 'error' ? 'destructive' : 'secondary'">{{ t(`overview.services.${localServiceStatus}`) }}</Badge></li>
              <li><strong>{{ t('overview.services.public') }}</strong><Badge :variant="publicServiceStatus === 'ready' ? 'success' : publicServiceStatus === 'error' ? 'destructive' : 'secondary'">{{ t(`overview.services.${publicServiceStatus}`) }}</Badge></li>
            </ul>
          </Card>
        </aside>
      </div>
    </div>
  </section>
</template>

<style scoped>
.overview-view { overflow-wrap: anywhere; scrollbar-gutter: stable; }
/* Work canvas: one column of sections, never a side column beside the work
   (rec#38); only the homogeneous task cards add columns on wider canvases. */
.overview-content-grid { grid-template-columns: minmax(0, 1fr); }
.overview-meta { margin: 0; color: var(--color-muted); font-size: 12px; line-height: 1.6; }
.overview-empty, .overview-notice { margin: 12px 0; font-size: 14px; color: var(--color-ink-soft); }
.overview-view ul { list-style: none; margin: 0; padding: 0; }
.overview-task-title { display: -webkit-box; overflow: hidden; line-height: 1.45; -webkit-box-orient: vertical; -webkit-line-clamp: 3; }
.overview-current-work-item:hover { border-color: var(--color-border-strong); }
.overview-reason { color: var(--color-ink-soft); font-size: 13px; }
.overview-request-detail { margin-top: 4px; font-size: 14px; }
.overview-request-detail summary { display: flex; align-items: center; min-height: 32px; width: fit-content; color: var(--color-accent); cursor: pointer; }
.overview-request-detail p { white-space: pre-wrap; line-height: 1.6; margin: 0; }
.overview-request-members li { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; padding: 8px 0; }
.overview-request-members p { flex: 1 1 180px; margin: 0; font-size: 14px; }
.overview-task-group > summary { min-height: 40px; padding-block: 8px; font-weight: 600; cursor: pointer; color: var(--color-ink); }
.overview-view :deep(.overview-view-select) { min-width: 132px; max-width: 100%; }
.overview-project-list li, .overview-service-list li { border-top: 1px solid var(--color-border); }
.overview-project-list li:first-child, .overview-service-list li:first-child { border-top: 0; }
.overview-project-list a { display: grid; gap: 2px; padding: 12px 20px; color: inherit; text-decoration: none; }
.overview-project-list a:hover strong { color: var(--color-accent); }
.overview-project-list strong, .overview-service-list strong { min-width: 0; font-size: 14px; font-weight: 550; }
.overview-project-list span { color: var(--color-muted); font-size: 12px; }
.overview-service-list li { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 12px 20px; }
.overview-view a:focus-visible, .overview-view summary:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; border-radius: 4px; }
/* Touch screens keep 44px targets; a mouse gets the compact controls. */
@media (pointer: coarse) {
  .overview-view :deep([data-slot="button"]), .overview-view :deep(.ui-select__trigger) { min-height: 44px; }
}
@media (max-width: 720px) { .overview-view { padding-bottom: calc(16px + env(safe-area-inset-bottom)); } }
</style>
