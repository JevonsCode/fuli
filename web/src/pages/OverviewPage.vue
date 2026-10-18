<script lang="ts">
// Navigation convenience only; no task, name, request or private text is retained.
const returnPosition = { spaceId: '', expanded: false, scrollTop: 0 }
</script>
<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import GrowthLoading from '@/components/GrowthLoading.vue'
import UiButton from '@/ui/UiButton.vue'
import UiSelect from '@/ui/UiSelect.vue'
import { agentDisplayName } from '@/features/agent-profile/profile-model'
import { currentWork, overviewTaskTitle, overviewOwnerId, overviewOpenRequest, overviewAttentionTaskHref, overviewTaskHref, recentProjects } from '@/features/overview/overview-data'
import { useOverviewData } from '@/features/overview/useOverviewData'
import OverviewReadStatus from '@/features/overview/OverviewReadStatus.vue'
import OverviewExcerpt from '@/features/overview/OverviewExcerpt.vue'
import { inboxLocation, useAgentAttention } from '@/features/project-agents/attention-store'
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
  projectName, agentFace: id => ({ name: agentName(id), image: null, color: null, softColor: null }),
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
function statusLabel(status: string) { const key = `overview.taskStatus.${status}`, label = t(key); return label === key ? t('overview.missing.status') : label }
function formatDate(value?: string | null) { return formatDateTime(value, currentLocale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }, { missing: t('overview.missing.time'), invalid: t('overview.missing.time') }) }
function requestFor(task: ProjectAgentTaskRecord) { return overviewOpenRequest(task, data.requestItems.value, activeSpaceId.value) }
function nextHref(task: ProjectAgentTaskRecord) { const request = requestFor(task); return request ? inboxLocation(request.agentId, request.requestId) : overviewTaskHref(task) }
function nextLabel(task: ProjectAgentTaskRecord) { if (requestFor(task)) return t('overview.actions.request'); return t(`overview.actions.${['blocked', 'failed', 'awaiting_review'].includes(task.status) ? task.status : 'task'}`) }
const localServiceStatus = computed(() => store.runtimeStatus === 'error' || state.value?.providers?.personal?.status === 'error' ? 'error' : store.runtimeStatus === 'ready' && state.value?.providers?.personal?.status !== 'loading' ? 'ready' : 'loading')
const publicServiceStatus = computed(() => store.publicRuntimeStatus)
</script>

