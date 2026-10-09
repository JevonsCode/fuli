<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'

import { getJson } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { agentDisplayName } from '@/features/agent-profile/profile-model'
import { useAgentRoster } from '@/features/agent-profile/useAgentRoster'
import { isAgentTaskDataComplete } from '@/features/agent-profile/agent-work-summary'
import {
  currentWork,
  normalizeOverviewTasks,
  overviewAttentionTaskHref,
  overviewTaskHref,
  recentProjects,
} from '@/features/overview/overview-data'
import { useAgentAttention, type AgentAttention } from '@/features/project-agents/attention-store'
import { currentLocale, t } from '@/i18n'
import { personalProjectsPath } from '@/router/paths'
import { useConsoleStore } from '@/stores/console'
import type { ProjectAgentTaskRecord } from '@/types'

const store = useConsoleStore()
const attention = useAgentAttention()
const state = computed(() => store.state)
const consoleBootstrapLoading = computed(() => !state.value
  && (store.runtimeStatus === 'idle' || store.runtimeStatus === 'loading'))
const activePersonalSpace = computed(() => store.activePersonalSpace)
const activeSpaceId = computed(() => activePersonalSpace.value?.id ?? state.value?.activePersonalSpaceId ?? '')
const { agents: rosterAgents } = useAgentRoster(activeSpaceId)
const personalProjects = computed(() => {
  const spaceId = activeSpaceId.value
  return (state.value?.personalProjects ?? []).filter(project => !spaceId || project.personal_space_id === spaceId)
})
const projectNames = computed(() => new Map(personalProjects.value.map(project => [project.project_id, project.profile.name])))
const agentNames = computed(() => {
  const names = new Map<string, string>()
  for (const agent of rosterAgents.value) {
    if (agent.personalSpaceId !== activeSpaceId.value) continue
    const name = agentDisplayName(agent).trim()
    if (!name || name === agent.agentId || agent.legacyAgentIds?.includes(name)) continue
    names.set(agent.agentId, name)
    for (const legacyAgentId of agent.legacyAgentIds ?? []) names.set(legacyAgentId, name)
  }
  return names
})

const tasks = ref<ProjectAgentTaskRecord[]>([])
const tasksLoading = ref(false)
const tasksError = ref('')
const tasksIncomplete = ref(false)
let taskRequestVersion = 0

const currentTasks = computed(() => currentWork(tasks.value))
const recentProjectItems = computed(() => recentProjects(tasks.value, personalProjects.value).map(project => ({
  ...project,
  name: project.name === project.id
    ? (projectNames.value.get(project.id) ?? t('overview.notReported'))
    : project.name,
})))
const hasTaskData = computed(() => tasks.value.length > 0)
const attentionItems = computed(() => attention.previewItems)
const attentionHasData = computed(() => attentionItems.value.length > 0)

const localServiceStatus = computed(() => {
  if (store.runtimeStatus === 'error' || state.value?.providers?.personal?.status === 'error') return 'error'
  if (store.runtimeStatus === 'ready' && state.value?.providers?.personal?.status !== 'loading') return 'ready'
  return 'loading'
})
const publicServiceStatus = computed(() => {
  if (store.publicRuntimeStatus === 'ready') return 'ready'
  if (store.publicRuntimeStatus === 'error') return 'error'
  return 'disconnected'
})
const readyWorkspaces = computed(() => (state.value?.providers?.workspaces ?? []).filter(({ status }) => status === 'ready').length)
const publicServiceDetail = computed(() => {
  if (publicServiceStatus.value === 'ready') {
    return t('overview.services.publicReadyDetail', { count: readyWorkspaces.value })
  }
  if (publicServiceStatus.value === 'error') return t('overview.services.publicErrorDetail')
  return t('overview.services.publicOfflineDetail')
})

watch(activeSpaceId, (spaceId) => {
  if (!spaceId) {
    taskRequestVersion++
    tasks.value = []
    tasksLoading.value = false
    tasksError.value = ''
    tasksIncomplete.value = false
    return
  }
  tasks.value = []
  tasksError.value = ''
  tasksIncomplete.value = false
  void loadTasks(spaceId)
  void attention.refreshPreview(spaceId)
}, { immediate: true })

onMounted(() => {
  if (store.runtimeStatus === 'idle') void store.refresh()
})

