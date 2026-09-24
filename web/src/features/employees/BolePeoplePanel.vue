<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { getJson } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { t } from '@/i18n'
import type { PersonalProject } from '@/types'
import ProjectScopePicker from './ProjectScopePicker.vue'
import { employeeAvatarUrl } from './avatars'
import AgentHand from '@/features/project-agents/AgentHand.vue'
import AgentName from '@/features/agent-profile/AgentName.vue'
import { fuzzyMatch } from '@/features/agent-profile/profile-model'

type UnknownRecord = Record<string, unknown>
type AgentView = {
  id: string
  name: string
  emoji: string
  responsibility: string
  searchTerms: string[]
  type: string
  status: string
  projectIds: string[]
  currentTaskId: string
  workStatus: string
}
type TaskView = {
  id: string
  title: string
  status: string
  projectId: string
  agentIds: string[]
  updatedAt: string
}
type RecruitmentView = {
  id: string
  agentId: string
  projectId: string
  workKind: string
  positionKind: string
  reason: string
  status: string
  createdAt: string
}

const props = defineProps<{ personalSpaceId: string; projects: PersonalProject[] }>()
const route = useRoute()
const agents = ref<AgentView[]>([])
const tasks = ref<TaskView[]>([])
const recruitments = ref<RecruitmentView[]>([])
const loading = ref(false)
const partialError = ref(false)
const activeView = ref<'people' | 'history'>('people')
const search = ref('')
const roleFilter = ref('')
const workFilter = ref('all')
const selectedProjects = ref<string[] | null>(null)
const scrollRegion = ref<HTMLElement | null>(null)
const unassignedKey = '__bole_unassigned__'
const taskLimit = 200
const tasksMayBeTruncated = computed(() => tasks.value.length >= taskLimit)
let requestVersion = 0