<template>
  <section ref="page" class="view overview-view">
    <template v-if="bootstrapLoading">
      <GrowthLoading :label="t('overview.read.scope')" />
      <p v-if="scopeSlow" role="status">{{ t('overview.read.slow') }}</p>
    </template>
    <div v-else-if="scopeTimedOut || !state || data.denied.value" class="overview-scope-error" role="alert">
      <p>{{ t(data.denied.value ? 'overview.read.denied' : scopeTimedOut || store.refreshError === 'timeout' ? 'overview.read.timeout' : 'overview.read.scopeFailed') }}</p>
      <GrowthLoading v-if="scopeRetrying" variant="inline" :label="t('overview.read.scope')" />
      <UiButton :disabled="scopeRetrying" @click="retryScope">{{ t('overview.read.reload') }}</UiButton>
    </div>
    <div v-else class="overview-content-grid">
      <section class="overview-section overview-attention-section" aria-labelledby="overview-attention-heading">
        <header class="overview-section-header">
          <h2 id="overview-attention-heading">{{ t('overview.sections.attention') }}</h2>
          <div class="overview-request-actions">
          <UiButton variant="ghost" :disabled="requests.loading" data-testid="overview-attention-retry" @click="data.loadRequests">{{ t('overview.attention.refresh') }}</UiButton>
          <RouterLink class="ui-button ui-button--ghost" data-testid="overview-attention-all" :to="inboxLocation()">{{ requests.data && !requests.data.partial ? t('overview.attention.all', { count: requests.data.total }) : t('overview.attention.open') }}</RouterLink>
          </div>
        </header>
        <OverviewReadStatus :state="requests" :label="t('overview.attention.loading')" :failed="t('overview.attention.loadFailed')" @retry="data.loadRequests" />
        <ul v-if="attentionItem" class="overview-attention-list">
          <li :key="`${activeSpaceId}:${attentionItem.requestId}`" class="overview-attention-item" data-testid="overview-attention-item">
            <div class="overview-request-copy">
              <h3>{{ attentionItem.title?.trim() || t('overview.missing.requestTitle') }}</h3>
              <p class="overview-meta">{{ t('overview.attention.agent', { id: agentName(attentionItem.agentId) }) }} · {{ projectName(attentionItem.personalProjectId) }}</p>
              <OverviewExcerpt :text="attentionItem.requestedAction?.trim() || t('overview.attention.viewContent')" />
              <details v-if="attentionItem.detail" class="overview-request-detail"><summary>{{ t('overview.attention.detail') }}</summary><p>{{ attentionItem.detail }}</p></details>
            </div>
            <div class="overview-request-actions">
              <RouterLink class="ui-button ui-button--primary" data-testid="overview-attention-open" :to="inboxLocation(attentionItem.agentId, attentionItem.requestId)">{{ t(requests.error ? 'overview.attention.recheck' : 'overview.attention.respond') }}</RouterLink>
              <RouterLink v-if="attentionItem.taskId" class="ui-button ui-button--ghost" data-testid="overview-attention-task" :to="overviewAttentionTaskHref({ ...attentionItem, taskId: attentionItem.taskId })">{{ t('overview.attention.openTask') }}</RouterLink>
            </div>
          </li>
        </ul>
        <p v-else-if="requests.data && !requests.error && !requests.loading" class="overview-empty">{{ t(requests.data.partial ? 'overview.read.partial' : 'overview.attention.empty') }}</p>
      </section>

      <section class="overview-section overview-work-section" aria-labelledby="overview-work-heading">
        <header class="overview-section-header overview-work-header">
          <div><h2 id="overview-work-heading">{{ t('overview.sections.currentWork') }}</h2><span v-if="tasks.data?.partial" class="ui-badge">{{ t('overview.read.partial') }}</span></div>
          <div class="overview-work-controls">
            <UiSelect :model-value="view" :options="viewOptions" :label="t('overview.views.label')" @update:model-value="chooseView" />
            <UiButton v-if="!tasks.error" :disabled="tasks.loading" variant="ghost" data-testid="overview-work-retry" @click="data.loadTasks">{{ t('overview.work.refresh') }}</UiButton>
          </div>
        </header>
        <OverviewReadStatus :state="tasks" :label="t('overview.work.loading')" :failed="t('overview.work.loadFailed')" test-id="overview-work-retry" @retry="data.loadTasks" />
        <OverviewReadStatus :state="names" :label="t('overview.missing.nameLoading')" :failed="t('overview.missing.nameUnavailable')" @retry="data.loadNames" />
        <p v-if="names.data?.partial" class="overview-notice">{{ t('overview.missing.nameUnavailable') }} <UiButton variant="ghost" :disabled="names.loading" @click="data.loadNames">{{ t('overview.read.reload') }}</UiButton></p>
        <p v-if="sceneFailed" class="overview-notice" role="status">{{ t('overview.views.fallback') }}</p>
        <ConstellationBoard v-if="view === 'constellation' && (currentTasks.length || data.requestItems.value.length)" :board="board" />
        <Workbench3D v-if="view === 'office' && (currentTasks.length || data.requestItems.value.length)" :key="activeSpaceId" :board="board" scene="office" @fallback="sceneFallback" @pick="pick" />
        <div v-if="selectedTask && view !== 'list'" class="overview-selected" role="status">
          <strong>{{ owner(selectedTask) }}</strong><p>{{ taskTitle(selectedTask) }} · {{ statusLabel(selectedTask.status) }}</p>
          <RouterLink class="ui-button ui-button--ghost" :to="nextHref(selectedTask)">{{ nextLabel(selectedTask) }}</RouterLink>
        </div>
        <div v-else-if="selectedRequest && view !== 'list'" class="overview-selected" role="status">
          <strong>{{ agentName(selectedRequest.agentId) }}</strong><p>{{ selectedRequest.title?.trim() || t('overview.missing.requestTitle') }} · {{ t('workbench.projection.waiting') }}</p>
          <RouterLink class="ui-button ui-button--ghost" :to="inboxLocation(selectedRequest.agentId, selectedRequest.requestId)">{{ t('overview.actions.request') }}</RouterLink>
        </div>
        <p v-if="view !== 'list' && currentTasks.length" class="overview-meta">{{ t('overview.views.equivalent') }}</p>
        <div v-if="currentTasks.length || (view !== 'list' && data.requestItems.value.length)">
          <component :is="view === 'list' ? 'div' : 'details'" v-for="group in taskGroups" :key="group.id" :open="view === 'list' ? undefined : true" class="overview-task-group">
            <summary v-if="view !== 'list'">{{ projectName(group.id) }}</summary>
            <ul v-if="view !== 'list' && group.requests.length" class="overview-request-members">
              <li v-for="request in group.requests" :key="request.requestId">
                <p><strong>{{ agentName(request.agentId) }}</strong> · {{ request.title?.trim() || t('overview.missing.requestTitle') }} · {{ t('workbench.projection.waiting') }}</p>
                <RouterLink class="ui-button ui-button--ghost" :to="inboxLocation(request.agentId, request.requestId)">{{ t('overview.actions.request') }}</RouterLink>
              </li>
            </ul>
            <ul class="overview-work-list">
          <li v-for="task in group.items" :key="`${activeSpaceId}:${task.personalProjectId}:${task.taskId}`" class="overview-current-work-item" :class="{ 'is-selected': selected === `${task.personalProjectId}:${task.taskId}` }" data-testid="overview-current-work-item">
            <div class="overview-task-heading"><h3>{{ taskTitle(task) }}</h3><span class="ui-badge" :class="`overview-status-${task.status}`">{{ statusLabel(task.status) }}</span></div>
            <p class="overview-meta">{{ t('overview.work.owner', { name: owner(task) }) }} · {{ projectName(task.personalProjectId) }}</p>
            <OverviewExcerpt v-if="task.status === 'blocked' || task.status === 'failed'" class="overview-reason" :text="task.failureReason?.trim() || t('overview.missing.reason')" />
            <div class="overview-task-footer">
              <time :datetime="task.updatedAt || task.createdAt || undefined">{{ formatDate(task.updatedAt || task.createdAt) }}</time>
              <div>
                <UiButton v-if="view !== 'list'" variant="ghost" :aria-label="t('overview.views.select', { name: owner(task) })" :aria-expanded="selected === `${task.personalProjectId}:${task.taskId}`" @click="selected = selected === `${task.personalProjectId}:${task.taskId}` ? '' : `${task.personalProjectId}:${task.taskId}`">{{ t('overview.views.inspect') }}</UiButton>
                <RouterLink class="ui-button ui-button--ghost" :to="nextHref(task)">{{ nextLabel(task) }}</RouterLink>
              </div>
            </div>
          </li>
            </ul>
          </component>
        </div>
        <p v-else-if="tasks.data && !tasks.error && !tasks.loading" class="overview-empty">{{ t(tasks.data.partial ? 'overview.read.partial' : 'overview.work.empty') }}</p>
        <UiButton v-if="allTaskCount > 6 && view === 'list'" variant="ghost" :aria-expanded="expanded" @click="expanded = !expanded">{{ t(expanded ? 'overview.work.collapse' : 'overview.work.expand', { count: allTaskCount }) }}</UiButton>
        <p v-if="tasks.data?.partial" class="overview-meta">{{ t('overview.work.loaded', { count: data.taskItems.value.length }) }}</p>
      </section>

      <aside class="overview-column">
        <section class="overview-section" aria-labelledby="overview-projects-heading">
          <header class="overview-section-header"><h2 id="overview-projects-heading">{{ t('overview.sections.recentProjects') }}</h2></header>
          <ul class="overview-project-list"><li v-for="project in recentProjectItems" :key="project.id" data-testid="overview-recent-project"><RouterLink :to="personalProjectsPath(activeSpaceId, 'overview', project.id)"><strong>{{ project.name }}</strong><span>{{ project.updatedAt ? formatDate(project.updatedAt) : t('overview.projects.noActivity') }}</span></RouterLink></li></ul>
          <p v-if="!recentProjectItems.length" class="overview-empty">{{ t('overview.projects.empty') }}</p>
        </section>
        <section class="overview-section" aria-labelledby="overview-services-heading">
          <header class="overview-section-header"><h2 id="overview-services-heading">{{ t('overview.sections.services') }}</h2></header>
          <ul class="overview-service-list"><li><strong>{{ t('overview.services.local') }}</strong><span>{{ t(`overview.services.${localServiceStatus}`) }}</span></li><li><strong>{{ t('overview.services.public') }}</strong><span>{{ t(`overview.services.${publicServiceStatus}`) }}</span></li></ul>
        </section>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.overview-view { overflow-wrap: anywhere; padding-bottom: 24px; }