async function loadTasks(spaceId: string) {
  const current = ++taskRequestVersion
  tasksLoading.value = true
  tasksError.value = ''
  try {
    const query = new URLSearchParams({ personalSpaceId: spaceId, limit: '200' })
    const value = await getJson<unknown>(`/api/project-agent-tasks?${query}`)
    if (current !== taskRequestVersion) return
    tasks.value = normalizeOverviewTasks(value, spaceId)
    tasksIncomplete.value = !isAgentTaskDataComplete(value, 200)
  } catch (cause) {
    if (current === taskRequestVersion) tasksError.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    if (current === taskRequestVersion) tasksLoading.value = false
  }
}

function retryTasks() {
  if (activeSpaceId.value) void loadTasks(activeSpaceId.value)
}

function retryAttention() {
  if (activeSpaceId.value) void attention.refreshPreview(activeSpaceId.value, { force: true })
}

function projectName(projectId: string | null | undefined) {
  if (!projectId) return t('overview.notReported')
  return projectNames.value.get(projectId) ?? t('overview.notReported')
}

function attentionAgentName(agentId: string) {
  return agentNames.value.get(agentId) ?? ''
}

function attentionMeta(item: AgentAttention) {
  const agentName = attentionAgentName(item.agentId)
  const project = projectName(item.personalProjectId)
  return agentName
    ? `${t('overview.attention.agent', { id: agentName })} · ${project}`
    : project
}

function attentionTaskHref(item: AgentAttention) {
  return item.taskId
    ? overviewAttentionTaskHref({ ...item, taskId: item.taskId })
    : '/project-agents/manage'
}

