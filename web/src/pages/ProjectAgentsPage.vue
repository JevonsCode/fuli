<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { deleteJson, getJson, patchJson, postJson } from '@/api/client'
import { activityRange, normalizeActivity } from '@/features/project-agents/activity-evidence'
import ProjectScopePicker from '@/features/employees/ProjectScopePicker.vue'
import AgentAssignmentDialog from '@/features/project-agents/AgentAssignmentDialog.vue'
import ExecutorRoutingDialog from '@/features/project-agents/ExecutorRoutingDialog.vue'
import ProjectAgentAutomationPolicyPanel from '@/features/project-agents/ProjectAgentAutomationPolicyPanel.vue'
import ProjectAgentDetailState from '@/features/project-agents/ProjectAgentDetailState.vue'
import {
  agentValues,
  arrayOf,
  eventExecution,
  normalizeAssignment,
  normalizePolicy,
  normalizeStrategy,
  normalizeTask,
  parallelPlanHasEvidence,
  stringOf,
  unknownRecord,
  valueOf,
  workerEventEvidence,
} from '@/features/project-agents/task-evidence'
import ProjectAgentDialog from '@/features/projects/ProjectAgentDialog.vue'
import EmployeeRecruitDialog from '@/features/employees/EmployeeRecruitDialog.vue'
import { employeeTemplates, employeeTemplateIdForAgent, refreshEmployeeCatalog, type EmployeeRecruitmentResult } from '@/features/employees/catalog'
import { currentLocale, t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import type {
  ConversationSourceApplication,
  PersonalProject,
  ProjectAgentActivityDay,
  ProjectAgentActivityResult,
  ProjectAgentActualExecution,
  ProjectAgentAssignmentRecord,
  ProjectAgentClientEvidence,
  ProjectAgentExecutorRef,
  ProjectAgentExecutorPolicy,
  ProjectAgentLearningEvidence,
  ProjectAgentModelStrategy,
  ProjectAgentRecruitmentRecord,
  ProjectAgentRecord,
  ProjectAgentRoutingRule,
  ProjectAgentRoutingDecision,
  ProjectAgentStatus,
  ProjectAgentTaskEvent,
  ProjectAgentTaskExecutionSummary,
  ProjectAgentTaskRecord,
  ProjectAgentTaskStatus,
  ProjectAgentTokenUsage,
  ProjectAgentType,
  ProjectAgentWorkStatus,
} from '@/types'
type StatusFilter = ProjectAgentStatus | 'all'
type UnknownRecord = Record<string, unknown>
const detailSources = [
  'assignments', 'tasks', 'activity', 'recruitments',
  'executors', 'routingRules', 'learning',
] as const
type DetailSource = typeof detailSources[number]
type DetailSourceStatus = 'idle' | 'loading' | 'ready' | 'error'
interface DetailSourceState { status: DetailSourceStatus; error: string }
const store = useConsoleStore()
const agents = ref<ProjectAgentRecord[]>([])
const loading = ref(false)
const error = ref('')
// null is the unrestricted view, including employees not assigned to a project yet.
const projectFilter = ref<string[] | null>(null)
const statusFilter = ref<StatusFilter>('all')
const search = ref('')
const selectedAgentKey = ref('')
const dialogOpen = ref(false)
const recruitDialogOpen = ref(false)
const recruitTemplateId = ref('')
const editingAgent = ref<ProjectAgentRecord | null>(null)
const assignmentDialogOpen = ref(false)
const assignmentAction = ref<'assign' | 'end' | 'replace'>('assign')
const assignmentTarget = ref<ProjectAgentAssignmentRecord | null>(null)
const detailLoading = ref(false)
const detailStates = ref<Record<string, Record<DetailSource, DetailSourceState>>>({})
const detailNotice = ref('')
const activityDay = ref('')
const learningBusy = ref('')
const recruitmentBusy = ref('')
const executorBusy = ref('')
const executorDialogOpen = ref(false)
const executorDialogMode = ref<'executor' | 'rule'>('executor')
const editingExecutor = ref<ProjectAgentExecutorRef | null>(null)
const editingRule = ref<ProjectAgentRoutingRule | null>(null)
let loadVersion = 0
let detailLoadVersion = 0
const nonTerminalTaskStatuses = new Set<ProjectAgentTaskStatus>([
  'awaiting_recruitment', 'queued', 'running', 'paused', 'awaiting_review', 'blocked',
])
function actionIdempotencyKey(prefix: string) {
  const suffix = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `${prefix}:${suffix}`
}
const projects = computed(() => store.state?.personalProjects ?? [])
async function employeeRecruited(result: EmployeeRecruitmentResult) {
  await loadAgents()
  if (!filteredAgents.value.some((agent) => agent.agentId === result.agent.agentId)) {
    projectFilter.value = null
    statusFilter.value = 'all'
    search.value = ''
  }
  const wasSelected = selectedAgentKey.value === result.agent.agentId
  selectedAgentKey.value = result.agent.agentId
  if (wasSelected) void refreshDetails()
}
const activeSpaceId = computed(() => store.activePersonalSpace?.id ?? '')
const projectById = computed(() => new Map(
  projects.value.map((project) => [project.project_id, project]),
))
const projectOptions = computed(() => projects.value.map((project) => ({ id: project.project_id, name: project.profile.name })))
const filterProjectIds = computed({
  get: () => projectFilter.value ?? projectOptions.value.map((project) => project.id),
  set: (ids: string[]) => {
    const selected = projectOptions.value.filter((project) => ids.includes(project.id)).map((project) => project.id)
    projectFilter.value = selected.length === projectOptions.value.length ? null : selected
  },
})
const singleFilterProjectId = computed(() => projectFilter.value?.length === 1 ? projectFilter.value[0]! : '')
const statusOptions = computed<Array<{ value: StatusFilter; label: string }>>(() => [
  { value: 'all', label: t('projectAgents.status.all') },
  { value: 'active', label: t('projectAgents.status.active') },
  { value: 'inactive', label: t('projectAgents.status.inactive') },
  { value: 'archived', label: t('projectAgents.status.archived') },
])
const filteredAgents = computed(() => {
  const needle = search.value.trim().toLocaleLowerCase(currentLocale())
  return agents.value
    .filter((agent) => projectFilter.value === null
      || responsibleProjectsFor(agent).some(({ id }) => projectFilter.value!.includes(id)))
    .filter((agent) => statusFilter.value === 'all' || agent.profile.status === statusFilter.value)
    .filter((agent) => !needle || searchText(agent).toLocaleLowerCase(currentLocale()).includes(needle))
    .sort(compareAgents)
})
const selectedAgent = computed(() => filteredAgents.value.find(
  (agent) => agent.agentId === selectedAgentKey.value,
) ?? null)
const selectedEmployeeId = computed(() => selectedAgent.value ? employeeTemplateIdForAgent(selectedAgent.value) : null)
const selectedEmployee = computed(() => employeeTemplates.value.find(entry => entry.id === selectedEmployeeId.value))
const employeeProjects = computed(() => selectedAgent.value ? responsibleProjectsFor(selectedAgent.value)
  .filter((project) => projectById.value.get(project.id)?.profile.lifecycle !== 'archived') : [])
const activeCount = computed(() => agents.value.filter(({ profile }) => profile.status === 'active').length)
const assignmentCount = computed(() => agents.value.reduce(
  (count, agent) => count + currentAssignmentsFor(agent).length,
  0,
))
const representedProjectCount = computed(() => new Set(
  agents.value.flatMap((agent) => currentAssignmentsFor(agent).map(({ personalProjectId }) => personalProjectId)),
).size)
const dialogDefaultProjectId = computed(() => {
  if (singleFilterProjectId.value) return singleFilterProjectId.value
  return selectedAgent.value?.assignments?.find(({ status }) => status === 'active')?.personalProjectId
    ?? selectedAgent.value?.personalProjectId
    ?? projects.value[0]?.project_id
    ?? null
})
const selectedActivity = computed(() => selectedAgent.value?.activity ?? null)
const selectedActivityDay = computed(() => selectedActivity.value?.days.find(
  ({ date }) => date === activityDay.value,
) ?? null)
const selectedLearning = computed(() => Object.entries(selectedAgent.value?.learningEvidence ?? {}))
const selectedRecruitments = computed(() => selectedAgent.value?.recruitments ?? [])
onMounted(() => {
  if (store.runtimeStatus === 'idle') void store.refresh()
})
watch(activeSpaceId, (spaceId) => {
  ++detailLoadVersion
  detailStates.value = {}
  selectedAgentKey.value = ''
  agents.value = []
  projectFilter.value = null
  if (spaceId) void loadAgents(spaceId)
  else if (store.runtimeStatus !== 'loading') loading.value = false
}, { immediate: true })
watch(filteredAgents, (items) => {
  if (!items.some((agent) => agent.agentId === selectedAgentKey.value)) {
    selectedAgentKey.value = items[0]?.agentId ?? ''
  }
  if (!items.some((agent) => agent.activity?.days.some(({ date }) => date === activityDay.value))) {
    activityDay.value = ''
  }
}, { immediate: true })
watch([selectedAgentKey, activeSpaceId], ([agentId, spaceId]) => {
  activityDay.value = ''
  if (agentId && spaceId) void refreshDetails(agentId, spaceId)
}, { immediate: true })
async function loadAgents(spaceId = activeSpaceId.value) {
  if (!spaceId) return
  const version = ++loadVersion
  loading.value = true
  error.value = ''
  try {
    const query = new URLSearchParams({ personalSpaceId: spaceId })
    const [agentsResult, tasksResult] = await Promise.allSettled([
      getJson<unknown>(`/api/project-agents?${query}`),
      // The list endpoint is intentionally space-wide: a task can have more
      // than one participant, so filtering only by the selected Agent would
      // hide collaboration from the directory row.
      getJson<unknown>(`/api/project-agent-tasks?${query}`),
    ])
    void refreshEmployeeCatalog(spaceId)
    if (agentsResult.status === 'rejected') throw agentsResult.reason
    if (version === loadVersion) {
      const listed = mergeAgents(agentValues(agentsResult.value))
      const tasks = tasksResult.status === 'fulfilled'
        ? taskValues(tasksResult.value).filter((task) => nonTerminalTaskStatuses.has(task.status))
        : []
      agents.value = attachTasks(listed, tasks)
    }
  } catch (cause) {
    if (version === loadVersion) error.value = cause instanceof Error ? cause.message : t('projectAgents.loadError')
  } finally {
    if (version === loadVersion) loading.value = false
  }
}
async function refreshDetails(agentId = selectedAgentKey.value, spaceId = activeSpaceId.value) {
  const agent = agents.value.find((item) => item.agentId === agentId)
  if (!agent || !spaceId) return
  const version = ++detailLoadVersion
  detailLoading.value = true
  detailNotice.value = ''
  setAllDetailStates(agentId, 'loading')
  const query = new URLSearchParams({ personalSpaceId: spaceId, agentId })
  const range = activityRange()
  const activityQuery = new URLSearchParams({
    personalSpaceId: spaceId,
    agentId,
    fromDate: range.fromDate,
    toDate: range.toDate,
  })
  const requests: Record<DetailSource, Promise<unknown>> = {
    assignments: getJson<unknown>(`/api/project-agent-assignments?${query}`),
    tasks: getJson<unknown>(`/api/project-agent-tasks?${query}`),
    activity: getJson<unknown>(`/api/project-agent-activity?${activityQuery}`),
    recruitments: getJson<unknown>(`/api/project-agent-recruitments?personalSpaceId=${encodeURIComponent(spaceId)}`),
    executors: getJson<unknown>(`/api/executors?personalSpaceId=${encodeURIComponent(spaceId)}`),
    routingRules: getJson<unknown>(`/api/executor-routing-rules?personalSpaceId=${encodeURIComponent(spaceId)}`),
    learning: getJson<unknown>(`/api/project-agent-routing-learning?${query}`),
  }
  await Promise.all(detailSources.map(async (source) => {
    try {
      const value = await requests[source]
      if (!detailRequestIsCurrent(version, agentId, spaceId)) return
      applyDetailResult(agent, source, value)
      setDetailState(agentId, source, { status: 'ready', error: '' })
    } catch (cause) {
      if (!detailRequestIsCurrent(version, agentId, spaceId)) return
      setDetailState(agentId, source, {
        status: 'error',
        error: cause instanceof Error ? cause.message : t('projectAgents.detail.sectionUnavailable'),
      })
    }
  }))
  if (detailRequestIsCurrent(version, agentId, spaceId)) detailLoading.value = false
}
function emptyDetailStates(status: DetailSourceStatus = 'idle'): Record<DetailSource, DetailSourceState> {
  return Object.fromEntries(detailSources.map((source) => [source, { status, error: '' }])) as Record<DetailSource, DetailSourceState>
}
function setAllDetailStates(agentId: string, status: DetailSourceStatus) {
  detailStates.value = { ...detailStates.value, [agentId]: emptyDetailStates(status) }
}
function setDetailState(agentId: string, source: DetailSource, state: DetailSourceState) {
  detailStates.value = {
    ...detailStates.value,
    [agentId]: { ...(detailStates.value[agentId] ?? emptyDetailStates()), [source]: state },
  }
}
function detailState(source: DetailSource | DetailSource[]): DetailSourceState {
  const sources = Array.isArray(source) ? source : [source]
  const states = sources.map((item) => detailStates.value[selectedAgentKey.value]?.[item] ?? { status: 'idle' as const, error: '' })
  return states.find(({ status }) => status === 'error')
    ?? states.find(({ status }) => status === 'loading')
    ?? states.find(({ status }) => status === 'idle')
    ?? { status: 'ready', error: '' }
}
function detailRequestIsCurrent(version: number, agentId: string, spaceId: string) {
  return version === detailLoadVersion
    && agentId === selectedAgentKey.value
    && spaceId === activeSpaceId.value
}
function applyDetailResult(agent: ProjectAgentRecord, source: DetailSource, value: unknown) {
  let patch: Partial<ProjectAgentRecord>
  switch (source) {
    case 'assignments':
      assertReportedCollection(value, ['assignments', 'items'])
      patch = { assignments: assignmentValues(value, agent) }
      break
    case 'tasks':
      assertReportedCollection(value, ['tasks', 'items'])
      patch = { tasks: taskValues(value) }
      break
    case 'activity': {
      const activity = normalizeActivity(value, {
        agentId: selectedAgentKey.value, personalSpaceId: activeSpaceId.value,
      })
      if (!activity) throw new Error(t('projectAgents.detail.sectionUnavailable'))
      patch = { activity }
      break
    }
    case 'recruitments':
      assertReportedCollection(value, ['recruitments', 'items'])
      patch = { recruitments: recruitmentValues(value).filter((item) => recruitmentBelongsTo(item, agent)) }
      break
    case 'executors':
      assertReportedCollection(value, ['executors', 'items'])
      patch = { executorDirectory: executorValues(value), clientEvidence: clientValues(value) }
      break
    case 'routingRules':
      assertReportedCollection(value, ['rules', 'items'])
      patch = { routingRules: routingValues(value) }
      break
    case 'learning':
      assertReportedCollection(value, ['learningEvidence', 'learning_evidence', 'items'], true)
      patch = { learningEvidence: learningValues(value) }
      break
  }
  agents.value = agents.value.map((item) => item.agentId === agent.agentId ? { ...item, ...patch } : item)
}

function assertReportedCollection(value: unknown, keys: string[], allowRecord = false) {
  if (Array.isArray(value)) return
  const record = unknownRecord(value)
  const reported = keys.some((key) => Array.isArray(record[key]) || (allowRecord && isPlainRecord(record[key])))
  if (!reported) throw new Error(t('projectAgents.detail.sectionUnavailable'))
}

function isPlainRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function updateLearning(
  evidence: ProjectAgentLearningEvidence,
  action: 'ignore' | 'reset',
  contributionEvidenceId?: string,
) {
  const evidenceId = action === 'ignore'
    ? contributionEvidenceId
    : evidence.learningKey ?? evidence.modelStrategyKey
  const agent = selectedAgent.value
  if (!evidenceId || !agent || !activeSpaceId.value || learningBusy.value) return
  if (action === 'reset' && (!evidence.personalProjectId || !evidence.workKind || !evidence.executor)) {
    detailNotice.value = t('projectAgents.learning.resetUnavailable')
    return
  }
  learningBusy.value = evidenceId
  try {
    await patchJson(`/api/project-agent-learning/${encodeURIComponent(evidenceId)}`, {
      action,
      personalSpaceId: activeSpaceId.value,
      personalProjectId: evidence.personalProjectId,
      agentId: agent.agentId,
      workKind: evidence.workKind,
      executorId: evidence.executor,
      modelStrategy: evidence.modelStrategy,
      modelStrategyKey: evidence.modelStrategyKey,
      resetAt: action === 'reset' ? new Date().toISOString() : undefined,
      idempotencyKey: action === 'ignore'
        ? `console-learning:${evidenceId}:ignore`
        : actionIdempotencyKey(`console-learning:${evidenceId}:reset`),
      reason: `Console requested ${action} for explicit evidence`,
    })
    await refreshDetails()
  } catch (cause) {
    detailNotice.value = cause instanceof Error ? cause.message : t('projectAgents.learning.updateFailed')
  } finally {
    learningBusy.value = ''
  }
}

async function decideRecruitment(recruitment: ProjectAgentRecruitmentRecord, decision: 'approve' | 'cancel') {
  if (!activeSpaceId.value || recruitmentBusy.value) return
  recruitmentBusy.value = recruitment.recruitmentId
  try {
    await postJson('/api/project-agent-recruitments/decision', {
      personalSpaceId: activeSpaceId.value,
      personalProjectId: recruitment.personalProjectId,
      recruitmentId: recruitment.recruitmentId,
      expectedRevision: recruitment.revision ?? 0,
      decision,
      reason: t(`projectAgents.recruitment.${decision}Reason`),
    })
    await refreshDetails()
  } catch (cause) {
    detailNotice.value = cause instanceof Error ? cause.message : t('projectAgents.recruitment.decisionFailed')
  } finally {
    recruitmentBusy.value = ''
  }
}

async function authorizeExecutor(executor: ProjectAgentExecutorRef, status: 'authorized' | 'revoked') {
  if (!activeSpaceId.value || executorBusy.value) return
  executorBusy.value = executor.executorId
  try {
    await postJson('/api/executors/authorization', {
      personalSpaceId: activeSpaceId.value,
      executorId: executor.executorId,
      status,
      expectedRevision: executor.permissionRevision ?? 0,
      idempotencyKey: actionIdempotencyKey(`console-executor:${executor.executorId}:${status}`),
      reason: t(`projectAgents.routing.${status === 'authorized' ? 'authorizeReason' : 'revokeReason'}`),
    })
    await refreshDetails()
  } catch (cause) {
    detailNotice.value = cause instanceof Error ? cause.message : t('projectAgents.routing.authorizationFailed')
  } finally {
    executorBusy.value = ''
  }
}

function openExecutorDialog(executor: ProjectAgentExecutorRef | null = null) {
  executorDialogMode.value = 'executor'
  editingExecutor.value = executor
  editingRule.value = null
  executorDialogOpen.value = true
}
function openRuleDialog(rule: ProjectAgentRoutingRule | null = null) {
  executorDialogMode.value = 'rule'
  editingRule.value = rule
  editingExecutor.value = null
  executorDialogOpen.value = true
}
function closeExecutorDialog() {
  executorDialogOpen.value = false
  editingExecutor.value = null
  editingRule.value = null
}
function executorSaved(executor: ProjectAgentExecutorRef) {
  if (!selectedAgent.value) return
  agents.value = agents.value.map((item) => item.agentId === selectedAgent.value?.agentId
    ? { ...item, executorDirectory: dedupeById([...(item.executorDirectory ?? []), executor], ({ executorId }) => executorId) }
    : item)
  closeExecutorDialog()
}
function ruleSaved(rule: ProjectAgentRoutingRule) {
  if (!selectedAgent.value) return
  agents.value = agents.value.map((item) => item.agentId === selectedAgent.value?.agentId
    ? { ...item, routingRules: dedupeById([...(item.routingRules ?? []), rule], ({ ruleId }) => ruleId) }
    : item)
  closeExecutorDialog()
}
function executorDialogSaved(value: ProjectAgentExecutorRef | ProjectAgentRoutingRule) {
  if (executorDialogMode.value === 'executor') executorSaved(value as ProjectAgentExecutorRef)
  else ruleSaved(value as ProjectAgentRoutingRule)
}
async function disableRule(rule: ProjectAgentRoutingRule) {
  if (!activeSpaceId.value || !rule.ruleId || recruitmentBusy.value) return
  recruitmentBusy.value = `rule:${rule.ruleId}`
  try {
    await patchJson(`/api/executor-routing-rules/${encodeURIComponent(rule.ruleId)}`, {
      personalSpaceId: activeSpaceId.value,
      ruleId: rule.ruleId,
      expectedRevision: rule.revision ?? 0,
      status: 'disabled',
      idempotencyKey: `console-rule:${rule.ruleId}:disable`,
      reason: 'Console disabled explicit routing rule',
    })
    await refreshDetails()
  } catch (cause) {
    detailNotice.value = cause instanceof Error ? cause.message : t('projectAgents.routing.updateFailed')
  } finally {
    recruitmentBusy.value = ''
  }
}

async function cleanupTestAgent(agent: ProjectAgentRecord) {
  if (!agent.profile.cleanupEligible) return
  detailLoading.value = true
  try {
    await deleteJson(`/api/project-agents/${encodeURIComponent(agent.agentId)}?personalSpaceId=${encodeURIComponent(agent.personalSpaceId)}&reason=${encodeURIComponent('archived test role')}`)
    await loadAgents()
  } catch (cause) {
    detailNotice.value = cause instanceof Error ? cause.message : t('projectAgents.source.cleanupFailed')
  } finally {
    detailLoading.value = false
  }
}

function compareAgents(left: ProjectAgentRecord, right: ProjectAgentRecord) {
  const statusOrder: Record<ProjectAgentStatus, number> = { active: 0, inactive: 1, archived: 2 }
  return statusOrder[left.profile.status] - statusOrder[right.profile.status]
    || left.profile.name.localeCompare(right.profile.name, currentLocale())
    || left.agentId.localeCompare(right.agentId, currentLocale())
}

function projectName(projectId: string | null | undefined) {
  if (!projectId) return t('projectAgents.notReported')
  return projectById.value.get(projectId)?.profile.name ?? projectId
}

function assignmentsFor(agent: ProjectAgentRecord) {
  return agent.assignments ?? (agent.personalProjectId ? [legacyAssignment(agent)] : [])
}

function currentAssignmentsFor(agent: ProjectAgentRecord) {
  return [...new Map(assignmentsFor(agent).filter((assignment) => assignment.status === 'active')
    .map((assignment) => [assignment.personalProjectId, assignment])).values()]
}

function responsibleProjectsFor(agent: ProjectAgentRecord) {
  const templateId = employeeTemplateIdForAgent(agent)
  const employee = templateId ? employeeTemplates.value.find(entry => entry.id === templateId) : undefined
  // Effective policy membership is not a fabricated Provider assignment or history row.
  return employee?.managedProjects ?? currentAssignmentsFor(agent).map(assignment => ({
    id: assignment.personalProjectId, name: projectName(assignment.personalProjectId),
  }))
}

function legacyAssignment(agent: ProjectAgentRecord): ProjectAgentAssignmentRecord {
  return {
    assignmentId: `legacy:${agent.agentId}:${agent.personalProjectId}`,
    personalSpaceId: agent.personalSpaceId,
    personalProjectId: agent.personalProjectId ?? '',
    agentId: agent.agentId,
    responsibility: agent.profile.responsibility,
    capabilities: agent.profile.capabilities,
    status: agent.profile.status === 'active' ? 'active' : 'ended',
    assignedAt: agent.createdAt,
    updatedAt: agent.updatedAt,
    reason: null,
  }
}

function searchText(agent: ProjectAgentRecord) {
  return [
    agent.agentId, agent.profile.name, agent.profile.occupationEmoji ?? '', agent.profile.responsibility,
    ...(agent.profile.capabilities ?? []), ...(agent.profile.workKinds ?? []),
    ...assignmentsFor(agent).flatMap((item) => [item.personalProjectId, item.responsibility, item.scope ?? '', ...(item.workKinds ?? [])]),
    ...(agent.tasks ?? []).flatMap((task) => [task.taskId, task.title, task.workKind ?? '']),
  ].join(' ')
}

function openCreate() { editingAgent.value = null; dialogOpen.value = true }
function openRecruit(templateId = '') { recruitTemplateId.value = templateId; recruitDialogOpen.value = true }
function openEdit(agent: ProjectAgentRecord) { editingAgent.value = agent; dialogOpen.value = true }
function closeDialog() { dialogOpen.value = false; editingAgent.value = null }

function openAssignment(agent: ProjectAgentRecord, assignment: ProjectAgentAssignmentRecord | null = null, action: 'assign' | 'end' | 'replace' = 'assign') {
  const templateId = employeeTemplateIdForAgent(agent)
  if (action === 'assign' && templateId) { openRecruit(templateId); return }
  editingAgent.value = agent
  assignmentTarget.value = assignment
  assignmentAction.value = action
  assignmentDialogOpen.value = true
}
function closeAssignment() { assignmentDialogOpen.value = false; assignmentTarget.value = null; assignmentAction.value = 'assign' }
function assignmentSaved(assignment: ProjectAgentAssignmentRecord) {
  if (!editingAgent.value) return
  agents.value = agents.value.map((agent) => agent.agentId !== editingAgent.value?.agentId ? agent : {
    ...agent,
    assignments: dedupeById([...(agent.assignments ?? []), assignment], ({ assignmentId }) => assignmentId),
  })
  selectedAgentKey.value = editingAgent.value.agentId
  closeAssignment()
}
function assignmentChanged() { closeAssignment(); void refreshDetails() }

function recordSaved(agent: ProjectAgentRecord) {
  const saved = normalizeAgent(agent)
  const next = agents.value.filter((item) => !(item.agentId === saved.agentId
    && saved.personalProjectId && item.personalProjectId === saved.personalProjectId))
  agents.value = mergeAgents([...next, saved])
  if (saved.personalProjectId) projectFilter.value = [saved.personalProjectId]
  statusFilter.value = 'all'; search.value = ''; selectedAgentKey.value = saved.agentId
  store.notify(t('projectAgents.saved'))
}

function formatDate(value: string | null | undefined) {
  if (!value) return t('projectAgents.notReported')
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return t('projectAgents.notReported')
  return new Intl.DateTimeFormat(currentLocale(), { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date)
}

function formatDateOnly(value: string | null | undefined) {
  if (!value) return t('projectAgents.notReported')
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat(currentLocale(), { month: 'short', day: 'numeric' }).format(date)
}

function strategyLabel(strategy: ProjectAgentModelStrategy | null | undefined) {
  return strategy?.mode ?? 'adaptive'
}
function policyLabel(policy: ProjectAgentExecutorPolicy | null | undefined) {
  return policy?.mode ?? 'flexible'
}
function policyIsLocked(policy: ProjectAgentExecutorPolicy | null | undefined) {
  return policy?.mode === 'locked'
}
function policyAllowList(policy: ProjectAgentExecutorPolicy | null | undefined): ProjectAgentExecutorRef[] {
  if (!policy) return [] as ProjectAgentExecutorRef[]
  if (policy.allowList?.length) return policy.allowList
  const ids = policy.mode === 'locked' ? policy.lockedExecutorIds : policy.preferredExecutorIds
  return (ids ?? []).map((executorId) => ({ executorId }) satisfies ProjectAgentExecutorRef)
}

function actualExecution(task: ProjectAgentTaskRecord): ProjectAgentActualExecution | null {
  if (task.actualExecution) return task.actualExecution
  const event = [...(task.events ?? [])].reverse().find((item) => item.actualExecution)
  return event ? eventExecution(event) : null
}
function workerEventLabel(event: ProjectAgentTaskEvent) {
  if (event.workerLabel && event.workerId && event.workerLabel !== event.workerId) {
    return `${event.workerLabel} · ${event.workerId}`
  }
  return event.workerLabel || event.workerId || t('projectAgents.notReported')
}
function workerEventOccupationEmoji(event: ProjectAgentTaskEvent) {
  return event.workerOccupationEmoji || ''
}
function workerEventStatusLabel(event: ProjectAgentTaskEvent) {
  return executionSummaryStatusLabel(event.workerStatus || event.status)
}
function executionSummaryWorkerLabel(summary: ProjectAgentTaskExecutionSummary) {
  return summary.workerLabel || summary.agentName || summary.workerId || summary.agentId || t('projectAgents.notReported')
}
function executionSummaryOccupationEmoji(summary: ProjectAgentTaskExecutionSummary) {
  return summary.workerOccupationEmoji || summary.occupationEmoji || ''
}
function executionSummaryStatusLabel(status: string | null | undefined) {
  return status ? taskStatusLabel(status) : t('projectAgents.notReported')
}
function participantRoleLabel(role: string | null | undefined) {
  if (!role) return t('projectAgents.notReported')
  const key = `projectAgents.participantRoles.${role}`
  const translated = t(key)
  return translated === key ? role : translated
}
function tokenUsageSourceLabel(source: ProjectAgentTokenUsage['source']) {
  return t(`projectAgents.tokenSources.${source}`)
}
function tokenUsageLabel(usage: ProjectAgentTokenUsage | null | undefined) {
  if (!usage) return t('projectAgents.notReported')
  return `${new Intl.NumberFormat(currentLocale()).format(usage.totalTokens)} Token · ${tokenUsageSourceLabel(usage.source)}`
}
function executionSummarySessionHref(summary: ProjectAgentTaskExecutionSummary) {
  return sessionHref(summary.workerRuntime
    ? summary.workerRuntime.sessionUrl
    : summary.sourceSessionUrl)
}
function sessionHref(raw: string | null | undefined) {
  const value = raw?.trim()
  if (!value) return null
  try {
    const url = new URL(value)
    if (url.username || url.password || url.search || url.hash) return null
    if (url.protocol === 'https:') return value
    if (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return value
    if (url.protocol === 'codex:' && url.hostname === 'threads' && url.pathname !== '/') return value
  } catch {
    return null
  }
  return null
}
function executionSummarySessionId(summary: ProjectAgentTaskExecutionSummary) {
  return summary.workerRuntime
    ? summary.workerRuntime.sessionId
    : summary.sourceSessionId
}
function currentWork(agent: ProjectAgentRecord) {
  return (agent.tasks ?? []).find((task) => nonTerminalTaskStatuses.has(task.status)) ?? null
}
function taskStatusLabel(status: ProjectAgentTaskStatus | ProjectAgentWorkStatus | string) {
  const key = `projectAgents.taskStatus.${status}`
  const translated = t(key)
  return translated === key ? status : translated
}
function agentTypeLabel(type: ProjectAgentType | undefined) { return t(`projectAgents.agentType.${type ?? 'durable'}`) }
function sourceLabel(source: ConversationSourceApplication | null | undefined) { return source ? t(`projectAgents.clients.${source}`) : t('projectAgents.notReported') }
function clientNames(agent: ProjectAgentRecord) {
  return unique([
    ...(agent.profile.allowedClients ?? []),
    ...(agent.observedClients ?? []),
    ...(agent.clientEvidence ?? []).map(({ client }) => client),
  ]) as ConversationSourceApplication[]
}
function clientEvidenceFor(agent: ProjectAgentRecord, client: ConversationSourceApplication) {
  return agent.clientEvidence?.find((item) => item.client === client)
}
function clientUseCount(agent: ProjectAgentRecord, client: ConversationSourceApplication) {
  return clientEvidenceFor(agent, client)?.actualUse?.count ?? 0
}
function learningIsNeutral(evidence: ProjectAgentLearningEvidence) { return evidence.neutral !== false || evidence.sampleCount <= 0 }
function learningLabel(evidence: ProjectAgentLearningEvidence) { return learningIsNeutral(evidence) ? t('projectAgents.learning.neutral') : t('projectAgents.learning.recorded') }
function learningRecent(evidence: ProjectAgentLearningEvidence) { return evidence.recentWeightedSamples ?? t('projectAgents.notReported') }
function scoreValue(evidence: ProjectAgentLearningEvidence) { return evidence.score ?? '' }
function activityIntensity(day: ProjectAgentActivityDay, activity: ProjectAgentActivityResult) {
  const maximum = Math.max(...activity.days.map(({ total }) => total), 0)
  return !maximum || !day.total ? 0 : Math.min(4, Math.ceil((day.total / maximum) * 4))
}
function chooseActivityDay(day: ProjectAgentActivityDay) { activityDay.value = day.date }
function taskBelongsTo(agent: ProjectAgentRecord, task: ProjectAgentTaskRecord) {
  return task.ownerAgentId === agent.agentId
    || task.leadAgentId === agent.agentId
    || task.coordinatorAgentId === agent.agentId
    || task.participants.some((participant) => participant.agentId === agent.agentId)
}
function attachTasks(items: ProjectAgentRecord[], tasks: ProjectAgentTaskRecord[]) {
  return items.map((agent) => {
    const matching = tasks.filter((task) => taskBelongsTo(agent, task))
    return matching.length ? { ...agent, tasks: dedupeById([...(agent.tasks ?? []), ...matching], ({ taskId }) => taskId) } : agent
  })
}

function normalizeAgent(value: unknown): ProjectAgentRecord {
  const record = unknownRecord(value); const rawProfile = unknownRecord(record.profile); const agentId = stringOf(record, 'agentId', 'agent_id') ?? ''
  const createdAt = stringOf(record, 'createdAt', 'created_at') ?? ''; const updatedAt = stringOf(record, 'updatedAt', 'updated_at') ?? createdAt
  const profile = {
    name: stringOf(rawProfile, 'name', 'name') ?? agentId, responsibility: stringOf(rawProfile, 'responsibility', 'responsibility') ?? '',
    capabilities: arrayOf(rawProfile.capabilities).filter((item): item is string => typeof item === 'string'), initialPreferences: arrayOf(valueOf(rawProfile, 'initialPreferences', 'initial_preferences')).filter((item): item is string => typeof item === 'string'),
    status: (stringOf(rawProfile, 'status', 'status') ?? 'active') as ProjectAgentStatus, occupationEmoji: stringOf(rawProfile, 'occupationEmoji', 'occupation_emoji'), agentType: stringOf(rawProfile, 'agentType', 'agent_type') as ProjectAgentType | undefined,
    workKinds: arrayOf(valueOf(rawProfile, 'workKinds', 'work_kinds')).filter((item): item is string => typeof item === 'string'), defaultModelStrategy: normalizeStrategy(valueOf(rawProfile, 'defaultModelStrategy', 'default_model_strategy')), executorPolicy: normalizePolicy(valueOf(rawProfile, 'executorPolicy', 'executor_policy')),
    allowedClients: arrayOf(valueOf(rawProfile, 'allowedClients', 'allowed_clients')).filter((item): item is ConversationSourceApplication => typeof item === 'string'),
    testSource: stringOf(rawProfile, 'testSource', 'test_source'), cleanupEligible: valueOf(rawProfile, 'cleanupEligible', 'cleanup_eligible') === true,
  }
  const fallback: ProjectAgentRecord = { agentId, personalSpaceId: stringOf(record, 'personalSpaceId', 'personal_space_id') ?? activeSpaceId.value, personalProjectId: stringOf(record, 'personalProjectId', 'personal_project_id'), profile, createdAt, updatedAt }
  return {
    ...fallback, memoryScope: stringOf(record, 'memoryScope', 'memory_scope') ?? undefined,
    assignments: Array.isArray(record.assignments)
      ? record.assignments.map((item) => normalizeAssignment(item, fallback)).filter(Boolean) as ProjectAgentAssignmentRecord[] : undefined,
    recruitments: recruitmentValues(record.recruitments ?? record.recruitmentHistory).filter((item) => recruitmentBelongsTo(item, fallback)),
    recruitmentId: stringOf(record, 'recruitmentId', 'recruitment_id'), temporaryTaskId: stringOf(record, 'temporaryTaskId', 'temporary_task_id'), workStatus: stringOf(record, 'workStatus', 'work_status') as ProjectAgentWorkStatus | undefined,
    openTaskCount: typeof record.openTaskCount === 'number' ? record.openTaskCount : typeof record.open_task_count === 'number' ? record.open_task_count : undefined, currentTaskId: stringOf(record, 'currentTaskId', 'current_task_id'),
    observedClients: arrayOf(record.observedClients ?? record.observed_clients).filter((item): item is ConversationSourceApplication => typeof item === 'string'), recruitedAt: stringOf(record, 'recruitedAt', 'recruited_at'),
    recruitmentReason: stringOf(record, 'recruitmentReason', 'recruitment_reason'), recruitmentSourceApplication: stringOf(record, 'recruitmentSourceApplication', 'recruitment_source_application') as ConversationSourceApplication | null,
    isTestRole: Boolean(profile.testSource) || profile.cleanupEligible || record.isTestRole === true || record.is_test_role === true,
    tasks: arrayOf(record.tasks ?? record.taskHistory).map(normalizeTask).filter(Boolean) as ProjectAgentTaskRecord[],
    activity: normalizeActivity(record.activity, { agentId: selectedAgentKey.value, personalSpaceId: activeSpaceId.value }),
    clientEvidence: clientValues(record.clientEvidence ?? record.client_evidence), routingRules: routingValues(record.routingRules ?? record.routing_rules), learningEvidence: normalizeLearningMap(record.learningEvidence ?? record.learning_evidence),
  }
}

function normalizeClient(value: unknown): ProjectAgentClientEvidence | null {
  const record = unknownRecord(value); const client = stringOf(record, 'client', 'client'); if (!client) return null; const actual = unknownRecord(valueOf(record, 'actualUse', 'actual_use'))
  return { client: client as ConversationSourceApplication, allowed: record.allowed === true, integrationStatus: stringOf(record, 'integrationStatus', 'integration_status') ?? undefined, actualUse: Object.keys(actual).length ? { count: typeof actual.count === 'number' ? actual.count : 0, lastUsedAt: stringOf(actual, 'lastUsedAt', 'last_used_at') } : null }
}
function assignmentValues(value: unknown, fallback: ProjectAgentRecord) {
  const record = unknownRecord(value)
  return arrayOf(Array.isArray(value) ? value : record.assignments ?? record.items)
    .map((item) => normalizeAssignment(item, fallback))
    .filter((item): item is ProjectAgentAssignmentRecord => Boolean(item))
}
function normalizeExecutorModel(value: unknown) {
  const record = unknownRecord(value)
  const provider = stringOf(record, 'provider', 'provider')
  const model = stringOf(record, 'model', 'model')
  if (!provider || !model) return null
  return {
    provider,
    model,
    capabilities: arrayOf(record.capabilities).filter((item): item is string => typeof item === 'string'),
    available: typeof record.available === 'boolean' ? record.available : undefined,
    strategyModes: arrayOf(valueOf(record, 'strategyModes', 'strategy_modes')).filter((item): item is string => typeof item === 'string'),
    reasoningEfforts: arrayOf(valueOf(record, 'reasoningEfforts', 'reasoning_efforts')).filter((item): item is string => typeof item === 'string'),
    observedAt: stringOf(record, 'observedAt', 'observed_at'),
    unavailableReason: stringOf(record, 'unavailableReason', 'unavailable_reason'),
  }
}
function executorValues(value: unknown): ProjectAgentExecutorRef[] {
  const record = unknownRecord(value)
  const values: Array<ProjectAgentExecutorRef | null> = arrayOf(Array.isArray(value) ? value : record.executors ?? record.items).map((item) => {
    const executor = unknownRecord(item)
    const executorId = stringOf(executor, 'executorId', 'executor_id')
    if (!executorId) return null
    const actual = unknownRecord(valueOf(executor, 'actualUse', 'actual_use'))
    return {
      executorId,
      label: stringOf(executor, 'label', 'label'),
      provider: stringOf(executor, 'provider', 'provider'),
      model: stringOf(executor, 'model', 'model'),
      client: stringOf(executor, 'client', 'client') as ConversationSourceApplication | null,
      availabilityStatus: stringOf(executor, 'availabilityStatus', 'availability_status'),
      personalSpaceId: stringOf(executor, 'personalSpaceId', 'personal_space_id'),
      displayName: stringOf(executor, 'displayName', 'display_name'),
      executorKind: stringOf(executor, 'executorKind', 'executor_kind'),
      capabilities: arrayOf(valueOf(executor, 'capabilities', 'capabilities')).filter((item): item is string => typeof item === 'string'),
      globalPriority: typeof valueOf(executor, 'globalPriority', 'global_priority') === 'number' ? valueOf(executor, 'globalPriority', 'global_priority') as number : null,
      healthRequired: valueOf(executor, 'healthRequired', 'health_required') === true,
      registrationStatus: stringOf(executor, 'registrationStatus', 'registration_status'),
      permissionStatus: stringOf(executor, 'permissionStatus', 'permission_status'),
      preflightStatus: stringOf(executor, 'preflightStatus', 'preflight_status'),
      healthStatus: stringOf(executor, 'healthStatus', 'health_status'),
      workspacePermission: typeof valueOf(executor, 'workspacePermission', 'workspace_permission') === 'boolean' ? valueOf(executor, 'workspacePermission', 'workspace_permission') as boolean : null,
      revision: typeof executor.revision === 'number' ? executor.revision : undefined,
      permissionRevision: typeof valueOf(executor, 'permissionRevision', 'permission_revision') === 'number' ? valueOf(executor, 'permissionRevision', 'permission_revision') as number : undefined,
      registeredAt: stringOf(executor, 'registeredAt', 'registered_at'),
      updatedAt: stringOf(executor, 'updatedAt', 'updated_at'),
      testSource: stringOf(executor, 'testSource', 'test_source'),
      cleanupEligible: valueOf(executor, 'cleanupEligible', 'cleanup_eligible') === true,
      advertisedModels: arrayOf(valueOf(executor, 'advertisedModels', 'advertised_models')).map(normalizeExecutorModel).filter((item): item is NonNullable<ReturnType<typeof normalizeExecutorModel>> => item !== null),
      availableModels: arrayOf(valueOf(executor, 'availableModels', 'available_models')).map(normalizeExecutorModel).filter((item): item is NonNullable<ReturnType<typeof normalizeExecutorModel>> => item !== null),
      actualUse: Object.keys(actual).length
        ? { count: typeof actual.count === 'number' ? actual.count : 0, lastUsedAt: stringOf(actual, 'lastUsedAt', 'last_used_at') }
        : null,
    } satisfies ProjectAgentExecutorRef
  })
  return values.filter((item): item is ProjectAgentExecutorRef => item !== null)
}
function normalizeRule(value: unknown): ProjectAgentRoutingRule | null {
  const record = unknownRecord(value); const ruleId = stringOf(record, 'ruleId', 'rule_id'); if (!ruleId) return null
  const status = stringOf(record, 'status', 'status')
  return { ruleId, scope: (stringOf(record, 'scope', 'scope') ?? 'global') as ProjectAgentRoutingRule['scope'], priority: typeof record.priority === 'number' ? record.priority : 0, personalProjectId: stringOf(record, 'personalProjectId', 'personal_project_id'), taskId: stringOf(record, 'taskId', 'task_id'), workKind: stringOf(record, 'workKind', 'work_kind'), agentId: stringOf(record, 'agentId', 'agent_id'), enabled: record.enabled !== false && (!status || status === 'active'), executorIds: arrayOf(valueOf(record, 'executorIds', 'executor_ids')).filter((item): item is string => typeof item === 'string'), requiredCapabilities: arrayOf(valueOf(record, 'requiredCapabilities', 'required_capabilities')).filter((item): item is string => typeof item === 'string'), modelStrategy: normalizeStrategy(valueOf(record, 'modelStrategy', 'model_strategy')), reason: stringOf(record, 'reason', 'reason'), revision: typeof record.revision === 'number' ? record.revision : undefined, status: status ?? undefined, createdAt: stringOf(record, 'createdAt', 'created_at'), updatedAt: stringOf(record, 'updatedAt', 'updated_at') }
}
function normalizeLearningMap(value: unknown): Record<string, ProjectAgentLearningEvidence> {
  const container = unknownRecord(value)
  const rawRows = Array.isArray(value)
    ? value
    : container.learningEvidence ?? container.learning_evidence ?? container.items
  const rows = Array.isArray(rawRows)
    ? rawRows
    : Object.values(unknownRecord(rawRows))
  const entries = rows.map((raw, index) => {
    const record = unknownRecord(raw)
    const personalProjectId = stringOf(record, 'personalProjectId', 'personal_project_id')
    const workKind = stringOf(record, 'workKind', 'work_kind')
    const executor = stringOf(record, 'executorId', 'executor_id') ?? stringOf(record, 'executor', 'executor')
    const modelStrategy = normalizeStrategy(valueOf(record, 'modelStrategy', 'model_strategy'))
    const modelStrategyKey = stringOf(record, 'modelStrategyKey', 'model_strategy_key')
    const learningKey = modelStrategyKey
      ?? [personalProjectId, workKind, executor, String(index)].filter(Boolean).join(':')
    const contributions = arrayOf(valueOf(record, 'evidenceContributions', 'evidence_contributions'))
    const evidence = contributions.map((item) => {
      const row = unknownRecord(item)
      const signal = stringOf(row, 'signal', 'signal')
      const kind = stringOf(row, 'evidenceKind', 'evidence_kind') ?? 'evidence'
      const weight = typeof valueOf(row, 'decayWeight', 'decay_weight') === 'number'
        ? valueOf(row, 'decayWeight', 'decay_weight') as number
        : null
      return {
        evidenceId: stringOf(row, 'evidenceId', 'evidence_id') ?? undefined,
        kind,
        count: typeof row.value === 'number' ? row.value : undefined,
        summary: signal ? `${signal}${weight === null ? '' : ` · ${weight.toFixed(3)}`}` : null,
        occurredAt: stringOf(row, 'occurredAt', 'occurred_at'),
      }
    })
    const weightedSuccess = typeof valueOf(record, 'weightedSuccess', 'weighted_success') === 'number'
      ? valueOf(record, 'weightedSuccess', 'weighted_success') as number : 0
    const weightedFailure = typeof valueOf(record, 'weightedFailure', 'weighted_failure') === 'number'
      ? valueOf(record, 'weightedFailure', 'weighted_failure') as number : 0
    const halfLife = valueOf(record, 'halfLife', 'decay_half_life_days')
    const result: ProjectAgentLearningEvidence = {
      learningKey,
      personalProjectId,
      workKind,
      executor,
      modelStrategy,
      modelStrategyKey,
      sampleCount: typeof valueOf(record, 'sampleCount', 'sample_count') === 'number' ? valueOf(record, 'sampleCount', 'sample_count') as number : 0,
      recentWeightedSamples: typeof valueOf(record, 'recentCount', 'recent_count') === 'number' ? valueOf(record, 'recentCount', 'recent_count') as number : null,
      decayBasis: typeof halfLife === 'number' ? `half-life ${halfLife}d` : null,
      updatedAt: stringOf(record, 'asOf', 'as_of') ?? stringOf(record, 'updatedAt', 'updated_at'),
      outcomes: {
        success: typeof valueOf(record, 'successCount', 'success_count') === 'number' ? valueOf(record, 'successCount', 'success_count') as number : undefined,
        rework: typeof valueOf(record, 'reworkCount', 'rework_count') === 'number' ? valueOf(record, 'reworkCount', 'rework_count') as number : undefined,
        failure: typeof valueOf(record, 'failureCount', 'failure_count') === 'number' ? valueOf(record, 'failureCount', 'failure_count') as number : undefined,
        scoreCount: typeof valueOf(record, 'ratingCount', 'rating_count') === 'number' ? valueOf(record, 'ratingCount', 'rating_count') as number : undefined,
      },
      evidence,
      score: weightedSuccess - weightedFailure,
      neutral: valueOf(record, 'neutralDueToInsufficientEvidence', 'neutral_due_to_insufficient_evidence') === true,
    }
    return [learningKey, result] as const
  })
  return Object.fromEntries(entries)
}
function taskValues(value: unknown) { const record = unknownRecord(value); return arrayOf(Array.isArray(value) ? value : record.tasks ?? record.items).map(normalizeTask).filter(Boolean) as ProjectAgentTaskRecord[] }
function normalizeRecruitment(value: unknown): ProjectAgentRecruitmentRecord | null {
  const record = unknownRecord(value)
  const recruitmentId = stringOf(record, 'recruitmentId', 'recruitment_id')
  if (!recruitmentId) return null
  return {
    recruitmentId,
    personalSpaceId: stringOf(record, 'personalSpaceId', 'personal_space_id') ?? activeSpaceId.value,
    personalProjectId: stringOf(record, 'personalProjectId', 'personal_project_id') ?? '',
    taskId: stringOf(record, 'taskId', 'task_id') ?? '',
    coordinatorAgentId: stringOf(record, 'coordinatorAgentId', 'coordinator_agent_id') ?? '',
    hrAgentId: stringOf(record, 'hrAgentId', 'hr_agent_id'),
    positionKind: stringOf(record, 'positionKind', 'position_kind') ?? 'durable',
    workKind: stringOf(record, 'workKind', 'work_kind') ?? '',
    requiredCapabilities: arrayOf(valueOf(record, 'requiredCapabilities', 'required_capabilities')).filter((item): item is string => typeof item === 'string'),
    reasonCode: stringOf(record, 'reasonCode', 'reason_code') ?? '',
    reason: stringOf(record, 'reason', 'reason') ?? '',
    status: stringOf(record, 'status', 'status') ?? 'unknown',
    confirmationMode: stringOf(record, 'confirmationMode', 'confirmation_mode'),
    proposedAgentId: stringOf(record, 'proposedAgentId', 'proposed_agent_id') ?? '',
    revision: typeof record.revision === 'number' ? record.revision : undefined,
    recruitedAgentId: stringOf(record, 'recruitedAgentId', 'recruited_agent_id'),
    triggerSourceApplication: stringOf(record, 'triggerSourceApplication', 'trigger_source_application') as ConversationSourceApplication | null,
    triggerSourceSessionId: stringOf(record, 'triggerSourceSessionId', 'trigger_source_session_id'),
    testSource: stringOf(record, 'testSource', 'test_source'),
    cleanupEligible: valueOf(record, 'cleanupEligible', 'cleanup_eligible') === true,
    createdAt: stringOf(record, 'createdAt', 'created_at') ?? '',
    updatedAt: stringOf(record, 'updatedAt', 'updated_at') ?? '',
    fulfilledAt: stringOf(record, 'fulfilledAt', 'fulfilled_at'),
  }
}
function recruitmentValues(value: unknown) {
  const record = unknownRecord(value)
  return arrayOf(Array.isArray(value) ? value : record.recruitments ?? record.items)
    .map(normalizeRecruitment)
    .filter((item): item is ProjectAgentRecruitmentRecord => Boolean(item))
}
function recruitmentBelongsTo(recruitment: ProjectAgentRecruitmentRecord, agent: ProjectAgentRecord) {
  return recruitment.recruitedAgentId === agent.agentId
    || recruitment.proposedAgentId === agent.agentId
    || recruitment.recruitmentId === agent.recruitmentId
}
function clientValues(value: unknown) { const record = unknownRecord(value); return arrayOf(Array.isArray(value) ? value : record.clients ?? record.executors ?? record.items).map(normalizeClient).filter(Boolean) as ProjectAgentClientEvidence[] }
function routingValues(value: unknown) { const record = unknownRecord(value); return arrayOf(Array.isArray(value) ? value : record.rules ?? record.items).map(normalizeRule).filter(Boolean) as ProjectAgentRoutingRule[] }
function learningValues(value: unknown) { const record = unknownRecord(value); return normalizeLearningMap(record.learningEvidence ?? record.learning_evidence ?? value) }

function mergeAgents(values: unknown[]) {
  const merged = new Map<string, ProjectAgentRecord>()
  values.map(normalizeAgent).forEach((agent) => {
    const current = merged.get(agent.agentId)
    if (!current) { merged.set(agent.agentId, agent); return }
    const assignments = [...assignmentsFor(current), ...assignmentsFor(agent)]
    const tasks = [...(current.tasks ?? []), ...(agent.tasks ?? [])]
    merged.set(agent.agentId, {
      ...current, personalProjectId: current.personalProjectId ?? agent.personalProjectId,
      profile: { ...current.profile, occupationEmoji: current.profile.occupationEmoji ?? agent.profile.occupationEmoji, capabilities: unique([...current.profile.capabilities, ...agent.profile.capabilities]), workKinds: unique([...(current.profile.workKinds ?? []), ...(agent.profile.workKinds ?? [])]), defaultModelStrategy: current.profile.defaultModelStrategy ?? agent.profile.defaultModelStrategy, executorPolicy: current.profile.executorPolicy ?? agent.profile.executorPolicy, allowedClients: unique([...(current.profile.allowedClients ?? []), ...(agent.profile.allowedClients ?? [])]) as ConversationSourceApplication[] },
      assignments: dedupeById(assignments, ({ assignmentId }) => assignmentId), recruitments: dedupeById([...(current.recruitments ?? []), ...(agent.recruitments ?? [])], ({ recruitmentId }) => recruitmentId), tasks: dedupeById(tasks, ({ taskId }) => taskId), activity: current.activity ?? agent.activity,
      clientEvidence: current.clientEvidence?.length ? current.clientEvidence : agent.clientEvidence, routingRules: current.routingRules?.length ? current.routingRules : agent.routingRules,
      learningEvidence: { ...(agent.learningEvidence ?? {}), ...(current.learningEvidence ?? {}) }, observedClients: unique([...(current.observedClients ?? []), ...(agent.observedClients ?? [])]) as ConversationSourceApplication[], openTaskCount: Math.max(current.openTaskCount ?? 0, agent.openTaskCount ?? 0) || undefined, currentTaskId: current.currentTaskId ?? agent.currentTaskId, workStatus: current.workStatus ?? agent.workStatus,
    })
  })
  return [...merged.values()]
}
function dedupeById<T>(values: T[], key: (value: T) => string) { return [...new Map(values.map((value) => [key(value), value])).values()] }
function unique<T>(values: T[]) { return [...new Set(values)] }
</script>

<template>
  <section class="view project-agents-view" :aria-label="t('projectAgents.aria')">
    <header class="project-agents-header">
      <div>
        <h2>{{ t('projectAgents.title') }}</h2>
        <p class="project-agents-header-meta">{{ t('projectAgents.stats.total', { count: agents.length }) }} · {{ t('projectAgents.stats.assignments', { count: assignmentCount }) }} · {{ t('projectAgents.stats.projects', { count: representedProjectCount }) }}</p>
      </div>
      <div class="project-agent-header-actions">
        <button class="quiet-button" type="button" :disabled="!activeSpaceId" @click="openCreate">{{ t('projectAgents.add') }}</button>
        <button class="project-agent-add" type="button" :disabled="!activeSpaceId" @click="openRecruit()">{{ t('employees.recruit') }}</button>
      </div>
    </header>
    <EmployeeRecruitDialog :open="recruitDialogOpen" :personal-space-id="activeSpaceId" :projects="projects" :template-id="recruitTemplateId" :default-project-ids="projectFilter ?? []" @close="recruitDialogOpen = false" @recruited="employeeRecruited" />
    <div class="project-agents-summary" aria-live="polite"><span>{{ t('projectAgents.stats.active', { count: activeCount }) }}</span><span>{{ t('projectAgents.stats.noOnlineClaim') }}</span></div>

    <div class="project-agents-toolbar">
      <ProjectScopePicker v-model="filterProjectIds" class="project-agents-project-filter" compact :projects="projectOptions" :label="t('employees.filterLabel')" :hint="t('employees.filterHint')" :empty-label="t('employees.filterEmpty')" />
      <label class="project-agents-search"><span class="sr-only">{{ t('projectAgents.searchLabel') }}</span><input v-model="search" type="search" :placeholder="t('projectAgents.searchPlaceholder')" /></label>
      <div class="project-agents-status-filter" :aria-label="t('projectAgents.fields.status')">
        <button v-for="option in statusOptions" :key="option.value" type="button" :aria-pressed="statusFilter === option.value" @click="statusFilter = option.value">{{ option.label }}</button>
      </div>
    </div>

    <ProjectAgentAutomationPolicyPanel
      v-if="singleFilterProjectId"
      :key="singleFilterProjectId"
      :personal-space-id="activeSpaceId"
      :personal-project-id="singleFilterProjectId"
      :project-name="projectName(singleFilterProjectId)"
    />

    <div v-if="loading" class="project-agents-state">{{ t('projectAgents.loading') }}</div>
    <div v-else-if="error" class="project-agents-state is-error" role="alert"><p>{{ error }}</p><button class="quiet-button" type="button" @click="loadAgents()">{{ t('projectAgents.retry') }}</button></div>
    <div v-else-if="!agents.length" class="project-agents-state"><strong>{{ t('projectAgents.emptyTitle') }}</strong><p>{{ t('projectAgents.emptyCopy') }}</p><button class="project-agent-add" type="button" :disabled="!activeSpaceId" @click="openCreate">{{ t('projectAgents.add') }}</button></div>
    <div v-else-if="!filteredAgents.length" class="project-agents-state"><strong>{{ t('projectAgents.noMatchTitle') }}</strong><p>{{ t('projectAgents.noMatchCopy') }}</p></div>
    <div v-else class="project-agents-directory">
      <div class="project-agent-list" role="list" :aria-label="t('projectAgents.listLabel')">
        <button v-for="agent in filteredAgents" :key="agent.agentId" type="button" class="project-agent-row" :class="{ selected: selectedAgentKey === agent.agentId }" :aria-current="selectedAgentKey === agent.agentId ? 'true' : undefined" @click="selectedAgentKey = agent.agentId">
          <span class="project-agent-row-heading"><span v-if="agent.profile.occupationEmoji" class="project-agent-occupation-emoji" role="img" :aria-label="`${t('projectAgents.fields.occupationEmoji')}: ${agent.profile.occupationEmoji}`">{{ agent.profile.occupationEmoji }}</span><strong>{{ agent.profile.name }}</strong><i class="project-agent-kind">{{ agentTypeLabel(agent.profile.agentType) }}</i><i :class="`is-${agent.profile.status}`">{{ t(`projectAgents.status.${agent.profile.status}`) }}</i></span>
          <span class="project-agent-row-projects"><b v-for="project in responsibleProjectsFor(agent).slice(0, 3)" :key="project.id">{{ project.name }}</b><b v-if="responsibleProjectsFor(agent).length > 3">+{{ responsibleProjectsFor(agent).length - 3 }}</b><em v-if="!responsibleProjectsFor(agent).length">{{ t('employees.noAssignedProjects') }}</em></span>
          <span class="project-agent-row-responsibility">{{ agent.profile.responsibility || t('projectAgents.notReported') }}</span>
          <span class="project-agent-row-work"><template v-if="currentWork(agent)"><i :class="['project-agent-work-dot', { 'is-live': currentWork(agent)!.status === 'running' }]" aria-hidden="true" />{{ taskStatusLabel(currentWork(agent)!.status) }} · {{ currentWork(agent)!.title }}</template><template v-else-if="agent.workStatus === 'blocked' || agent.workStatus === 'queued'">{{ taskStatusLabel(agent.workStatus) }} · {{ t('projectAgents.detail.stateReported') }}</template><template v-else>{{ t('projectAgents.detail.noRun') }}</template></span>
          <span class="project-agent-row-capabilities"><b v-for="capability in agent.profile.capabilities.slice(0, 3)" :key="capability">{{ capability }}</b></span>
        </button>
      </div>

      <aside v-if="selectedAgent" class="project-agent-detail" :aria-label="selectedAgent.profile.name">
        <header><div class="project-agent-detail-heading"><h3><span v-if="selectedAgent.profile.occupationEmoji" class="project-agent-occupation-emoji" role="img" :aria-label="`${t('projectAgents.fields.occupationEmoji')}: ${selectedAgent.profile.occupationEmoji}`">{{ selectedAgent.profile.occupationEmoji }}</span>{{ selectedAgent.profile.name }}</h3><p>{{ selectedAgent.agentId }} · {{ agentTypeLabel(selectedAgent.profile.agentType) }}<span v-if="selectedAgent.isTestRole"> · {{ t('projectAgents.source.testRole') }}<span v-if="selectedAgent.profile.testSource"> · {{ selectedAgent.profile.testSource }}</span></span></p></div><div class="project-agent-detail-actions"><button class="quiet-button" type="button" :disabled="detailLoading" @click="refreshDetails()">{{ detailLoading ? t('projectAgents.detail.refreshing') : t('projectAgents.detail.refresh') }}</button><button class="quiet-button" type="button" @click="openEdit(selectedAgent)">{{ t('projectAgents.edit') }}</button><button v-if="selectedAgent.profile.cleanupEligible" class="quiet-button" type="button" :disabled="detailLoading" @click="cleanupTestAgent(selectedAgent)">{{ t('projectAgents.source.cleanup') }}</button></div></header>
        <p v-if="detailNotice" class="project-agent-detail-notice" role="status">{{ detailNotice }}</p>
        <section v-if="selectedEmployeeId" class="employee-project-overview" aria-labelledby="employee-project-overview-title">
          <div class="employee-project-overview-heading">
            <div><h4 id="employee-project-overview-title">{{ selectedEmployee?.management?.mode === 'all' ? t('employees.scope.continuousAll') : t('employees.scope.label') }}</h4><p>{{ t('employees.assignedCount', { count: employeeProjects.length }) }}</p></div>
            <button class="project-agent-add" type="button" @click="openRecruit(selectedEmployeeId)">{{ t('employees.manageProjects') }}</button>
          </div>
          <div v-if="employeeProjects.length" class="employee-assigned-projects">
            <RouterLink v-for="project in employeeProjects" :key="project.id" :to="`/employees/${encodeURIComponent(selectedEmployeeId)}?project=${encodeURIComponent(project.id)}`">
              <span>{{ project.name }}</span>
              <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M4 10h12m-5-5 5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg>
            </RouterLink>
          </div>
          <p v-else class="employee-project-overview-hint">{{ t('employees.manageHint') }}</p>
        </section>
        <dl class="project-agent-detail-meta"><div><dt>{{ t('projectAgents.fields.assignments') }}</dt><dd>{{ currentAssignmentsFor(selectedAgent).length }}</dd></div><div><dt>{{ t('projectAgents.fields.memoryScope') }}</dt><dd>{{ selectedAgent.memoryScope ?? t('projectAgents.notReported') }}</dd></div><div><dt>{{ t('projectAgents.fields.status') }}</dt><dd>{{ t(`projectAgents.status.${selectedAgent.profile.status}`) }}</dd></div><div><dt>{{ t('projectAgents.fields.recruitment') }}</dt><dd>{{ sourceLabel(selectedAgent.recruitmentSourceApplication) }}<small v-if="selectedAgent.recruitmentReason">{{ selectedAgent.recruitmentReason }}</small></dd></div><div><dt>{{ t('projectAgents.fields.updatedAt') }}</dt><dd>{{ formatDate(selectedAgent.updatedAt) }}</dd></div></dl>

        <div class="project-agent-detail-source" data-detail-section="recruitment">
          <ProjectAgentDetailState v-bind="detailState('recruitments')" @retry="refreshDetails">
            <section class="project-agent-detail-section" aria-labelledby="project-agent-recruitment-heading"><div class="project-agent-section-heading"><h4 id="project-agent-recruitment-heading">{{ t('projectAgents.sections.recruitment') }}</h4><span>{{ selectedRecruitments.length }}</span></div><div v-if="selectedRecruitments.length" class="project-agent-recruitment-list"><article v-for="recruitment in selectedRecruitments" :key="recruitment.recruitmentId" class="project-agent-recruitment-card"><header><strong>{{ recruitment.positionKind }} · {{ recruitment.workKind || t('projectAgents.notReported') }}</strong><div class="project-agent-card-actions"><i>{{ recruitment.status }}</i><button v-if="recruitment.status === 'awaiting_confirmation'" class="quiet-button" type="button" :disabled="Boolean(recruitmentBusy)" @click="decideRecruitment(recruitment, 'approve')">{{ t('projectAgents.recruitment.approve') }}</button><button v-if="recruitment.status === 'awaiting_confirmation'" class="quiet-button" type="button" :disabled="Boolean(recruitmentBusy)" @click="decideRecruitment(recruitment, 'cancel')">{{ t('projectAgents.recruitment.cancel') }}</button></div></header><dl class="project-agent-compact-meta"><div><dt>{{ t('projectAgents.recruitment.hr') }}</dt><dd>{{ recruitment.hrAgentId || t('projectAgents.notReported') }}</dd></div><div><dt>{{ t('projectAgents.recruitment.trigger') }}</dt><dd>{{ sourceLabel(recruitment.triggerSourceApplication) }}</dd></div><div><dt>{{ t('projectAgents.recruitment.reason') }}</dt><dd>{{ recruitment.reason || recruitment.reasonCode || t('projectAgents.notReported') }}</dd></div><div><dt>{{ t('projectAgents.recruitment.time') }}</dt><dd>{{ formatDate(recruitment.fulfilledAt || recruitment.createdAt) }}</dd></div></dl><small>{{ t('projectAgents.recruitment.testSource') }} · {{ recruitment.testSource || t('projectAgents.notReported') }}</small></article></div><p v-else class="project-agent-muted">{{ t('projectAgents.recruitment.empty') }}</p></section>
          </ProjectAgentDetailState>
        </div>

        <section class="project-agent-detail-section is-responsibility"><h4>{{ t('projectAgents.fields.responsibility') }}</h4><p>{{ selectedAgent.profile.responsibility || t('projectAgents.notReported') }}</p><div v-if="selectedAgent.profile.capabilities.length" class="project-agent-tags"><span v-for="capability in selectedAgent.profile.capabilities" :key="capability">{{ capability }}</span></div></section>

        <div class="project-agent-detail-source" data-detail-section="assignments">
          <ProjectAgentDetailState v-bind="detailState('assignments')" @retry="refreshDetails">
            <section class="project-agent-detail-section"><div class="project-agent-section-heading"><h4>{{ t('projectAgents.sections.assignments') }}</h4><div class="project-agent-section-tools"><span>{{ assignmentsFor(selectedAgent).length }}</span><button class="quiet-button" type="button" @click="openAssignment(selectedAgent)">{{ t('projectAgents.assignmentDialog.assign') }}</button></div></div><div v-if="assignmentsFor(selectedAgent).length" class="project-agent-assignment-list"><article v-for="assignment in assignmentsFor(selectedAgent)" :key="assignment.assignmentId" class="project-agent-assignment-card"><header><strong>{{ projectName(assignment.personalProjectId) }}</strong><div class="project-agent-card-actions"><i :class="`is-${assignment.status}`">{{ t(`projectAgents.assignmentStatus.${assignment.status}`) }}</i><button v-if="assignment.status === 'active'" class="quiet-button" type="button" @click="openAssignment(selectedAgent, assignment, 'end')">{{ t('projectAgents.assignmentDialog.end') }}</button><button v-if="assignment.status === 'active'" class="quiet-button" type="button" @click="openAssignment(selectedAgent, assignment, 'replace')">{{ t('projectAgents.assignmentDialog.replace') }}</button></div></header><p>{{ assignment.responsibility || t('projectAgents.notReported') }}</p><small v-if="assignment.scope">{{ t('projectAgents.fields.scope') }} · {{ assignment.scope }}</small><small>{{ formatDate(assignment.assignedAt) }} → {{ assignment.endedAt ? formatDate(assignment.endedAt) : t(`projectAgents.assignmentStatus.${assignment.status}`) }}</small><div v-if="assignment.workKinds?.length" class="project-agent-inline-list"><span v-for="workKind in assignment.workKinds" :key="workKind">{{ workKind }}</span></div><div class="project-agent-strategy-note"><span>{{ t('projectAgents.fields.assignmentModel') }}</span><strong>{{ strategyLabel(assignment.modelStrategyOverride) }} · {{ policyLabel(assignment.executorPolicyOverride) }}</strong><small v-if="policyIsLocked(assignment.executorPolicyOverride) && !policyAllowList(assignment.executorPolicyOverride).length">{{ t('projectAgents.strategy.lockedUnavailable') }}</small></div><div v-if="policyAllowList(assignment.executorPolicyOverride).length" class="project-agent-tags"><span v-for="executor in policyAllowList(assignment.executorPolicyOverride)" :key="executor.executorId">{{ executor.label || executor.executorId }}</span></div><small v-if="assignment.reason">{{ t('projectAgents.fields.reason') }} · {{ assignment.reason }}</small></article></div><p v-else class="project-agent-muted">{{ t('projectAgents.detail.noAssignments') }}</p></section>
          </ProjectAgentDetailState>
        </div>

        <div class="project-agent-detail-source" data-detail-section="executors">
          <ProjectAgentDetailState v-bind="detailState('executors')" @retry="refreshDetails">
            <section class="project-agent-detail-section"><div class="project-agent-section-heading"><h4>{{ t('projectAgents.sections.strategy') }}</h4><span>{{ strategyLabel(selectedAgent.profile.defaultModelStrategy) }} · {{ policyLabel(selectedAgent.profile.executorPolicy) }}</span></div><p class="project-agent-muted">{{ t('projectAgents.strategy.providerNeutral') }}</p><div v-if="policyAllowList(selectedAgent.profile.executorPolicy).length" class="project-agent-tags"><span v-for="executor in policyAllowList(selectedAgent.profile.executorPolicy)" :key="executor.executorId">{{ executor.label || executor.executorId }}</span></div><p v-else-if="policyIsLocked(selectedAgent.profile.executorPolicy)" class="project-agent-blocked">{{ t('projectAgents.strategy.lockedUnavailable') }}</p><p v-else class="project-agent-muted">{{ t('projectAgents.strategy.noAllowList') }}</p><div class="project-agent-section-tools"><button class="quiet-button" type="button" @click="openExecutorDialog()">{{ t('projectAgents.routing.addExecutor') }}</button></div><div v-if="selectedAgent.executorDirectory?.length" class="project-agent-executor-list"><div v-for="executor in selectedAgent.executorDirectory" :key="executor.executorId" class="project-agent-executor-row"><strong>{{ executor.displayName || executor.label || executor.executorId }}</strong><span>{{ executor.provider || t('projectAgents.notReported') }} / {{ executor.model || t('projectAgents.notReported') }}</span><span>{{ executor.globalPriority ?? t('projectAgents.notReported') }}</span><small>{{ executor.registrationStatus || t('projectAgents.notReported') }} · {{ executor.permissionStatus || t('projectAgents.notReported') }} · {{ executor.preflightStatus || t('projectAgents.strategy.availabilityUnreported') }} · {{ executor.healthStatus || t('projectAgents.notReported') }}</small><button class="quiet-button" type="button" @click="openExecutorDialog(executor)">{{ t('projectAgents.routing.editExecutor') }}</button><button v-if="executor.permissionStatus !== 'authorized'" class="quiet-button" type="button" :disabled="Boolean(executorBusy)" @click="authorizeExecutor(executor, 'authorized')">{{ t('projectAgents.routing.authorize') }}</button><button v-else class="quiet-button" type="button" :disabled="Boolean(executorBusy)" @click="authorizeExecutor(executor, 'revoked')">{{ t('projectAgents.routing.revoke') }}</button></div></div></section>
          </ProjectAgentDetailState>
        </div>

        <div class="project-agent-detail-source" data-detail-section="tasks">
          <ProjectAgentDetailState v-bind="detailState('tasks')" @retry="refreshDetails">
            <section class="project-agent-detail-section"><div class="project-agent-section-heading"><h4>{{ t('projectAgents.sections.tasks') }}</h4><span>{{ selectedAgent.tasks?.length ?? 0 }}</span></div><div v-if="selectedAgent.tasks?.length" class="project-agent-task-list"><article v-for="task in selectedAgent.tasks" :key="task.taskId" class="project-agent-task-card"><header><div><strong>{{ task.title }}</strong><small>{{ task.taskId }} · {{ projectName(task.personalProjectId) }}</small></div><i :class="`is-${task.status}`">{{ taskStatusLabel(task.status) }}</i></header><p v-if="task.resultSummary || task.failureReason">{{ task.resultSummary || task.failureReason }}</p><small>{{ t('projectAgents.fields.collaborators') }} · {{ task.participants.length }}</small><div v-if="task.participants.length" class="project-agent-inline-list"><span v-for="participant in task.participants" :key="`${task.taskId}:${participant.agentId}`">{{ participant.agentId }} · {{ participant.role }}</span></div><section v-if="task.executionSummary !== undefined" class="project-agent-execution-summary" :aria-label="t('projectAgents.fields.executionSummary')">
<div class="project-agent-section-heading">
<h5>{{ t('projectAgents.fields.executionSummary') }}</h5>
<span>{{ task.executionSummary.length }}</span>
</div>
<div v-if="task.executionSummary.length" class="project-agent-execution-summary-table-wrap" role="region" tabindex="0" :aria-label="t('projectAgents.fields.executionSummary')">
<table class="project-agent-execution-summary-table">
<caption class="sr-only">{{ t('projectAgents.fields.executionSummary') }}</caption>
<thead>
<tr>
<th scope="col">{{ t('projectAgents.fields.worker') }}</th>
<th scope="col">{{ t('projectAgents.fields.workSummary') }}</th>
<th scope="col">{{ t('projectAgents.fields.toolsUsed') }}</th>
<th scope="col">{{ t('projectAgents.fields.executionEnvironment') }}</th>
<th scope="col">{{ t('projectAgents.fields.sourceSession') }}</th>
<th scope="col">{{ t('projectAgents.fields.tokenUsage') }}</th>
<th scope="col">{{ t('projectAgents.fields.terminalStatus') }}</th>
</tr>
</thead>
<tbody>
<tr v-for="(summary, summaryIndex) in task.executionSummary" :key="task.taskId + ':execution:' + (summary.workerId || summary.agentId || summaryIndex)" class="project-agent-execution-summary-row">
<th scope="row">
<span class="project-agent-execution-worker">
<span v-if="executionSummaryOccupationEmoji(summary)" class="project-agent-occupation-emoji" role="img" :aria-label="t('projectAgents.fields.occupationEmoji') + ': ' + executionSummaryOccupationEmoji(summary)">{{ executionSummaryOccupationEmoji(summary) }}</span>
{{ executionSummaryWorkerLabel(summary) }}
</span>
<small v-if="summary.agentId || summary.workerId">{{ summary.workerId || summary.agentId }}</small>
<small>{{ participantRoleLabel(summary.participantRole) }}</small>
</th>
<td :data-label="t('projectAgents.fields.workSummary')">{{ summary.workSummary || t('projectAgents.notReported') }}</td>
<td :data-label="t('projectAgents.fields.toolsUsed')">{{ summary.toolsUsed ? summary.toolsUsed.join(' · ') || t('projectAgents.noToolsUsed') : t('projectAgents.notReported') }}</td>
<td :data-label="t('projectAgents.fields.executionEnvironment')">
<strong>{{ summary.executor || t('projectAgents.notReported') }}</strong>
<small v-if="summary.executorId && summary.executorId !== summary.executor">{{ summary.executorId }}</small>
<small v-if="summary.actualModelProvider || summary.actualModel">{{ [summary.actualModelProvider, summary.actualModel].filter(Boolean).join(' · ') }}</small>
</td>
<td :data-label="t('projectAgents.fields.sourceSession')">
<span><template v-if="summary.workerRuntime">{{ t('projectAgents.fields.workerSession') }} · </template>{{ sourceLabel(summary.workerRuntime?.application || summary.sourceApplication) }}</span>
<a v-if="executionSummarySessionHref(summary)" :href="executionSummarySessionHref(summary) || undefined" target="_blank" rel="noreferrer">{{ executionSummarySessionId(summary) || executionSummarySessionHref(summary) }}</a>
<small v-else>{{ executionSummarySessionId(summary) || t('projectAgents.notReported') }}</small>
<template v-if="summary.workerRuntime">
<small class="project-agent-reporter-label">{{ t('projectAgents.fields.reporterSession') }} · {{ sourceLabel(summary.sourceApplication) }}</small>
<a v-if="sessionHref(summary.sourceSessionUrl)" :href="sessionHref(summary.sourceSessionUrl) || undefined" target="_blank" rel="noreferrer">{{ summary.sourceSessionId || summary.sourceSessionUrl }}</a>
<small v-else>{{ summary.sourceSessionId || t('projectAgents.notReported') }}</small>
</template>
</td>
<td :data-label="t('projectAgents.fields.tokenUsage')">{{ tokenUsageLabel(summary.tokenUsage) }}</td>
<td :data-label="t('projectAgents.fields.terminalStatus')"><i v-if="summary.status" :class="'is-' + summary.status">{{ executionSummaryStatusLabel(summary.status) }}</i><span v-else>{{ t('projectAgents.notReported') }}</span></td>
</tr>
</tbody>
</table>
</div>
<p v-else class="project-agent-muted">{{ t('projectAgents.detail.noExecutionSummary') }}</p>
</section><section v-if="workerEventEvidence(task).length" class="project-agent-worker-event-evidence" :aria-label="t('projectAgents.fields.workerEventEvidence')"><div class="project-agent-section-heading"><h5>{{ t('projectAgents.fields.workerEventEvidence') }}</h5><span>{{ workerEventEvidence(task).length }}</span></div><ul class="project-agent-execution-summary-list"><li v-for="event in workerEventEvidence(task)" :key="`${task.taskId}:worker-event:${event.eventId}`" class="project-agent-worker-event-row"><header><strong><span v-if="workerEventOccupationEmoji(event)" class="project-agent-occupation-emoji" role="img" :aria-label="`${t('projectAgents.fields.occupationEmoji')}: ${workerEventOccupationEmoji(event)}`">{{ workerEventOccupationEmoji(event) }}</span>{{ workerEventLabel(event) }}<small v-if="event.agentId">{{ t('projectAgents.fields.agentId') }} · {{ event.agentId }}</small></strong><i :class="`is-${event.workerStatus || event.status}`">{{ workerEventStatusLabel(event) }}</i></header><dl class="project-agent-execution-summary-meta"><div><dt>{{ t('projectAgents.fields.workSummary') }}</dt><dd>{{ event.summary || t('projectAgents.notReported') }}</dd></div><div><dt>{{ t('projectAgents.fields.sourceApplication') }}</dt><dd>{{ sourceLabel(event.sourceApplication) }}</dd></div><div><dt>{{ t('projectAgents.fields.sourceSession') }}</dt><dd>{{ event.sourceSessionId || t('projectAgents.notReported') }}</dd></div><div><dt>{{ t('projectAgents.fields.tokenUsage') }}</dt><dd>{{ tokenUsageLabel(event.tokenUsage) }}</dd></div><div v-if="event.actualModelProvider || event.actualModel"><dt>{{ t('projectAgents.fields.actualModel') }}</dt><dd><span v-if="event.actualModelProvider">{{ event.actualModelProvider }}</span><span v-if="event.actualModelProvider && event.actualModel"> · </span><span v-if="event.actualModel">{{ event.actualModel }}</span></dd></div><div><dt>{{ t('projectAgents.fields.reportedAt') }}</dt><dd>{{ formatDate(event.createdAt) }}</dd></div></dl></li></ul></section><small v-if="task.effectiveModelStrategy">{{ t('projectAgents.fields.strategySource') }} · {{ task.modelStrategySource || t('projectAgents.notReported') }} · {{ strategyLabel(task.effectiveModelStrategy) }} · {{ policyLabel(task.effectiveExecutorPolicy) }}</small><div v-if="task.routingDecision" class="project-agent-routing-decision"><div class="project-agent-section-heading"><span>{{ t('projectAgents.fields.reportedStaffingDecision') }}</span><strong>{{ task.routingDecision.outcome || t('projectAgents.notReported') }}</strong></div><small v-if="task.routingDecision.coordinatorAgentId || task.coordinatorAgentId">{{ t('projectAgents.fields.coordinator') }} · {{ task.routingDecision.coordinatorAgentId || task.coordinatorAgentId }}</small><small>{{ t('projectAgents.fields.matchBasis') }} · {{ task.routingDecision.matchBasis?.join(' · ') || t('projectAgents.notReported') }} · {{ task.routingDecision.reason || t('projectAgents.notReported') }}</small><small v-if="task.routingDecision.candidateAgentIds?.length">{{ t('projectAgents.fields.candidateAgents') }} · {{ task.routingDecision.candidateAgentIds.join(' · ') }}</small><small v-if="task.routingDecision.complexity !== null && task.routingDecision.complexity !== undefined">{{ t('projectAgents.fields.complexity') }} · {{ task.routingDecision.complexity }}<span v-if="task.routingDecision.complexityBasis?.length"> · {{ task.routingDecision.complexityBasis.join(' · ') }}</span></small><small v-if="parallelPlanHasEvidence(task.routingDecision.parallelPlan)">{{ t('projectAgents.fields.parallelPlan') }} · {{ task.routingDecision.parallelPlan?.reason || t('projectAgents.notReported') }}<span v-if="task.routingDecision.parallelPlan?.workstreamBoundaries?.length"> · {{ task.routingDecision.parallelPlan.workstreamBoundaries.join(' · ') }}</span></small><small v-if="task.routingDecision.ruleId || task.routingDecision.fallback">{{ task.routingDecision.ruleId || t('projectAgents.notReported') }} · {{ task.routingDecision.fallback || t('projectAgents.notReported') }}</small></div><div class="project-agent-execution-line"><span>{{ t('projectAgents.fields.actualExecution') }}</span><strong v-if="actualExecution(task)">{{ actualExecution(task)?.executor || actualExecution(task)?.provider || t('projectAgents.notReported') }} / {{ actualExecution(task)?.model || t('projectAgents.notReported') }} / {{ sourceLabel(actualExecution(task)?.client) }}</strong><span v-else>{{ t('projectAgents.detail.notReportedActualExecution') }}</span><small v-if="actualExecution(task)?.rule || actualExecution(task)?.fallback">{{ actualExecution(task)?.rule || t('projectAgents.notReported') }} · {{ actualExecution(task)?.fallback || t('projectAgents.notReported') }}</small></div><small v-if="task.runId">{{ t('projectAgents.fields.run') }} · {{ task.runId }}</small><small v-else>{{ t('projectAgents.detail.noRun') }}</small></article></div><p v-else class="project-agent-muted">{{ t('projectAgents.detail.noTasks') }}</p></section>
          </ProjectAgentDetailState>
        </div>

        <div class="project-agent-detail-source" data-detail-section="activity">
          <ProjectAgentDetailState v-bind="detailState('activity')" @retry="refreshDetails">
            <section class="project-agent-detail-section"><div class="project-agent-section-heading"><h4>{{ t('projectAgents.sections.activity') }}</h4><span v-if="selectedActivity">{{ selectedActivity.days.length }}</span></div><div v-if="selectedActivity?.days.length" class="project-agent-heatmap-wrap project-agent-heatmap-viewport"><div class="project-agent-heatmap" role="list" :aria-label="t('projectAgents.activity.aria')"><button v-for="day in selectedActivity.days" :key="day.date" type="button" role="listitem" :class="['project-agent-heat-cell', `intensity-${activityIntensity(day, selectedActivity)}`, { selected: activityDay === day.date }]" :aria-label="`${formatDateOnly(day.date)} · ${day.total}`" :aria-pressed="activityDay === day.date" @click="chooseActivityDay(day)"><span class="sr-only">{{ formatDateOnly(day.date) }} · {{ day.total }}</span></button></div><article v-if="selectedActivityDay" class="project-agent-day-detail"><header><strong>{{ formatDateOnly(selectedActivityDay.date) }}</strong><span>{{ selectedActivityDay.total }}</span></header><p v-if="!selectedActivityDay.tasks?.length" class="project-agent-muted">{{ t('projectAgents.activity.noTasks') }}</p><ul v-else><li v-for="task in selectedActivityDay.tasks" :key="task.taskId"><strong>{{ task.title }}</strong><span>{{ taskStatusLabel(task.status) }} · {{ projectName(task.personalProjectId) }}</span><small>{{ task.summary || t('projectAgents.notReported') }}</small></li></ul></article></div><p v-else class="project-agent-muted">{{ t('projectAgents.activity.empty') }}</p></section>
          </ProjectAgentDetailState>
        </div>

        <div class="project-agent-detail-source" data-detail-section="clients">
          <ProjectAgentDetailState v-bind="detailState('executors')" @retry="refreshDetails">
            <section class="project-agent-detail-section"><div class="project-agent-section-heading"><h4>{{ t('projectAgents.sections.clients') }}</h4><span>{{ clientNames(selectedAgent).length }}</span></div><div v-if="clientNames(selectedAgent).length" class="project-agent-client-list"><div v-for="clientName in clientNames(selectedAgent)" :key="clientName" class="project-agent-client-row"><strong>{{ sourceLabel(clientName) }}</strong><span>{{ clientEvidenceFor(selectedAgent, clientName)?.allowed || selectedAgent.profile.allowedClients?.includes(clientName) ? t('projectAgents.clients.allowed') : t('projectAgents.clients.notAllowed') }}</span><span v-if="clientUseCount(selectedAgent, clientName)">{{ t('projectAgents.clients.observed', { count: clientUseCount(selectedAgent, clientName) }) }}</span><span v-else-if="selectedAgent.observedClients?.includes(clientName)">{{ t('projectAgents.clients.observedAny') }}</span><span v-else>{{ t('projectAgents.clients.unreported') }}</span><small>{{ clientEvidenceFor(selectedAgent, clientName)?.integrationStatus || t('projectAgents.clients.integrationUnreported') }}</small></div></div><p v-else class="project-agent-muted">{{ t('projectAgents.clients.empty') }}</p></section>
          </ProjectAgentDetailState>
        </div>

        <div class="project-agent-detail-source" data-detail-section="routing">
          <ProjectAgentDetailState v-bind="detailState('routingRules')" @retry="refreshDetails">
            <section class="project-agent-detail-section"><div class="project-agent-section-heading"><h4>{{ t('projectAgents.sections.routing') }}</h4><div class="project-agent-section-tools"><span>{{ selectedAgent.routingRules?.length ?? 0 }}</span><button class="quiet-button" type="button" @click="openRuleDialog()">{{ t('projectAgents.routing.addRule') }}</button></div></div><div v-if="selectedAgent.routingRules?.length" class="project-agent-rule-list"><div v-for="rule in selectedAgent.routingRules" :key="rule.ruleId" class="project-agent-rule-row"><strong>{{ rule.scope }} · {{ rule.priority }}</strong><span>{{ rule.workKind || rule.reason || t('projectAgents.notReported') }} · {{ rule.executorIds?.join(', ') || t('projectAgents.notReported') }}</span><button v-if="rule.enabled" class="quiet-button" type="button" :disabled="Boolean(recruitmentBusy)" @click="disableRule(rule)">{{ t('projectAgents.routing.disable') }}</button></div></div><p v-else class="project-agent-muted">{{ t('projectAgents.routing.empty') }}</p><small class="project-agent-note">{{ t('projectAgents.routing.priorityNote') }}</small></section>
          </ProjectAgentDetailState>
        </div>

        <div class="project-agent-detail-source" data-detail-section="learning">
          <ProjectAgentDetailState v-bind="detailState('learning')" @retry="refreshDetails">
            <section class="project-agent-detail-section"><div class="project-agent-section-heading"><h4>{{ t('projectAgents.sections.learning') }}</h4><span>{{ selectedLearning.length }}</span></div><div v-if="selectedLearning.length" class="project-agent-learning-list"><article v-for="[key, evidence] in selectedLearning" :key="key" class="project-agent-learning-card"><header><strong>{{ key }}</strong><i>{{ learningLabel(evidence) }}</i></header><small v-if="evidence.personalProjectId || evidence.workKind || evidence.executor || evidence.modelStrategy">{{ projectName(evidence.personalProjectId) }} · {{ evidence.workKind || t('projectAgents.notReported') }} · {{ evidence.executor || t('projectAgents.notReported') }} / {{ evidence.modelStrategy ? strategyLabel(evidence.modelStrategy) : t('projectAgents.notReported') }}</small><p>{{ t('projectAgents.learning.samples', { count: evidence.sampleCount }) }} · {{ t('projectAgents.learning.recent', { count: learningRecent(evidence) }) }}</p><small>{{ evidence.decayBasis || t('projectAgents.learning.decayUnreported') }} · {{ formatDate(evidence.updatedAt) }}</small><div v-if="evidence.outcomes" class="project-agent-inline-list"><span v-for="(count, outcome) in evidence.outcomes" :key="outcome" v-show="count !== undefined">{{ outcome }} · {{ count ?? t('projectAgents.notReported') }}</span><span v-if="evidence.score !== null && evidence.score !== undefined">{{ t('projectAgents.learning.score', { score: scoreValue(evidence) }) }}</span></div><ul v-if="evidence.evidence?.length" class="project-agent-evidence-list"><li v-for="item in evidence.evidence" :key="`${item.evidenceId}:${item.kind}:${item.occurredAt}`"><span>{{ item.kind }} · {{ item.count ?? 0 }} · {{ item.summary || t('projectAgents.notReported') }}</span><button v-if="item.evidenceId" class="quiet-button" type="button" :disabled="learningBusy === item.evidenceId" @click="updateLearning(evidence, 'ignore', item.evidenceId)">{{ t('projectAgents.learning.ignore') }}</button></li></ul><div v-if="evidence.learningKey" class="project-agent-learning-actions"><button class="quiet-button" type="button" :disabled="learningBusy === evidence.learningKey || !evidence.personalProjectId || !evidence.workKind || !evidence.executor" @click="updateLearning(evidence, 'reset')">{{ t('projectAgents.learning.reset') }}</button></div></article></div><p v-else class="project-agent-muted">{{ t('projectAgents.learning.empty') }}</p><small class="project-agent-note">{{ t('projectAgents.learning.note') }}</small></section>
          </ProjectAgentDetailState>
        </div>

        <section class="project-agent-detail-section"><h4>{{ t('projectAgents.sections.memory') }}</h4><p>{{ selectedAgent.memoryScope ?? t('projectAgents.notReported') }}</p><small>{{ t('projectAgents.detail.memoryNote') }}</small></section>
      </aside>
      <div v-else class="project-agent-detail-placeholder">{{ t('projectAgents.detail.choose') }}</div>
    </div>

    <ProjectAgentDialog :open="dialogOpen" :agent="editingAgent" :projects="projects" :default-project-id="dialogDefaultProjectId" :personal-space-id="activeSpaceId" @close="closeDialog" @saved="recordSaved" />
    <AgentAssignmentDialog :open="assignmentDialogOpen" :agent="editingAgent" :assignment="assignmentTarget" :action="assignmentAction" :projects="projects" :available-agents="agents" :default-project-id="dialogDefaultProjectId" @close="closeAssignment" @saved="assignmentSaved" @changed="assignmentChanged" />
    <ExecutorRoutingDialog :open="executorDialogOpen" :mode="executorDialogMode" :personal-space-id="activeSpaceId" :executor="editingExecutor" :rule="editingRule" :projects="projects" :available-executors="selectedAgent?.executorDirectory ?? []" @close="closeExecutorDialog" @saved="executorDialogSaved" />
  </section>
</template>

<style scoped>
.project-agent-header-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.project-agents-view { min-height: 0; display: flex; flex-direction: column; gap: 12px; padding: 18px 32px 20px; overflow: hidden; }
.project-agents-header, .project-agent-section-heading, .project-agent-section-tools, .project-agent-detail-actions, .project-agent-assignment-card header, .project-agent-task-card header, .project-agent-learning-card header, .project-agent-day-detail header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.project-agents-header h2 { color: #283a31; font-size: 18px; }
.project-agents-header-meta { color: #7a847d; font-size: 10px; }
.project-agents-summary { display: flex; gap: 18px; padding: 2px 0 4px; color: #58675d; font-size: 12px; line-height: 1.5; }
.project-agents-summary span:first-child { color: #2f493b; font-weight: 700; }
.project-agent-add { min-height: 40px; border: 0; border-radius: 8px; background: #344c3d; color: #fff; padding: 9px 14px; font-size: 12px; font-weight: 600; cursor: pointer; }
.project-agent-add:hover { background: #2b4234; }
.project-agent-add:focus-visible, .quiet-button:focus-visible { outline: 2px solid #91a398; outline-offset: 2px; }
.project-agent-add:disabled { cursor: not-allowed; opacity: .55; }
.project-agents-toolbar { display: grid; grid-template-columns: minmax(240px, 320px) minmax(200px, 1fr) auto; align-items: center; gap: 12px; }
.project-agents-search input { width: 100%; min-height: 44px; border: 1px solid #cfd7d1; border-radius: 8px; background: #fff; color: #2e3932; padding: 10px 12px; font-size: 13px; }
.project-agents-search input:focus-visible { outline: 2px solid #91a398; outline-offset: 1px; }
.project-agents-status-filter { display: flex; gap: 3px; padding: 3px; border: 1px solid #d8ded9; border-radius: 8px; background: #f5f7f5; }
.project-agents-status-filter button, .quiet-button { min-height: 34px; border: 0; border-radius: 6px; background: transparent; color: #58675d; padding: 7px 10px; font-size: 12px; cursor: pointer; }
.project-agents-status-filter button[aria-pressed='true'] { background: #fff; color: #315440; box-shadow: 0 1px 3px rgb(39 57 47 / 12%); font-weight: 700; }
.project-agents-directory { min-height: 0; flex: 1; display: grid; grid-template-columns: minmax(360px, .94fr) minmax(390px, 1.06fr); overflow: hidden; border: 1px solid #cfd7d1; border-radius: 10px; background: #fff; }
.project-agent-list { min-width: 0; min-height: 0; overflow: auto; border-right: 1px solid #dfe4e0; }
.project-agent-row { width: 100%; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 5px 14px; padding: 14px 16px; border: 0; border-bottom: 1px solid #e6eae7; background: #fff; color: inherit; text-align: left; }
.project-agent-row:hover { background: #f7f9f7; }
.project-agent-row.selected { background: #edf3ef; }
.project-agent-row:focus-visible { position: relative; z-index: 1; outline: 2px solid #91a398; outline-offset: -3px; }
.project-agent-row-heading { min-width: 0; display: flex; align-items: center; gap: 7px; }
.project-agent-occupation-emoji { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; min-width: 1.2em; font-size: 15px; line-height: 1; }
.project-agent-row-heading strong { overflow: hidden; color: #293b31; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.project-agent-row-heading i, .project-agent-assignment-card header i, .project-agent-task-card header i, .project-agent-learning-card header i { flex: 0 0 auto; border-radius: 999px; background: #e6eae7; color: #66716a; padding: 2px 7px; font-size: 9px; font-style: normal; font-weight: 700; }
.project-agent-row-heading i.is-active { background: #e1eee6; color: #2f6947; }
.project-agent-row-heading i.is-archived { background: #eeeae5; color: #75695d; }
.project-agent-kind { background: #eef2f7 !important; color: #53647b !important; }
.project-agent-row-id { color: #8a938d; font-size: 9px; overflow-wrap: anywhere; text-align: right; }
.project-agent-row-projects { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 4px; }
.project-agent-row-projects b, .project-agent-tags span, .project-agent-inline-list span { border-radius: 999px; background: #eef1ef; color: #5f6b64; padding: 3px 7px; font-size: 9px; font-weight: 650; }
.project-agent-row-projects em { color: #8a938d; font-size: 9px; font-style: normal; }
.project-agent-row-responsibility { grid-column: 1 / -1; overflow: hidden; color: #59645d; font-size: 11px; line-height: 1.5; text-overflow: ellipsis; white-space: nowrap; }
.project-agent-row-work { grid-column: 1 / -1; color: #59645d; font-size: 10px; line-height: 1.5; }
.project-agent-work-dot { display: inline-block; width: 6px; height: 6px; margin-right: 4px; border-radius: 50%; background: #4b8d63; }
.project-agent-row-capabilities { grid-column: 1 / -1; min-height: 20px; display: flex; flex-wrap: wrap; gap: 5px; }
.project-agent-row-capabilities b { border-radius: 999px; background: #f1f3f1; color: #68736c; padding: 3px 7px; font-size: 9px; font-weight: 650; }
.project-agent-detail { min-width: 0; min-height: 0; padding: 20px; overflow: auto; container-type: inline-size; }
.employee-project-overview { margin: 22px 0; padding-bottom: 18px; border-bottom: 1px solid #e1e6e2; }
.employee-project-overview-heading { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; }
.employee-project-overview-heading h4 { margin: 0; color: #33483c; font-size: 14px; }
.employee-project-overview-heading p, .employee-project-overview-hint { margin: 5px 0 0; color: #58675d; font-size: 12px; line-height: 1.6; }
.employee-project-overview-hint { margin-top: 12px; }
.employee-assigned-projects { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 2px 20px; margin-top: 12px; }
.employee-assigned-projects a { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 0; color: #315c43; font-size: 13px; line-height: 1.5; text-decoration: none; }
.employee-assigned-projects a:hover { text-decoration: underline; text-underline-offset: 3px; }
.employee-assigned-projects a:focus-visible { outline: 2px solid #91a398; outline-offset: 3px; }
.employee-assigned-projects a span { overflow-wrap: anywhere; }
.employee-assigned-projects svg { flex-shrink: 0; }
@container (max-width: 480px) { .employee-assigned-projects { grid-template-columns: minmax(0, 1fr); } }
.project-agent-detail > header { display: grid; grid-template-columns: minmax(0, 1fr) max-content; align-items: flex-start; gap: 16px; padding-bottom: 16px; border-bottom: 1px solid #e1e6e2; }
.project-agent-detail-heading { min-width: 0; }.project-agent-detail h3 { color: #263b30; font-size: 17px; line-height: 1.32; text-wrap: balance; }.project-agent-detail header p { max-width: 72ch; margin-top: 5px; color: #7a847d; font-size: 10px; line-height: 1.5; overflow-wrap: anywhere; }.project-agent-detail-actions { display: grid; grid-auto-flow: column; grid-auto-columns: 78px; justify-content: end; gap: 8px; }.project-agent-detail-actions .quiet-button { width: 78px; white-space: nowrap; }
.project-agent-detail-meta, .project-agent-compact-meta { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 16px 0 0; }
.project-agent-detail-meta div, .project-agent-compact-meta div { min-width: 0; }
.project-agent-detail-meta dt, .project-agent-compact-meta dt, .project-agent-detail-section h4 { color: #7a847d; font-size: 9px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
.project-agent-detail-meta dd, .project-agent-compact-meta dd { margin: 4px 0 0; overflow-wrap: anywhere; color: #39483f; font-size: 11px; }
.project-agent-detail-meta dd small { display: block; margin-top: 3px; color: #818a84; font-size: 9px; line-height: 1.4; }
.project-agent-detail-section { margin-top: 22px; }
.project-agent-detail-section.is-responsibility { padding: 14px; border-radius: 10px; background: #f2f5f2; }
.project-agent-detail-section p, .project-agent-detail-section li { color: #4f5c54; font-size: 11px; line-height: 1.65; }
.project-agent-tags, .project-agent-inline-list { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 9px; }
.project-agent-muted { color: #8a928d !important; }
.project-agent-detail-notice { margin: 12px 0 0; padding: 8px 10px; border-radius: 7px; background: #f5f5f1; color: #6f705f !important; }
.project-agent-detail-placeholder, .project-agents-state { min-height: 240px; display: grid; place-content: center; justify-items: center; gap: 8px; color: #737d76; font-size: 11px; text-align: center; }
.project-agents-state { flex: 1; border: 1px solid #d9dfda; border-radius: 10px; background: #fafbfa; }
.project-agents-state strong { color: #36473e; font-size: 14px; }
.project-agents-state p { max-width: 52ch; line-height: 1.6; }
.project-agents-state.is-error { color: #8b3f38; }
.project-agent-assignment-list, .project-agent-task-list, .project-agent-learning-list, .project-agent-recruitment-list { display: grid; gap: 8px; margin-top: 9px; }
.project-agent-task-list { min-width: 0; grid-template-columns: minmax(0, 1fr); }
.project-agent-execution-summary { min-width: 0; margin-top: 13px; padding-top: 12px; border-top: 1px solid #dfe5e0; }
.project-agent-worker-event-evidence { margin-top: 13px; padding: 10px 10px 0; border: 1px dashed #d8dfd9; border-radius: 8px; background: #f8faf8; }
.project-agent-execution-summary .project-agent-section-heading { gap: 8px; }
.project-agent-execution-summary h5 { margin: 0; color: #65736a; font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
.project-agent-execution-summary-table-wrap { box-sizing: border-box; width: 100%; max-width: 100%; margin-top: 7px; overflow-x: auto; overscroll-behavior-inline: contain; border: 1px solid #dce3de; border-radius: 8px; background: #fff; }
.project-agent-execution-summary-table-wrap:focus-visible { outline: 2px solid #91a398; outline-offset: 2px; }
.project-agent-execution-summary-table { width: 100%; min-width: 1040px; border-collapse: collapse; table-layout: fixed; color: #4f5e54; font-size: 12px; line-height: 1.5; }
.project-agent-execution-summary-table th, .project-agent-execution-summary-table td { min-width: 0; padding: 8px 9px; border-right: 1px solid #e6ebe7; border-bottom: 1px solid #e6ebe7; overflow-wrap: anywhere; text-align: left; vertical-align: top; }
.project-agent-execution-summary-table tr > :last-child { border-right: 0; }
.project-agent-execution-summary-table tbody tr:last-child > * { border-bottom: 0; }
.project-agent-execution-summary-table thead th { background: #f3f6f4; color: #65736a; font-size: 11px; font-weight: 750; letter-spacing: .04em; text-transform: uppercase; }
.project-agent-execution-summary-table thead th:nth-child(1) { width: 14%; }
.project-agent-execution-summary-table thead th:nth-child(2) { width: 20%; }
.project-agent-execution-summary-table thead th:nth-child(3) { width: 13%; }
.project-agent-execution-summary-table thead th:nth-child(4) { width: 15%; }
.project-agent-execution-summary-table thead th:nth-child(5) { width: 15%; }
.project-agent-execution-summary-table thead th:nth-child(6) { width: 12%; }
.project-agent-execution-summary-table tbody tr:hover { background: #fafcfb; }
.project-agent-execution-summary-table tbody th { color: #3f5647; font-weight: 700; }
.project-agent-execution-summary-table tbody strong, .project-agent-execution-summary-table tbody span, .project-agent-execution-summary-table tbody small, .project-agent-execution-summary-table tbody a { display: block; }
.project-agent-execution-summary-table tbody small { margin-top: 3px; color: #647168; font-size: 11px; font-weight: 500; }
.project-agent-execution-summary-table tbody .project-agent-reporter-label { margin-top: 8px; }
.project-agent-execution-summary-table tbody a { margin-top: 3px; color: #386c50; text-decoration-thickness: 1px; text-underline-offset: 2px; }
.project-agent-execution-summary-table tbody a:focus-visible { border-radius: 2px; outline: 2px solid #91a398; outline-offset: 2px; }
.project-agent-execution-worker { display: flex !important; align-items: center; gap: 4px; }
.project-agent-execution-summary-row i { display: inline-flex; border-radius: 999px; background: #e6eae7; color: #66716a; padding: 2px 6px; font-size: 11px; font-style: normal; font-weight: 700; }
.project-agent-execution-summary-row i.is-completed { background: #e1eee6; color: #2f6947; }
.project-agent-execution-summary-row i.is-failed { background: #f7e9e6; color: #8c4f49; }
.project-agent-execution-summary-row i.is-cancelled { background: #eeeae5; color: #75695d; }
.project-agent-execution-summary-list { display: grid; margin: 7px 0 0; padding: 0; list-style: none; }
.project-agent-worker-event-row { min-width: 0; padding: 10px 0; border-top: 1px solid #e6ebe7; }.project-agent-worker-event-row:first-child { border-top: 0; }
.project-agent-worker-event-row header { align-items: flex-start; }
.project-agent-worker-event-row header strong { min-width: 0; display: flex; align-items: center; gap: 5px; overflow-wrap: anywhere; color: #3f5647; font-size: 10px; }
.project-agent-worker-event-row header strong small { display: inline; margin: 0; color: #89948c; font-size: 8px; font-weight: 500; }
.project-agent-worker-event-row header i { flex: 0 0 auto; border-radius: 999px; background: #e6eae7; color: #66716a; padding: 2px 6px; font-size: 8px; font-style: normal; font-weight: 700; }
.project-agent-worker-event-row header i.is-completed { background: #e1eee6; color: #2f6947; }
.project-agent-worker-event-row header i.is-failed { background: #f7e9e6; color: #8c4f49; }
.project-agent-worker-event-row header i.is-cancelled { background: #eeeae5; color: #75695d; }
.project-agent-execution-summary-meta { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px 10px; margin: 8px 0 0; }
.project-agent-execution-summary-meta div { min-width: 0; }
.project-agent-execution-summary-meta dt { color: #89948c; font-size: 8px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
.project-agent-execution-summary-meta dd { margin: 2px 0 0; overflow-wrap: anywhere; color: #4f5e54; font-size: 9px; line-height: 1.45; }
.project-agent-execution-summary-meta dd small { display: block; margin-top: 2px; color: #89948c; font-size: 8px; }
.project-agent-assignment-card, .project-agent-task-card, .project-agent-learning-card { min-width: 0; padding: 11px 12px; border: 1px solid #e0e6e1; border-radius: 9px; background: #fbfcfb; }
.project-agent-recruitment-card { padding: 11px 12px; border: 1px solid #e0e6e1; border-radius: 9px; background: #fbfcfb; }
.project-agent-assignment-card header strong, .project-agent-task-card header strong, .project-agent-learning-card header strong { color: #33483a; font-size: 11px; }
.project-agent-card-actions { display: flex; align-items: center; justify-content: flex-end; gap: 4px; flex-wrap: wrap; }
.project-agent-assignment-card p, .project-agent-task-card p, .project-agent-learning-card p { margin: 7px 0 0; }
.project-agent-assignment-card small, .project-agent-task-card small, .project-agent-learning-card small { display: block; margin-top: 6px; color: #818a84; font-size: 9px; line-height: 1.5; }
.project-agent-assignment-card header i.is-ended, .project-agent-assignment-card header i.is-replaced { background: #eeeae5; color: #75695d; }
.project-agent-strategy-note, .project-agent-execution-line { display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; margin-top: 8px; color: #7a847d; font-size: 9px; }
.project-agent-strategy-note strong, .project-agent-execution-line strong { color: #53685a; font-size: 10px; }
.project-agent-strategy-note small { flex-basis: 100%; color: #8c5d54; }
.project-agent-routing-decision { display: grid; gap: 5px; margin-top: 10px; padding: 9px 10px; border: 1px solid #dce5de; border-radius: 7px; background: #f3f7f3; color: #65736a; font-size: 9px; }
.project-agent-routing-decision .project-agent-section-heading { align-items: baseline; gap: 8px; }
.project-agent-routing-decision .project-agent-section-heading strong { color: #3f604b; font-size: 10px; }
.project-agent-routing-decision small { color: #65736a; line-height: 1.45; }
.project-agent-blocked { color: #8c5d54 !important; }
.project-agent-task-card header { align-items: flex-start; }
.project-agent-task-card header small { margin-top: 3px; }
.project-agent-task-card header i { background: #eef2f7; color: #53647b; }
.project-agent-task-card header i.is-completed { background: #e1eee6; color: #2f6947; }
.project-agent-task-card header i.is-failed { background: #f7e9e6; color: #8c4f49; }
.project-agent-task-card header i.is-cancelled { background: #eeeae5; color: #75695d; }
.project-agent-heatmap-viewport { min-width: 0; max-width: 100%; overflow-x: clip; contain: layout inline-size paint; }
.project-agent-heatmap { width: 100%; max-width: 100%; display: grid; grid-auto-flow: column; grid-template-rows: repeat(7, minmax(10px, 1fr)); grid-auto-columns: minmax(10px, 1fr); gap: 3px; margin-top: 9px; overflow-x: auto; padding: 0; }
.project-agent-heat-cell { appearance: none; box-sizing: border-box; aspect-ratio: 1; min-width: 9px; margin: 0; padding: 0; border: 1px solid #dfe6e0; border-radius: 3px; background: #f2f4f2; }
.project-agent-heat-cell.intensity-1 { background: #dce9df; }.project-agent-heat-cell.intensity-2 { background: #b9d3bf; }.project-agent-heat-cell.intensity-3 { background: #87b493; }.project-agent-heat-cell.intensity-4 { background: #548466; }.project-agent-heat-cell:focus-visible, .project-agent-heat-cell.selected { border: 2px solid #2f5740; outline: none; box-shadow: none; }
.project-agent-day-detail { margin-top: 10px; padding: 10px; border-radius: 8px; background: #f6f8f6; }.project-agent-day-detail ul { margin: 8px 0 0; padding-left: 17px; }.project-agent-day-detail li { margin-top: 6px; }.project-agent-day-detail li strong, .project-agent-day-detail li span, .project-agent-day-detail li small { display: block; }.project-agent-day-detail li span { color: #66736b; font-size: 9px; }.project-agent-day-detail li small { color: #7e8981; font-size: 9px; }
.project-agent-client-list, .project-agent-rule-list { display: grid; gap: 5px; margin-top: 9px; }.project-agent-client-row, .project-agent-rule-row { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 7px; align-items: center; padding: 8px 10px; border-radius: 7px; background: #f7f9f7; color: #68736c; font-size: 9px; }.project-agent-client-row strong, .project-agent-rule-row strong { color: #43584a; font-size: 10px; }.project-agent-client-row small { grid-column: 1 / -1; color: #8a938d; }
.project-agent-executor-list { display: grid; gap: 5px; margin-top: 9px; }.project-agent-executor-row { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 7px; align-items: center; padding: 8px 10px; border-radius: 7px; background: #f7f9f7; color: #68736c; font-size: 9px; }.project-agent-executor-row strong { color: #43584a; font-size: 10px; }.project-agent-executor-row small { grid-column: 1 / -1; color: #8a938d; }
.project-agent-learning-card header i { background: #f1f3f1; color: #6c776f; }.project-agent-evidence-list { margin: 8px 0 0; padding-left: 17px; }.project-agent-evidence-list li { color: #768179; font-size: 9px; }.project-agent-learning-actions { display: flex; gap: 6px; margin-top: 8px; }.project-agent-note { display: block; margin-top: 9px; color: #818a84; font-size: 9px; line-height: 1.5; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
@media (max-width: 1180px) { .project-agents-toolbar { grid-template-columns: minmax(220px, 280px) 1fr; }.project-agents-status-filter { grid-column: 1 / -1; justify-self: start; }.project-agents-directory { grid-template-columns: minmax(320px, .9fr) minmax(330px, 1fr); }.project-agent-detail-meta, .project-agent-compact-meta { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@container (max-width: 420px) { .project-agent-detail > header { grid-template-columns: minmax(0, 1fr); }.project-agent-detail-actions { justify-content: start; } }
@media (max-width: 760px) { .project-agents-view { padding: 14px 16px 18px; overflow: auto; }.project-agents-header, .project-agents-summary, .project-agent-section-heading, .project-agent-assignment-card header { align-items: flex-start; flex-wrap: wrap; }.project-agents-toolbar { grid-template-columns: minmax(0, 1fr); }.project-agents-project-filter, .project-agents-search, .project-agents-status-filter { grid-column: 1; }.project-agents-status-filter { width: 100%; justify-self: stretch; flex-wrap: wrap; }.project-agents-directory { flex: 0 0 auto; grid-template-columns: minmax(0, 1fr); overflow: visible; }.project-agent-list { max-height: 340px; border-right: 0; border-bottom: 1px solid #dfe4e0; }.project-agent-detail { min-height: 520px; padding: 16px; }.project-agent-client-row, .project-agent-rule-row, .project-agent-executor-row { grid-template-columns: minmax(0, 1fr); align-items: start; }.project-agent-client-row small, .project-agent-executor-row small { grid-column: 1; }.project-agent-execution-summary-meta { grid-template-columns: minmax(0, 1fr); }.project-agent-worker-event-row header { gap: 8px; } }
</style>