.overview-content-grid { display: grid; grid-template-columns: minmax(0, 2fr) minmax(260px, 1fr); gap: 24px 32px; align-items: start; max-width: var(--page-max); }
.overview-attention-section { grid-column: 1 / -1; }
.overview-column { display: grid; gap: 28px; min-width: 0; }
.overview-section { min-width: 0; }
.overview-section-header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 12px; padding-bottom: 8px; border-bottom: 1px solid var(--color-border); }
.overview-section-header > div:first-child { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
h2 { margin: 0; font-size: 15px; font-weight: 600; color: var(--color-ink); }
h3 { margin: 0; font-size: 16px; font-weight: 600; line-height: 1.5; overflow-wrap: anywhere; }
.overview-work-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.overview-work-controls :deep(.ui-select) { min-width: 120px; max-width: 100%; }
.overview-view :deep(.ui-button) { white-space: normal; max-width: 100%; overflow-wrap: anywhere; }
.overview-view :deep(.ui-button), .overview-work-controls :deep(.ui-select__trigger) { min-height: 44px; }
.overview-meta, time { margin: 4px 0; color: var(--color-muted); font-size: 12px; line-height: 1.6; }
.overview-empty, .overview-notice { margin: 14px 0; font-size: 14px; color: var(--color-ink-soft); }
.overview-attention-list, .overview-work-list, .overview-project-list, .overview-service-list { list-style: none; margin: 0; padding: 0; }
.overview-attention-item { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px 24px; padding: 16px 0; }
.overview-request-copy { min-width: 0; flex: 1 1 420px; }
.overview-request-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.overview-request-detail { margin-top: 4px; font-size: 14px; }
.overview-request-detail summary { display: flex; align-items: center; min-height: 44px; width: fit-content; color: var(--color-accent); cursor: pointer; }
.overview-request-detail p { white-space: pre-wrap; line-height: 1.6; margin: 0; }
.overview-current-work-item { padding: 14px 0 10px; border-bottom: 1px solid var(--color-border); }
.overview-task-heading { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 6px 12px; }
.overview-task-heading h3 { flex: 1 1 210px; }
.overview-task-heading .ui-badge { flex: 0 1 auto; white-space: normal; color: var(--color-ink-soft); }
.overview-task-heading .overview-status-blocked, .overview-task-heading .overview-status-failed { color: var(--color-danger); background: var(--color-danger-soft); }
.overview-reason { margin: 8px 0; color: var(--color-ink-soft); font-size: 14px; }
.overview-task-footer { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 4px 12px; }
.overview-task-footer > div { min-width: 0; max-width: 100%; display: flex; flex-wrap: wrap; gap: 4px; margin-left: auto; }
.overview-request-members { list-style: none; margin: 0; padding: 0; }
.overview-request-members li { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; padding: 8px 0; }
.overview-request-members p { flex: 1 1 180px; margin: 0; font-size: 14px; }
.overview-task-group > summary { min-height: 44px; padding-block: 8px; font-weight: 600; cursor: pointer; color: var(--color-ink); }
.overview-selected, .is-selected { padding: 12px; border-radius: var(--radius-card); background: var(--color-surface); box-shadow: var(--shadow-md); }
.overview-selected { margin-block: 12px; }
.overview-selected p { margin: 4px 0; }
.overview-project-list li, .overview-service-list li { border-bottom: 1px solid var(--color-border); }
.overview-project-list a { display: grid; gap: 4px; padding: 14px 0; color: inherit; text-decoration: none; min-height: 44px; }
.overview-project-list strong, .overview-service-list strong { font-size: 14px; font-weight: 550; }
.overview-project-list span, .overview-service-list span { color: var(--color-muted); font-size: 12px; }
.overview-service-list li { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; padding: 14px 0; }
.overview-view a:focus-visible, .overview-view summary:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 3px; border-radius: 4px; }
@media (max-width: 980px) { .overview-content-grid { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 720px) { .overview-view { padding-bottom: calc(16px + env(safe-area-inset-bottom)); } .overview-attention-item { align-items: start; } .overview-request-copy { flex-basis: 100%; } .overview-section-header { align-items: start; } }
</style>