const openStatuses = new Set(['awaiting_recruitment', 'queued', 'running', 'paused', 'awaiting_review', 'blocked'])
const projectNames = computed(() => new Map(props.projects.map((project) => [project.project_id, project.profile.name])))
const activeAgents = computed(() => agents.value.filter((agent) => agent.status === 'active'))
const openTasks = computed(() => tasks.value.filter((task) => openStatuses.has(task.status)))
const workingAgentIds = computed(() => {
  return new Set(agentRows.value.filter((agent) => agent.task).map((agent) => agent.id))
})
const coveredProjectIds = computed(() => new Set(activeAgents.value.flatMap((agent) => agent.projectIds).filter(Boolean)))
const distribution = computed(() => {
  const order = ['coordinator', 'durable', 'hr', 'temporary']
  const counts = new Map<string, number>()
  for (const agent of activeAgents.value) counts.set(agent.type, (counts.get(agent.type) ?? 0) + 1)
  return [...counts.entries()]
    .sort(([left], [right]) => sortIndex(order, left) - sortIndex(order, right))
    .map(([type, count]) => ({ type, count, label: typeLabel(type) }))
})
const agentRows = computed(() => activeAgents.value.map((agent) => ({
  ...agent,
  task: agent.workStatus ? (openStatuses.has(agent.workStatus) && agent.currentTaskId
    ? tasks.value.find((task) => task.id === agent.currentTaskId) ?? {
      id: agent.currentTaskId, title: agent.currentTaskId, status: agent.workStatus,
      projectId: '', agentIds: [agent.id], updatedAt: '',
    } : undefined) : openTasks.value
    .filter((task) => task.agentIds.includes(agent.id))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0],
})))
const recruitmentRows = computed(() => [...recruitments.value].sort((left, right) => right.createdAt.localeCompare(left.createdAt)))
const projectOptions = computed(() => {
  const ids = new Set([...props.projects.map((project) => project.project_id), ...agents.value.flatMap((agent) => agent.projectIds), ...tasks.value.map((task) => task.projectId), ...recruitments.value.map((item) => item.projectId)].filter(Boolean))
  return [...ids].map((id) => ({ id, name: projectNames.value.get(id) ?? id }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .concat({ id: unassignedKey, name: t('employees.bole.noProject') })
})
const projectSelection = computed({
  get: () => selectedProjects.value ?? projectOptions.value.map((project) => project.id),
  set: (ids: string[]) => { selectedProjects.value = ids.length === projectOptions.value.length ? null : ids },
})
const filteredAgents = computed(() => agentRows.value.filter((agent) => {
  const projects = [...agent.projectIds, ...(agent.task?.projectId ? [agent.task.projectId] : [])]
  return matchesProject(projects) && (!roleFilter.value || agent.type === roleFilter.value)
    && (workFilter.value === 'all' || (workFilter.value === 'working' ? Boolean(agent.task) : !agent.task))
    && matchesSearch([agent.name, agent.responsibility, ...agent.searchTerms, agent.task?.title ?? '', ...projects.map(projectName)])
}).sort((a, b) => Number(Boolean(b.task)) - Number(Boolean(a.task)) || a.name.localeCompare(b.name)))
const filteredRecruitments = computed(() => recruitmentRows.value.filter((item) =>
  matchesProject(item.projectId ? [item.projectId] : []) && (!roleFilter.value || item.positionKind === roleFilter.value)
    && matchesSearch([...agentSearchTerms(item.agentId), item.reason, item.workKind, projectName(item.projectId)]),
))
const filtersActive = computed(() => search.value || roleFilter.value || selectedProjects.value !== null || (activeView.value === 'people' && workFilter.value !== 'all'))

function matchesProject(ids: string[]) {
  return selectedProjects.value === null || (ids.length ? ids : [unassignedKey]).some((id) => selectedProjects.value?.includes(id))
}
function matchesSearch(parts: string[]) { return fuzzyMatch(parts.join(' '), search.value) }
function agentSearchTerms(id: string) {
  const agent = agents.value.find((item) => item.id === id)
  return agent ? [agent.name, agent.responsibility, ...agent.searchTerms] : [id]
}
function clearFilters() { search.value = ''; roleFilter.value = ''; workFilter.value = 'all'; selectedProjects.value = null }
function avatar(agentId: string) { return employeeAvatarUrl(agentId.replace(/^employee\./, '')) }

watch([activeView, search, roleFilter, workFilter, selectedProjects], () => { if (scrollRegion.value) scrollRegion.value.scrollTop = 0 })

watch([() => props.personalSpaceId, () => route.query.q], ([space, query], [previousSpace]) => {
  if (space !== previousSpace) {
    clearFilters()
    // A query link prefills the initial space; changing spaces clears old filters.
    if (previousSpace === undefined) search.value = typeof query === 'string' ? query : ''
    void load()
  } else search.value = typeof query === 'string' ? query : ''
}, { immediate: true })

async function load() {
  const current = ++requestVersion
  agents.value = []
  tasks.value = []
  recruitments.value = []
  partialError.value = false
  if (!props.personalSpaceId) { loading.value = false; return }
  loading.value = true
  const query = new URLSearchParams({ personalSpaceId: props.personalSpaceId })
  const results = await Promise.allSettled([
    getJson<unknown>(`/api/project-agents?${query}`),
    getJson<unknown>(`/api/project-agent-tasks?${query}&limit=${taskLimit}`),
    getJson<unknown>(`/api/project-agent-recruitments?${query}`),
  ])
  if (current !== requestVersion) return
  if (results[0].status === 'fulfilled') agents.value = values(results[0].value, 'agents').map(normalizeAgent).filter(isPresent)
  if (results[1].status === 'fulfilled') tasks.value = values(results[1].value, 'tasks').map(normalizeTask).filter(isPresent)
  if (results[2].status === 'fulfilled') recruitments.value = values(results[2].value, 'recruitments').map(normalizeRecruitment).filter(isPresent)
  partialError.value = results.some((result) => result.status === 'rejected')
  loading.value = false
}

function record(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : {}
}
function values(value: unknown, key: string): unknown[] {
  if (Array.isArray(value)) return value
  const container = record(value)
  const result = container[key] ?? container.items
  return Array.isArray(result) ? result : []
}
function pickString(value: UnknownRecord, camel: string, snake = camel): string {
  const result = value[camel] ?? value[snake]
  return typeof result === 'string' ? result : ''
}
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : [] }
function normalizeAgent(value: unknown): AgentView | null {
  const source = record(value)
  const profile = record(source.profile)
  const id = pickString(source, 'agentId', 'agent_id')
  if (!id) return null
  const assignmentProjectIds = array(source.assignments).flatMap((raw) => {
    const assignment = record(raw)
    const status = pickString(assignment, 'status')
    const projectId = pickString(assignment, 'personalProjectId', 'personal_project_id')
    return status === 'active' && projectId ? [projectId] : []
  })
  const primaryProjectId = pickString(source, 'personalProjectId', 'personal_project_id')
  return {
    id,
    name: pickString(profile, 'displayName', 'display_name') || pickString(profile, 'name') || id,
    emoji: pickString(profile, 'occupationEmoji', 'occupation_emoji') || '✦',
    responsibility: pickString(profile, 'responsibility'),
    searchTerms: [pickString(profile, 'name'), ...array(profile.capabilities),
      ...array(profile.workKinds ?? profile.work_kinds)].filter((item): item is string => typeof item === 'string'),
    type: pickString(profile, 'agentType', 'agent_type') || 'other',
    status: pickString(profile, 'status') || 'active',
    projectIds: [...new Set([...assignmentProjectIds, ...(primaryProjectId ? [primaryProjectId] : [])])],
    currentTaskId: pickString(source, 'currentTaskId', 'current_task_id'),
    workStatus: pickString(source, 'workStatus', 'work_status'),
  }
}
function normalizeTask(value: unknown): TaskView | null {
  const source = record(value)
  const id = pickString(source, 'taskId', 'task_id')
  if (!id) return null
  const directAgents = [
    pickString(source, 'ownerAgentId', 'owner_agent_id'),
    pickString(source, 'leadAgentId', 'lead_agent_id'),
  ]
  const participantAgents = array(source.participants).flatMap((raw) => {
    const participant = record(raw)
    const status = pickString(participant, 'status')
    return status && !openStatuses.has(status) ? [] : [pickString(participant, 'agentId', 'agent_id')]
  })
  return {
    id,
    title: pickString(source, 'title') || id,
    status: pickString(source, 'status') || 'queued',
    projectId: pickString(source, 'personalProjectId', 'personal_project_id'),
    agentIds: [...new Set([...directAgents, ...participantAgents].filter(Boolean))],
    updatedAt: pickString(source, 'updatedAt', 'updated_at') || pickString(source, 'createdAt', 'created_at'),
  }
}
function normalizeRecruitment(value: unknown): RecruitmentView | null {
  const source = record(value)
  const id = pickString(source, 'recruitmentId', 'recruitment_id')
  if (!id) return null
  return {
    id,
    agentId: pickString(source, 'recruitedAgentId', 'recruited_agent_id') || pickString(source, 'proposedAgentId', 'proposed_agent_id'),
    projectId: pickString(source, 'personalProjectId', 'personal_project_id'),
    workKind: pickString(source, 'workKind', 'work_kind'),
    positionKind: pickString(source, 'positionKind', 'position_kind'),
    reason: pickString(source, 'reason') || pickString(source, 'reasonCode', 'reason_code'),
    status: pickString(source, 'status'),
    createdAt: pickString(source, 'createdAt', 'created_at'),
  }
}
function isPresent<T>(value: T | null): value is T { return value !== null }
function sortIndex(order: string[], value: string) {
  const index = order.indexOf(value)
  return index < 0 ? order.length : index
}
function typeLabel(type: string) {
  return ['coordinator', 'durable', 'hr', 'temporary'].includes(type)
    ? t(`employees.bole.types.${type}`)
    : t('employees.bole.types.other')
}
function statusLabel(status: string) {
  return ['awaiting_recruitment', 'queued', 'running', 'paused', 'failed', 'awaiting_review', 'blocked'].includes(status)
    ? t(`employees.bole.status.${status}`)
    : status
}
function agentName(agentId: string) { return agents.value.find((agent) => agent.id === agentId)?.name ?? agentId }
function projectName(projectId: string) { return projectNames.value.get(projectId) ?? t('employees.bole.noProject') }
function formattedDate(value: string) {
  if (!value) return t('employees.bole.unknownTime')
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}
</script>

<template>
  <div class="bole-panel" :aria-busy="loading">
    <div v-if="partialError" class="bole-alert" role="alert">
      <span>{{ t('employees.bole.partialError') }}</span>
      <button type="button" @click="load">{{ t('employees.retry') }}</button>
    </div>

    <header class="bole-header">
      <div class="bole-heading">
        <h2 id="bole-overview-title">{{ t('employees.bole.title') }}</h2>
        <nav class="bole-views" :aria-label="t('employees.bole.viewLabel')">
          <button id="bole-work-title" type="button" :aria-pressed="activeView === 'people'" @click="activeView = 'people'">{{ t('employees.bole.currentWork') }} <span data-testid="people-total">{{ loading ? '—' : activeAgents.length }}</span></button>
          <button id="bole-history-title" type="button" :aria-pressed="activeView === 'history'" @click="activeView = 'history'">{{ t('employees.bole.recruitmentHistory') }} <span>{{ loading ? '—' : recruitments.length }}</span></button>
        </nav>
      </div>
      <dl class="bole-summary" :aria-label="t('employees.bole.overview')">
        <div data-testid="people-working"><dt>{{ t('employees.bole.workingNow') }}</dt><dd>{{ loading ? '—' : workingAgentIds.size }}</dd></div>
        <div><dt>{{ t('employees.bole.coveredProjects') }}</dt><dd>{{ loading ? '—' : coveredProjectIds.size }}</dd></div>
      </dl>
      <button class="bole-refresh" type="button" :disabled="loading" @click="load">{{ t('common.actions.refresh') }}</button>
    </header>

    <div class="bole-controls">
      <div class="bole-filters">
        <input v-model="search" type="search" class="bole-search" :aria-label="t('employees.bole.search')" :placeholder="t('employees.bole.search')" aria-describedby="bole-search-hint">
        <ProjectScopePicker v-model="projectSelection" :projects="projectOptions" :label="t('employees.allProjects.projectFilter')" :all-label="t('employees.bole.allProjects')" :empty-label="t('employees.filterEmpty')" compact hint="" />
        <select v-if="activeView === 'people'" v-model="workFilter" :aria-label="t('employees.bole.workFilter')">
          <option value="all">{{ t('employees.bole.allWork') }}</option>
          <option value="working">{{ t('employees.bole.workingNow') }}</option>
          <option value="idle">{{ t('employees.bole.withoutTask') }}</option>
        </select>
      </div>
      <p id="bole-search-hint" class="bole-search-hint">{{ t('agentProfiles.hrSearchHint') }}</p>
      <div class="bole-role-filters" role="group" :aria-label="t('employees.bole.distribution')">
        <button type="button" :aria-pressed="!roleFilter" @click="roleFilter = ''">{{ t('employees.bole.allRoles') }}</button>
        <button v-for="item in distribution" :key="item.type" type="button" :aria-pressed="roleFilter === item.type" @click="roleFilter = roleFilter === item.type ? '' : item.type">{{ item.label }} <span>{{ item.count }}</span></button>
        <button v-if="filtersActive" class="bole-clear" type="button" @click="clearFilters">{{ t('employees.bole.clearFilters') }}</button>
        <span v-if="filtersActive && !loading" class="bole-result-count" role="status">{{ t('employees.bole.resultCount', { count: activeView === 'people' ? filteredAgents.length : filteredRecruitments.length }) }}</span>
      </div>
    </div>

    <div ref="scrollRegion" class="bole-content" tabindex="0" role="region" :aria-label="t(activeView === 'people' ? 'employees.bole.currentWork' : 'employees.bole.recruitmentHistory')">
      <GrowthLoading v-if="loading" variant="compact" :label="t('employees.bole.loading')" />
      <section v-else-if="activeView === 'people'" aria-labelledby="bole-work-title">
        <p v-if="tasksMayBeTruncated" class="bole-empty" role="status">{{ t('employees.bole.taskLimit') }}</p>
        <div v-if="filteredAgents.length" class="bole-agent-list">
          <div class="bole-table-heading" aria-hidden="true"><span>Agent</span><span>{{ t('employees.bole.taskColumn') }}</span><span>{{ t('employees.bole.projectsColumn') }}</span></div>
          <article v-for="agent in filteredAgents" :key="agent.id" class="bole-agent-row">
            <div class="bole-agent-identity">
              <span class="bole-agent-mark" aria-hidden="true"><img v-if="avatar(agent.id)" :src="avatar(agent.id)" alt=""><template v-else>{{ agent.emoji }}</template></span>
              <div><strong><AgentName :space-id="personalSpaceId" :agent-id="agent.id" :name="agent.name" /></strong><AgentHand :agent-id="agent.id" /><small>{{ agent.responsibility || typeLabel(agent.type) }}</small></div>
            </div>
            <div class="bole-agent-work">
              <template v-if="agent.task"><span class="bole-status" :data-status="agent.task.status">{{ statusLabel(agent.task.status) }}</span><p>{{ agent.task.title }}</p></template>
              <p v-else class="is-idle">{{ t('employees.bole.idle') }}</p>
            </div>
            <div class="bole-agent-projects">
              <template v-if="agent.projectIds.length"><span v-for="id in agent.projectIds.slice(0, 2)" :key="id">{{ projectName(id) }}</span><details v-if="agent.projectIds.length > 2"><summary>{{ t('employees.bole.moreProjects', { count: agent.projectIds.length - 2 }) }}</summary><span v-for="id in agent.projectIds.slice(2)" :key="id">{{ projectName(id) }}</span></details></template>
              <span v-else>{{ agent.task?.projectId ? projectName(agent.task.projectId) : t('employees.bole.noProject') }}</span>
            </div>
          </article>
        </div>
        <p v-else class="bole-empty">{{ t(filtersActive ? 'employees.bole.noMatch' : 'employees.bole.noAgents') }}</p>
      </section>

      <section v-else aria-labelledby="bole-history-title">
        <ol v-if="filteredRecruitments.length" class="bole-timeline">
          <li v-for="recruitment in filteredRecruitments" :key="recruitment.id">
            <div class="bole-recruitment-identity"><strong><AgentName :space-id="personalSpaceId" :agent-id="recruitment.agentId" :name="agentName(recruitment.agentId)" /></strong><small>{{ typeLabel(recruitment.positionKind) }} · {{ projectName(recruitment.projectId) }}</small></div>
            <div class="bole-recruitment-reason">
              <p>{{ recruitment.reason }}</p>
              <small>{{ recruitment.workKind || recruitment.status }}</small>
            </div>
            <time :datetime="recruitment.createdAt">{{ formattedDate(recruitment.createdAt) }}</time>
          </li>
        </ol>
        <p v-else class="bole-empty">{{ t(filtersActive ? 'employees.bole.noMatch' : 'employees.bole.noRecruitments') }}</p>
      </section>
    </div>
  </div>
</template>

<style scoped src="./BolePeoplePanel.css" />