function formatDate(value: string | null | undefined) {
  if (!value) return t('overview.notReported')
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return t('overview.notReported')
  return new Intl.DateTimeFormat(currentLocale(), {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(date)
}

function taskStatusLabel(status: string) {
  const key = `overview.taskStatus.${status}`
  const translated = t(key)
  return translated === key ? status : translated
}

function serviceStatusLabel(status: 'ready' | 'loading' | 'error' | 'disconnected') {
  return t(`overview.services.${status}`)
}

function taskMeta(task: ProjectAgentTaskRecord) {
  const project = task.personalProjectId ? projectName(task.personalProjectId) : ''
  const updated = task.updatedAt ?? task.createdAt
  return [project, updated ? t('overview.work.updated', { date: formatDate(updated) }) : ''].filter(Boolean).join(' · ')
}
</script>

<template>
  <section class="view overview-view">
    <GrowthLoading v-if="consoleBootstrapLoading" :label="t('common.status.loadingConsole')" />
    <div v-else class="overview-content-grid">
      <section class="ui-card overview-section overview-attention-section" aria-labelledby="overview-attention-heading">
        <header class="ui-toolbar overview-section-header">
          <div>
            <h2 id="overview-attention-heading">{{ t('overview.sections.attention') }}</h2>
            <span v-if="attention.previewTotal" class="ui-badge overview-count">{{ t('overview.attention.count', { count: attention.previewTotal }) }}</span>
          </div>
          <div class="overview-section-actions">
            <GrowthLoading v-if="attention.previewLoading && attentionHasData" variant="inline" :label="t('overview.attention.loading')" />
            <button class="quiet-button" type="button" data-testid="overview-attention-all" @click="attention.show()">{{ t('overview.attention.open') }}</button>
          </div>
        </header>
        <GrowthLoading v-if="attention.previewLoading && !attentionHasData" variant="compact" :label="t('overview.attention.loading')" />
        <div v-else-if="attention.previewError && !attentionHasData" class="ui-empty overview-state" role="alert">
          <p>{{ t('overview.attention.loadFailed') }} · {{ attention.previewError }}</p>
          <button class="quiet-button" type="button" @click="retryAttention">{{ t('overview.attention.retry') }}</button>
        </div>
        <div v-else-if="!attentionHasData" class="ui-empty overview-state">
          <p>{{ t('overview.attention.empty') }}</p>
        </div>
        <ul v-else class="overview-attention-list">
          <li v-for="item in attentionItems" :key="item.requestId" class="overview-attention-item" data-testid="overview-attention-item">
            <button class="overview-attention-open" data-testid="overview-attention-open" type="button" @click="attention.show(item.agentId)">
              <strong>{{ item.title }}</strong>
              <span>{{ attentionMeta(item) }}</span>
            </button>
            <RouterLink
              v-if="item.taskId"
              class="quiet-button overview-task-link"
              data-testid="overview-attention-task"
              :to="attentionTaskHref(item)"
            >
              {{ t('overview.attention.openTask') }}
            </RouterLink>
          </li>
        </ul>
        <div v-if="attention.previewError && attentionHasData" class="overview-inline-error" role="alert">
          <span>{{ t('overview.attention.loadFailed') }} · {{ attention.previewError }}</span>
          <button class="quiet-button" type="button" @click="retryAttention">{{ t('overview.attention.retry') }}</button>
        </div>
      </section>

      <section class="ui-card overview-section overview-work-section" aria-labelledby="overview-work-heading">
        <header class="ui-toolbar overview-section-header">
          <div><h2 id="overview-work-heading">{{ t('overview.sections.currentWork') }}</h2></div>
          <div class="overview-section-actions">
            <GrowthLoading v-if="tasksLoading && hasTaskData" variant="inline" :label="t('overview.work.loading')" />
            <button v-else-if="!tasksError" class="quiet-button" type="button" data-testid="overview-work-retry" @click="retryTasks">{{ t('overview.work.refresh') }}</button>
          </div>
        </header>
        <GrowthLoading v-if="tasksLoading && !hasTaskData" variant="compact" :label="t('overview.work.loading')" />
        <div v-else-if="tasksError && !hasTaskData" class="ui-empty overview-state" role="alert">
          <p>{{ t('overview.work.loadFailed') }} · {{ tasksError }}</p>
          <button class="quiet-button" type="button" data-testid="overview-work-retry" @click="retryTasks">{{ t('overview.work.retry') }}</button>
        </div>
        <div v-else-if="tasksIncomplete && !currentTasks.length" class="ui-empty overview-state" role="status">
          <p>{{ t('agentProfiles.partial') }}</p>
        </div>
        <div v-else-if="!currentTasks.length" class="ui-empty overview-state">
          <p>{{ t('overview.work.empty') }}</p>
        </div>
        <ul v-else class="overview-work-list">
          <li v-for="task in currentTasks" :key="task.taskId" class="overview-current-work-item" data-testid="overview-current-work-item">
            <RouterLink class="overview-task-card" :to="overviewTaskHref(task)">
              <span class="overview-task-heading">
                <strong>{{ task.title }}</strong>
                <span class="ui-badge" :class="`overview-status-${task.status}`">{{ taskStatusLabel(task.status) }}</span>
              </span>
              <span class="overview-task-meta">{{ taskMeta(task) }}</span>
            </RouterLink>
          </li>
        </ul>
        <div v-if="tasksIncomplete && currentTasks.length" class="overview-inline-notice" role="status">
          {{ t('agentProfiles.partial') }}
        </div>
        <div v-if="tasksError && hasTaskData" class="overview-inline-error" role="alert">
          <span>{{ t('overview.work.loadFailed') }} · {{ tasksError }}</span>
          <button class="quiet-button" type="button" data-testid="overview-work-retry" @click="retryTasks">{{ t('overview.work.retry') }}</button>
        </div>
      </section>

      <section class="ui-card overview-section overview-projects-section" aria-labelledby="overview-projects-heading">
        <header class="ui-toolbar overview-section-header">
          <h2 id="overview-projects-heading">{{ t('overview.sections.recentProjects') }}</h2>
        </header>
        <div v-if="!recentProjectItems.length" class="ui-empty overview-state">
          <p>{{ t('overview.projects.empty') }}</p>
        </div>
        <ul v-else class="overview-project-list">
          <li v-for="project in recentProjectItems" :key="project.id" class="overview-recent-project" data-testid="overview-recent-project">
            <RouterLink :to="personalProjectsPath(activeSpaceId, 'graph', project.id)">
              <strong>{{ project.name }}</strong>
              <span>{{ project.updatedAt ? t('overview.projects.updated', { date: formatDate(project.updatedAt) }) : t('overview.projects.noActivity') }}</span>
            </RouterLink>
          </li>
        </ul>
      </section>

      <section class="ui-card overview-section overview-services-section" aria-labelledby="overview-services-heading">
        <header class="ui-toolbar overview-section-header">
          <h2 id="overview-services-heading">{{ t('overview.sections.services') }}</h2>
        </header>
        <ul class="overview-service-list">
          <li class="overview-service-item">
            <span class="overview-service-dot" :class="`is-${localServiceStatus}`" aria-hidden="true" />
            <div><strong>{{ t('overview.services.local') }}</strong><span>{{ t('overview.services.localDetail') }}</span></div>
            <span class="ui-badge">{{ serviceStatusLabel(localServiceStatus) }}</span>
          </li>
          <li class="overview-service-item">
            <span class="overview-service-dot" :class="`is-${publicServiceStatus}`" aria-hidden="true" />
            <div><strong>{{ t('overview.services.public') }}</strong><span>{{ publicServiceDetail }}</span></div>
            <span class="ui-badge">{{ serviceStatusLabel(publicServiceStatus) }}</span>
          </li>
        </ul>
      </section>
    </div>
  </section>
</template>

<style scoped>
.overview-view {
  display: grid;
  gap: var(--space-6, 24px);
}

.overview-content-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr);
  gap: var(--space-4, 16px);
  align-items: start;
}

