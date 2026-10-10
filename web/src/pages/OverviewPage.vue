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
      <div class="overview-column">
      <section class="overview-section overview-attention-section" aria-labelledby="overview-attention-heading">
        <header class="ui-toolbar overview-section-header">
          <div>
            <h2 id="overview-attention-heading">{{ t('overview.sections.attention') }}</h2>
            <span v-if="attention.previewTotal" class="ui-badge overview-count">{{ t('overview.attention.count', { count: attention.previewTotal }) }}</span>
          </div>
          <div class="overview-section-actions">
            <GrowthLoading v-if="attention.previewLoading && attentionHasData" variant="inline" :label="t('overview.attention.loading')" />
            <button class="ui-button ui-button--ghost ui-button--sm" type="button" data-testid="overview-attention-all" @click="attention.show()">{{ t('overview.attention.open') }}</button>
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

      <section class="overview-section overview-work-section" aria-labelledby="overview-work-heading">
        <header class="ui-toolbar overview-section-header">
          <div><h2 id="overview-work-heading">{{ t('overview.sections.currentWork') }}</h2></div>
          <div class="overview-section-actions">
            <GrowthLoading v-if="tasksLoading && hasTaskData" variant="inline" :label="t('overview.work.loading')" />
            <button v-else-if="!tasksError" class="ui-button ui-button--ghost ui-button--sm" type="button" data-testid="overview-work-retry" @click="retryTasks">{{ t('overview.work.refresh') }}</button>
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
      </div>

      <div class="overview-column">
      <section class="overview-section overview-projects-section" aria-labelledby="overview-projects-heading">
        <header class="ui-toolbar overview-section-header">
          <h2 id="overview-projects-heading">{{ t('overview.sections.recentProjects') }}</h2>
        </header>
        <div v-if="!recentProjectItems.length" class="ui-empty overview-state">
          <p>{{ t('overview.projects.empty') }}</p>
        </div>
        <ul v-else class="overview-project-list">
          <li v-for="project in recentProjectItems" :key="project.id" class="overview-recent-project" data-testid="overview-recent-project">
            <RouterLink :to="personalProjectsPath(activeSpaceId, 'overview', project.id)">
              <strong>{{ project.name }}</strong>
              <span>{{ project.updatedAt ? t('overview.projects.updated', { date: formatDate(project.updatedAt) }) : t('overview.projects.noActivity') }}</span>
            </RouterLink>
          </li>
        </ul>
      </section>

      <section class="overview-section overview-services-section" aria-labelledby="overview-services-heading">
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
    </div>
  </section>
</template>

<style scoped>
.overview-content-grid { display: grid; grid-template-columns: minmax(0, 1.7fr) minmax(280px, 1fr); gap: 40px; align-items: start; max-width: var(--page-max); }
.overview-column { display: grid; gap: 36px; min-width: 0; }
.overview-section { min-width: 0; }
.overview-section-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 30px; padding-bottom: 10px; border-bottom: 1px solid var(--color-border); }
.overview-section-header > div:first-child { display: flex; align-items: center; gap: 8px; min-width: 0; }
.overview-section-header h2 { margin: 0; font-size: 13px; font-weight: 600; letter-spacing: .04em; color: var(--color-muted); }
.overview-section-actions, .overview-inline-error { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
.overview-inline-error { justify-content: space-between; margin-top: 12px; color: var(--color-danger); font-size: 12px; }
.overview-inline-notice { margin-top: 12px; color: var(--color-muted); font-size: 12px; }
.overview-state { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 18px 0; text-align: left; }
.overview-state p { margin: 0; color: var(--color-faint); font-size: 14px; }
.overview-attention-list, .overview-work-list, .overview-project-list, .overview-service-list { display: grid; margin: 0; padding: 0; list-style: none; }
.overview-attention-item, .overview-current-work-item, .overview-recent-project, .overview-service-item { min-width: 0; border-bottom: 1px solid var(--color-border); }
.overview-attention-item { display: flex; align-items: center; gap: 12px; padding: 12px 0; }
.overview-attention-open, .overview-task-card, .overview-project-list a { min-width: 0; color: inherit; text-align: left; text-decoration: none; }
.overview-attention-open { display: grid; flex: 1; gap: 3px; padding: 0; border: 0; background: transparent; color: var(--color-ink); font: inherit; cursor: pointer; }
.overview-attention-open:hover strong, .overview-task-card:hover strong, .overview-project-list a:hover strong { color: var(--color-accent); }
.overview-attention-open strong, .overview-task-card strong, .overview-project-list strong { overflow: hidden; font-size: 14px; font-weight: 550; line-height: 1.4; text-overflow: ellipsis; white-space: nowrap; transition: color var(--motion-fast); }
.overview-attention-open span, .overview-task-meta, .overview-project-list span, .overview-service-item div span { overflow: hidden; color: var(--color-muted); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.overview-task-link { flex: 0 0 auto; }
.overview-task-card { display: grid; gap: 4px; padding: 12px 0; }
.overview-task-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-width: 0; }
.overview-task-heading strong { min-width: 0; }
.overview-task-heading .ui-badge { flex: 0 0 auto; }
.overview-project-list a { display: grid; gap: 2px; padding: 11px 0; }
.overview-service-item { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 12px; padding: 11px 0; }
.overview-service-item div { display: grid; gap: 2px; min-width: 0; }
.overview-service-item strong { font-size: 13px; font-weight: 550; }
.overview-service-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--color-faint); }
.overview-service-dot.is-ready { background: var(--color-success); box-shadow: 0 0 0 3px var(--color-success-soft); }
.overview-service-dot.is-error { background: var(--color-danger); box-shadow: 0 0 0 3px var(--color-danger-soft); }
.overview-service-dot.is-loading { background: var(--color-accent); }
@media (max-width: 980px) {
  .overview-content-grid { grid-template-columns: minmax(0, 1fr); gap: 32px; }
  .overview-attention-item { align-items: start; flex-direction: column; }
}
</style>