.overview-section {
  min-width: 0;
  padding: var(--space-5, 20px);
}

.overview-attention-section {
  grid-column: 1 / -1;
}

.overview-section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3, 12px);
  min-height: 30px;
  margin-bottom: var(--space-4, 16px);
}

.overview-section-header > div:first-child {
  display: flex;
  align-items: center;
  gap: var(--space-2, 8px);
  min-width: 0;
}

.overview-section-header h2 {
  margin: 0;
  color: var(--color-ink);
  font-size: 17px;
  line-height: 1.3;
}

.overview-section-actions,
.overview-inline-error {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2, 8px);
}

.overview-inline-error {
  justify-content: space-between;
  margin-top: var(--space-3, 12px);
  color: var(--color-danger);
  font-size: 12px;
}

.overview-inline-notice {
  margin-top: var(--space-3, 12px);
  color: var(--color-muted);
  font-size: 12px;
  line-height: 1.45;
}

.overview-state {
  display: grid;
  gap: var(--space-3, 12px);
  justify-items: start;
  min-height: 104px;
  align-content: center;
  text-align: left;
}

.overview-state p {
  margin: 0;
  color: var(--color-muted);
  font-size: 14px;
}

.overview-attention-list,
.overview-work-list,
.overview-project-list,
.overview-service-list {
  display: grid;
  gap: 1px;
  margin: 0;
  padding: 0;
  list-style: none;
  border: 0;
}

.overview-attention-item,
.overview-current-work-item,
.overview-recent-project,
.overview-service-item {
  min-width: 0;
  background: var(--color-surface);
  border-top: 1px solid var(--color-border);
}

.overview-attention-item:first-child,
.overview-current-work-item:first-child,
.overview-recent-project:first-child,
.overview-service-item:first-child {
  border-top: 0;
}

.overview-attention-item {
  display: flex;
  align-items: center;
  gap: var(--space-3, 12px);
  padding: var(--space-3, 12px);
}

.overview-attention-open,
.overview-task-card,
.overview-project-list a {
  min-width: 0;
  color: inherit;
  text-align: left;
  text-decoration: none;
}

.overview-attention-open {
  display: grid;
  flex: 1;
  gap: 3px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--color-ink);
  font: inherit;
  cursor: pointer;
}

.overview-attention-open:hover strong,
.overview-task-card:hover strong,
.overview-project-list a:hover strong {
  color: var(--color-accent);
}

.overview-attention-open strong,
.overview-task-card strong,
.overview-project-list strong {
  overflow: hidden;
  font-size: 14px;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.overview-attention-open span,
.overview-task-meta,
.overview-project-list span,
.overview-service-item div span {
  overflow: hidden;
  color: var(--color-muted);
  font-size: 12px;
  line-height: 1.45;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.overview-task-link {
  flex: 0 0 auto;
  padding-inline: 8px;
}

.overview-task-card {
  display: grid;
  gap: 5px;
  padding: var(--space-3, 12px);
}

.overview-task-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3, 12px);
  min-width: 0;
}

.overview-task-heading strong {
  min-width: 0;
  overflow-wrap: anywhere;
}

.overview-task-heading .ui-badge {
  flex: 0 0 auto;
  white-space: nowrap;
}

.overview-project-list a {
  display: grid;
  gap: 5px;
  padding: var(--space-3, 12px);
}

.overview-service-item {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--space-3, 12px);
  padding: var(--space-3, 12px);
}

.overview-service-item div {
  display: grid;
  gap: 3px;
  min-width: 0;
}

.overview-service-item strong {
  font-size: 13px;
}

.overview-service-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-muted);
}

.overview-service-dot.is-ready { background: var(--color-success); }
.overview-service-dot.is-error { background: var(--color-danger); }
.overview-service-dot.is-loading { background: var(--color-accent); }

@media (min-width: 1360px) {
  .overview-content-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .overview-attention-section { grid-column: 1 / -1; }
  .overview-work-section { grid-column: span 2; }
  .overview-projects-section { grid-column: span 1; }
  .overview-services-section { grid-column: 1 / -1; }
}

@media (max-width: 1100px) {
  .overview-content-grid { grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr); }
}

@media (max-width: 680px) {
  .overview-content-grid { grid-template-columns: minmax(0, 1fr); }
  .overview-section { padding: var(--space-4, 16px); }
  .overview-attention-section { grid-column: 1 / -1; }
  .overview-attention-item { align-items: start; flex-direction: column; }
  .overview-task-link { align-self: flex-start; }
}
</style>
