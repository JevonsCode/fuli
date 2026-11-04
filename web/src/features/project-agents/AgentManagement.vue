<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { UiIconButton } from '@/ui'
import { agentDisplayName } from '@/features/agent-profile/profile-model'
import { employeeTemplateIdForAgent, employeeTemplates } from '@/features/employees/catalog'
import EmployeeScopeDialog from '@/features/employees/EmployeeScopeDialog.vue'
import AgentAssignmentDialog from '@/features/project-agents/AgentAssignmentDialog.vue'
import { activityWeeks } from '@/features/project-agents/activity-calendar'
import { assignmentsFor, currentAssignmentsFor, dedupeById, NON_TERMINAL_TASK_STATUSES } from '@/features/project-agents/agent-roster-records'
import ExecutorRoutingDialog from '@/features/project-agents/ExecutorRoutingDialog.vue'
import ProjectAgentDetailState from '@/features/project-agents/ProjectAgentDetailState.vue'
import ProjectAgentTaskCard from '@/features/project-agents/ProjectAgentTaskCard.vue'
import TaskReason from '@/features/project-agents/TaskReason.vue'
import { formatDate, policyLabel, recruitmentPositionLabel, recruitmentStatusLabel, sourceLabel, strategyLabel, taskStatusLabel } from '@/features/project-agents/task-labels'
import { useProjectAgentDetails, type DetailSource } from '@/features/project-agents/useProjectAgentDetails'
import { useProjectAgentRoster } from '@/features/project-agents/useProjectAgentRoster'
import { currentLocale, t } from '@/i18n'
import { formatDateTime } from '@/lib/date-time'
import { useConsoleStore } from '@/stores/console'
import type {
  ProjectAgentActivityDay,
  ProjectAgentActivityResult,
  ProjectAgentAssignmentRecord,
  ProjectAgentExecutorPolicy,
  ProjectAgentExecutorRef,
  ProjectAgentRecord,
  ProjectAgentRoutingRule,
} from '@/types'

// What an FLA page shows of one Agent's management (Jevons 11-04: one flat page,
// nothing a person cannot read): 工作记录 takes its activity and finished work,
// 设置 its projects, who runs its work, and a recruitment waiting on the person.
// A link that names a task (?task=, ?project=) reveals that task, finished or not.
export type ManageSection = 'work' | 'projects' | 'activity' | 'recruitment' | 'execution'

const props = withDefaults(defineProps<{ spaceId: string; agentId: string; sections?: ManageSection[]; finishedOnly?: boolean }>(), {
  sections: () => ['activity', 'work', 'projects', 'recruitment', 'execution'],
})
const shows = (section: ManageSection) => props.sections.includes(section)

const store = useConsoleStore()
const route = useRoute()
const router = useRouter()
const spaceId = computed(() => props.spaceId)
const roster = useProjectAgentRoster(spaceId)
const agents = roster.agents
const agent = computed(() => roster.find(props.agentId) ?? null)
const linkedProject = computed(() => typeof route.query.project === 'string' ? route.query.project : '')
const linkedTask = computed(() => typeof route.query.task === 'string' ? route.query.task : '')
const details = useProjectAgentDetails(roster, agent, spaceId, { project: linkedProject, task: linkedTask })

const projects = computed(() => store.state?.personalProjects ?? [])
const projectById = computed(() => new Map(projects.value.map((project) => [project.project_id, project])))
function projectName(projectId: string | null | undefined) {
  if (!projectId) return t('projectAgents.notReported')
  return projectById.value.get(projectId)?.profile.name ?? projectId
}

const pageLoading = computed(() => !agent.value && (roster.loading.value || (!store.state
  && (store.runtimeStatus === 'idle' || store.runtimeStatus === 'loading'))))
const pageError = computed(() => agent.value ? '' : roster.error.value || (!store.state && store.runtimeStatus === 'error'
  ? store.feedback?.message || t('projectAgents.loadError') : ''))
function retryPage() {
  if (!store.state) void store.refresh()
  else void roster.load()
}
onMounted(() => {
  if (store.runtimeStatus === 'idle') void store.refresh()
})

const name = computed(() => (agent.value ? agentDisplayName(agent.value) : props.agentId))

const employeeId = computed(() => agent.value ? employeeTemplateIdForAgent(agent.value) : null)
const employee = computed(() => employeeTemplates.value.find((entry) => entry.id === employeeId.value))
const responsibleProjects = computed(() => {
  if (!agent.value) return []
  return employee.value?.managedProjects ?? currentAssignmentsFor(agent.value).map((assignment) => ({
    id: assignment.personalProjectId, name: projectName(assignment.personalProjectId),
  }))
})
const employeeProjects = computed(() => responsibleProjects.value
  .filter((project) => projectById.value.get(project.id)?.profile.lifecycle !== 'archived'))
// A finished recruitment is Bole's record; here only what waits on the person.
const recruitments = computed(() => (agent.value?.recruitments ?? []).filter(({ status }) => status === 'awaiting_confirmation'))
// Open work is on the page already, in the FLA's task sheets.
const shownTasks = computed(() => (agent.value?.tasks ?? []).filter(task => !props.finishedOnly
  || !NON_TERMINAL_TASK_STATUSES.has(task.status) || task.taskId === linkedTask.value))

// Each new task link (a new ?task= or ?project= scope) is located once, as
// soon as its task list is read and its card is on the page. A refresh or a
// tab switch is not a new link and never scrolls.
const pageRoot = ref<HTMLElement | null>(null)
let pendingLocate = ''
watch([linkedProject, linkedTask], ([, task]) => { pendingLocate = task }, { immediate: true })
const taskListStatus = computed(() => details.state('tasks').status)
watch([linkedProject, linkedTask, taskListStatus, () => agent.value?.tasks], async () => {
  const task = pendingLocate
  if (!task || taskListStatus.value !== 'ready') return
  await nextTick()
  const target = [...(pageRoot.value?.querySelectorAll<HTMLElement>('[id^="task-"]') ?? [])].find(({ id }) => id === `task-${task}`)
  if (!target || pendingLocate !== task) return
  pendingLocate = ''
  target.scrollIntoView?.({ block: 'nearest' })
}, { immediate: true })

const activityDay = ref('')
watch(() => agent.value?.agentId, () => { activityDay.value = '' })
const activity = computed(() => agent.value?.activity ?? null)
const selectedActivityDay = computed(() => activity.value?.days.find(({ date }) => date === activityDay.value) ?? null)
function activityIntensity(day: ProjectAgentActivityDay, result: ProjectAgentActivityResult) {
  const maximum = Math.max(...result.days.map(({ total }) => total), 0)
  return !maximum || !day.total ? 0 : Math.min(4, Math.ceil((day.total / maximum) * 4))
}
const activityCalendar = computed(() => activityWeeks(activity.value?.days ?? []))
const activityTotal = computed(() => (activity.value?.days ?? []).reduce((sum, { total }) => sum + total, 0))
// Weekday names from a known Monday (2024-01-01), in the page's locale.
const weekdayLabels = computed(() => Array.from({ length: 7 }, (_, index) => formatDateTime(
  `2024-01-0${index + 1}T00:00:00Z`, currentLocale(), { weekday: 'short', timeZone: 'UTC' }, { missing: '' })))
// A calendar wider than its card opens on the latest weeks.
const calendar = ref<HTMLElement | null>(null)
watch([calendar, activityCalendar], async () => {
  await nextTick()
  if (calendar.value) calendar.value.scrollLeft = calendar.value.scrollWidth
})
function formatMonth(month: string) {
  return formatDateTime(`${month}-01T00:00:00Z`, currentLocale(), { month: 'short', timeZone: 'UTC' }, { missing: '' })
}
function formatDateOnly(value: string | null | undefined) {
  return formatDateTime(value && `${value}T00:00:00Z`, currentLocale(), { month: 'short', day: 'numeric', timeZone: 'UTC' }, {
    missing: t('projectAgents.notReported'),
    invalid: value ?? undefined,
  })
}

function sourceState(source: DetailSource) { return details.state(source) }
function loadingLabel(source: DetailSource) { return t(`projectAgents.detail.loading.${source}`) }
function policyIsLocked(policy: ProjectAgentExecutorPolicy | null | undefined) { return policy?.mode === 'locked' }
function policyAllowList(policy: ProjectAgentExecutorPolicy | null | undefined): ProjectAgentExecutorRef[] {
  if (!policy) return []
  if (policy.allowList?.length) return policy.allowList
  const ids = policy.mode === 'locked' ? policy.lockedExecutorIds : policy.preferredExecutorIds
  return (ids ?? []).map((executorId) => ({ executorId }) satisfies ProjectAgentExecutorRef)
}
// Dialogs: change an assignment, register an executor or rule, and (for
// employees) choose the projects they manage.
const assignmentDialogOpen = ref(false)
const assignmentAction = ref<'assign' | 'end' | 'replace'>('assign')
const assignmentTarget = ref<ProjectAgentAssignmentRecord | null>(null)
const executorDialogOpen = ref(false)
const executorDialogMode = ref<'executor' | 'rule'>('executor')
const editingExecutor = ref<ProjectAgentExecutorRef | null>(null)
const editingRule = ref<ProjectAgentRoutingRule | null>(null)
const scopeDialogOpen = ref(false)
const dialogDefaultProjectId = computed(() => linkedProject.value
  || agent.value?.assignments?.find(({ status }) => status === 'active')?.personalProjectId
  || agent.value?.personalProjectId
  || projects.value[0]?.project_id
  || null)

function openAssignment(assignment: ProjectAgentAssignmentRecord | null = null, action: 'assign' | 'end' | 'replace' = 'assign') {
  if (action === 'assign' && employeeId.value) { scopeDialogOpen.value = true; return }
  assignmentTarget.value = assignment
  assignmentAction.value = action
  assignmentDialogOpen.value = true
}
function closeAssignment() { assignmentDialogOpen.value = false; assignmentTarget.value = null; assignmentAction.value = 'assign' }
function assignmentSaved(assignment: ProjectAgentAssignmentRecord) {
  if (agent.value) roster.update(agent.value.agentId, (item) => ({
    ...item, assignments: dedupeById([...(item.assignments ?? []), assignment], ({ assignmentId }) => assignmentId),
  }))
  closeAssignment()
}
function assignmentChanged() { closeAssignment(); void details.refresh() }
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
function closeExecutorDialog() { executorDialogOpen.value = false; editingExecutor.value = null; editingRule.value = null }
function executorDialogSaved(value: ProjectAgentExecutorRef | ProjectAgentRoutingRule) {
  if (executorDialogMode.value === 'executor') details.executorSaved(value as ProjectAgentExecutorRef)
  else details.ruleSaved(value as ProjectAgentRoutingRule)
  closeExecutorDialog()
}
async function employeeScopeSaved() {
  await roster.load()
  void details.refresh()
}
async function cleanup(person: ProjectAgentRecord) {
  if (await details.cleanupTestAgent(person)) void router.replace('/project-agents/manage')
}
</script>

<template>
  <section ref="pageRoot" class="project-agent-manage" :aria-label="name">
    <div class="@container grid w-full gap-4">
      <GrowthLoading v-if="pageLoading" :label="!store.state ? t('common.status.loadingConsole') : t('projectAgents.loading')" />
      <div v-else-if="pageError" class="ui-card project-agents-state is-error" role="alert">
        <p>{{ pageError }}</p>
        <Button size="sm" variant="outline" @click="retryPage">{{ t('projectAgents.retry') }}</Button>
      </div>
      <p v-else-if="!agent" class="ui-card project-agents-state" role="status">{{ t('agentProfiles.unavailable') }}</p>
      <template v-else>
        <p v-if="details.notice.value" class="project-agent-detail-notice" role="status">{{ details.notice.value }}</p>

        <div class="project-agent-detail">
          <div v-if="shows('work')" class="project-agent-panel" data-manage-panel="work">
            <Card as="section" class="project-agent-card-section" data-detail-section="tasks">
              <ProjectAgentDetailState v-bind="sourceState('tasks')" :label="loadingLabel('tasks')" @retry="details.refresh">
                <p v-if="details.taskListPartial.value[agent.agentId]" class="project-agent-muted" data-task-partial>{{ t('agentProfiles.partial') }}</p>
                <div class="project-agent-section-heading"><h2>{{ t('agentProfiles.workRecord') }}</h2><div class="project-agent-section-tools"><span>{{ shownTasks.length }}</span><UiIconButton icon="refresh" size="sm" :label="t('projectAgents.detail.refresh')" data-detail-refresh :disabled="details.loading.value" @click="details.refresh()" /></div></div>
                <div v-if="shownTasks.length" class="project-agent-task-list">
                  <ProjectAgentTaskCard v-for="task in shownTasks" :key="task.taskId" :task="task" :project-name="projectName(task.personalProjectId)" :agents="agents" :personal-space-id="spaceId" :linked="task.taskId === linkedTask" @changed="details.refresh()" />
                </div>
                <p v-else-if="!details.taskListPartial.value[agent.agentId]" class="project-agent-muted">{{ t('projectAgents.detail.noTasks') }}</p>
              </ProjectAgentDetailState>
            </Card>
          </div>

          <div v-if="shows('projects')" class="project-agent-panel" data-manage-panel="projects">
            <Card v-if="employeeId" as="section" class="project-agent-card-section employee-project-overview" aria-labelledby="employee-project-overview-title">
              <div class="employee-project-overview-heading">
                <div><h2 id="employee-project-overview-title">{{ employee?.management?.mode === 'all' ? t('employees.scope.continuousAll') : t('employees.scope.label') }}</h2><p>{{ t('employees.assignedCount', { count: employeeProjects.length }) }}</p></div>
                <Button size="sm" data-employee-manage-projects @click="scopeDialogOpen = true">{{ t('employees.manageProjects') }}</Button>
              </div>
              <div v-if="employeeProjects.length" class="employee-assigned-projects">
                <RouterLink v-for="project in employeeProjects" :key="project.id" :to="{ query: { project: project.id } }">
                  <span>{{ project.name }}</span>
                  <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M4 10h12m-5-5 5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg>
                </RouterLink>
              </div>
              <p v-else class="employee-project-overview-hint">{{ t('employees.manageHint') }}</p>
            </Card>
            <Card as="section" class="project-agent-card-section" data-detail-section="assignments">
              <ProjectAgentDetailState v-bind="sourceState('assignments')" :label="loadingLabel('assignments')" @retry="details.refresh">
                <div class="project-agent-section-heading"><h2>{{ t('projectAgents.sections.assignments') }}</h2><div class="project-agent-section-tools"><span>{{ assignmentsFor(agent).length }}</span><Button size="sm" variant="outline" data-assignment-assign @click="openAssignment()">{{ t('projectAgents.assignmentDialog.assign') }}</Button></div></div>
                <div v-if="assignmentsFor(agent).length" class="project-agent-assignment-list">
                  <article v-for="assignment in assignmentsFor(agent)" :key="assignment.assignmentId" class="project-agent-assignment-card">
                    <header><strong>{{ projectName(assignment.personalProjectId) }}</strong><div class="project-agent-card-actions"><Badge :variant="assignment.status === 'active' ? 'success' : 'secondary'">{{ t(`projectAgents.assignmentStatus.${assignment.status}`) }}</Badge><Button size="sm" variant="ghost" v-if="assignment.status === 'active'" @click="openAssignment(assignment, 'end')">{{ t('projectAgents.assignmentDialog.end') }}</Button><Button size="sm" variant="ghost" v-if="assignment.status === 'active'" @click="openAssignment(assignment, 'replace')">{{ t('projectAgents.assignmentDialog.replace') }}</Button></div></header>
                    <p>{{ assignment.responsibility || t('projectAgents.notReported') }}</p>
                    <small v-if="assignment.scope">{{ t('projectAgents.fields.scope') }} · {{ assignment.scope }}</small>
                    <small>{{ formatDate(assignment.assignedAt) }} → {{ assignment.endedAt ? formatDate(assignment.endedAt) : t(`projectAgents.assignmentStatus.${assignment.status}`) }}</small>
                    <div v-if="assignment.workKinds?.length" class="project-agent-inline-list"><span v-for="workKind in assignment.workKinds" :key="workKind">{{ workKind }}</span></div>
                    <div class="project-agent-strategy-note"><span>{{ t('projectAgents.fields.assignmentModel') }}</span><strong>{{ strategyLabel(assignment.modelStrategyOverride) }} · {{ policyLabel(assignment.executorPolicyOverride) }}</strong><small v-if="policyIsLocked(assignment.executorPolicyOverride) && !policyAllowList(assignment.executorPolicyOverride).length">{{ t('projectAgents.strategy.lockedUnavailable') }}</small></div>
                    <div v-if="policyAllowList(assignment.executorPolicyOverride).length" class="project-agent-tags"><span v-for="executor in policyAllowList(assignment.executorPolicyOverride)" :key="executor.executorId">{{ executor.label || executor.executorId }}</span></div>
                    <small v-if="assignment.reason">{{ t('projectAgents.fields.reason') }} · {{ assignment.reason }}</small>
                  </article>
                </div>
                <p v-else class="project-agent-muted">{{ t('projectAgents.detail.noAssignments') }}</p>
              </ProjectAgentDetailState>
            </Card>
          </div>

          <div v-if="shows('activity')" class="project-agent-panel" data-manage-panel="activity">
            <Card as="section" class="project-agent-card-section" data-detail-section="activity">
              <ProjectAgentDetailState v-bind="sourceState('activity')" :label="loadingLabel('activity')" @retry="details.refresh">
                <div class="project-agent-section-heading"><h2>{{ t('projectAgents.sections.activity') }}</h2><span v-if="activity?.days.length" data-activity-total>{{ t('projectAgents.activity.total', { count: activityTotal }) }}</span></div>
                <div v-if="activity?.days.length" class="project-agent-heatmap-wrap">
                  <!-- Weeks as columns (Monday on top), sized to the card: a year
                       fills the width, a short range keeps readable cells. -->
                  <div ref="calendar" class="project-agent-calendar project-agent-heatmap-viewport" :style="{ '--weeks': activityCalendar.length }">
                    <div class="project-agent-calendar-months" aria-hidden="true"><span v-for="week in activityCalendar" :key="week.key">{{ week.month ? formatMonth(week.month) : '' }}</span></div>
                    <div class="project-agent-calendar-weekdays" aria-hidden="true"><span v-for="(label, index) in weekdayLabels" :key="index">{{ index % 2 === 0 ? label : '' }}</span></div>
                    <div class="project-agent-heatmap" role="list" :aria-label="t('projectAgents.activity.aria')">
                      <template v-for="week in activityCalendar" :key="week.key">
                        <template v-for="(day, index) in week.days" :key="day?.date ?? `${week.key}:${index}`">
                          <button v-if="day" type="button" role="listitem" :class="['project-agent-heat-cell', `intensity-${activityIntensity(day, activity)}`, { selected: activityDay === day.date }]" :title="`${formatDateOnly(day.date)} · ${day.total}`" :aria-label="`${formatDateOnly(day.date)} · ${day.total}`" :aria-pressed="activityDay === day.date" @click="activityDay = day.date"><span class="ui-sr-only">{{ formatDateOnly(day.date) }} · {{ day.total }}</span></button>
                          <span v-else class="project-agent-heat-pad" aria-hidden="true" />
                        </template>
                      </template>
                    </div>
                  </div>
                  <p class="project-agent-calendar-legend" :title="t('projectAgents.activity.legend')">
                    <span>{{ t('projectAgents.activity.less') }}</span>
                    <span v-for="level in 5" :key="level" :class="['project-agent-heat-swatch', `intensity-${level - 1}`]" aria-hidden="true" />
                    <span>{{ t('projectAgents.activity.more') }}</span>
                    <span class="ui-sr-only">{{ t('projectAgents.activity.legend') }}</span>
                  </p>
                  <article v-if="selectedActivityDay" class="project-agent-day-detail">
                    <header><strong>{{ formatDateOnly(selectedActivityDay.date) }}</strong><span>{{ selectedActivityDay.total }}</span></header>
                    <p v-if="!selectedActivityDay.tasks?.length" class="project-agent-muted">{{ t('projectAgents.activity.noTasks') }}</p>
                    <ul v-else><li v-for="task in selectedActivityDay.tasks" :key="task.taskId"><strong>{{ task.title }}</strong><span>{{ taskStatusLabel(task.status) }} · {{ projectName(task.personalProjectId) }}</span><small>{{ task.summary || t('projectAgents.notReported') }}</small></li></ul>
                  </article>
                </div>
                <p v-else class="project-agent-muted">{{ t('projectAgents.activity.empty') }}</p>
              </ProjectAgentDetailState>
            </Card>
          </div>

          <div v-if="shows('recruitment') && recruitments.length" class="project-agent-panel" data-manage-panel="recruitment">
            <Card as="section" class="project-agent-card-section" data-detail-section="recruitment" aria-labelledby="project-agent-recruitment-heading">
              <ProjectAgentDetailState v-bind="sourceState('recruitments')" :label="loadingLabel('recruitments')" @retry="details.refresh">
                <div class="project-agent-section-heading"><h2 id="project-agent-recruitment-heading">{{ t('projectAgents.sections.recruitment') }}</h2><span>{{ recruitments.length }}</span></div>
                <div v-if="recruitments.length" class="project-agent-recruitment-list">
                  <article v-for="recruitment in recruitments" :key="recruitment.recruitmentId" class="project-agent-recruitment-card">
                    <header><strong>{{ recruitmentPositionLabel(recruitment.positionKind) }} · {{ recruitment.workKind || t('projectAgents.notReported') }}</strong><div class="project-agent-card-actions"><Badge :variant="recruitment.status === 'awaiting_confirmation' ? 'warning' : 'secondary'" data-recruitment-status>{{ recruitmentStatusLabel(recruitment.status) }}</Badge><Button size="sm" variant="outline" v-if="recruitment.status === 'awaiting_confirmation'" data-recruitment-approve :disabled="Boolean(details.recruitmentBusy.value)" :loading="details.recruitmentBusy.value === recruitment.recruitmentId && details.recruitmentBusyAction.value === 'approve'" :loading-label="t('projectAgents.recruitment.approving')" @click="details.decideRecruitment(recruitment, 'approve')">{{ t('projectAgents.recruitment.approve') }}</Button><Button size="sm" variant="ghost" v-if="recruitment.status === 'awaiting_confirmation'" :disabled="Boolean(details.recruitmentBusy.value)" :loading="details.recruitmentBusy.value === recruitment.recruitmentId && details.recruitmentBusyAction.value === 'cancel'" :loading-label="t('projectAgents.recruitment.cancelling')" @click="details.decideRecruitment(recruitment, 'cancel')">{{ t('projectAgents.recruitment.cancel') }}</Button></div></header>
                    <dl class="project-agent-compact-meta"><div><dt>{{ t('projectAgents.recruitment.hr') }}</dt><dd>{{ recruitment.hrAgentId || t('projectAgents.notReported') }}</dd></div><div><dt>{{ t('projectAgents.recruitment.trigger') }}</dt><dd>{{ sourceLabel(recruitment.triggerSourceApplication) }}</dd></div><div><dt>{{ t('projectAgents.recruitment.reason') }}</dt><dd><TaskReason :reason="recruitment.reason || recruitment.reasonCode" :fallback="t('projectAgents.notReported')" /></dd></div><div><dt>{{ t('projectAgents.recruitment.time') }}</dt><dd>{{ formatDate(recruitment.fulfilledAt || recruitment.createdAt) }}</dd></div></dl>
                    <small>{{ t('projectAgents.recruitment.testSource') }} · {{ recruitment.testSource || t('projectAgents.notReported') }}</small>
                  </article>
                </div>
              </ProjectAgentDetailState>
            </Card>
          </div>

          <div v-if="shows('execution')" class="project-agent-panel" data-manage-panel="execution">
            <div class="project-agent-execution-grid">
              <Card as="section" class="project-agent-card-section" data-detail-section="executors">
                <ProjectAgentDetailState v-bind="sourceState('executors')" :label="loadingLabel('executors')" @retry="details.refresh">
                  <div class="project-agent-section-heading"><h2>{{ t('projectAgents.sections.strategy') }}</h2><span>{{ strategyLabel(agent.profile.defaultModelStrategy) }} · {{ policyLabel(agent.profile.executorPolicy) }}</span></div>
                  <p class="project-agent-muted">{{ t('projectAgents.strategy.providerNeutral') }}</p>
                  <div v-if="policyAllowList(agent.profile.executorPolicy).length" class="project-agent-tags"><span v-for="executor in policyAllowList(agent.profile.executorPolicy)" :key="executor.executorId">{{ executor.label || executor.executorId }}</span></div>
                  <p v-else-if="policyIsLocked(agent.profile.executorPolicy)" class="project-agent-blocked">{{ t('projectAgents.strategy.lockedUnavailable') }}</p>
                  <p v-else class="project-agent-muted">{{ t('projectAgents.strategy.noAllowList') }}</p>
                  <div class="project-agent-section-tools"><Button size="sm" variant="outline" data-executor-add @click="openExecutorDialog()">{{ t('projectAgents.routing.addExecutor') }}</Button></div>
                  <div v-if="agent.executorDirectory?.length" class="project-agent-executor-list">
                    <div v-for="executor in agent.executorDirectory" :key="executor.executorId" class="project-agent-executor-row">
                      <strong>{{ executor.displayName || executor.label || executor.executorId }}</strong>
                      <span>{{ executor.provider || t('projectAgents.notReported') }} / {{ executor.model || t('projectAgents.notReported') }}</span>
                      <span>{{ executor.globalPriority ?? t('projectAgents.notReported') }}</span>
                      <small>{{ executor.registrationStatus || t('projectAgents.notReported') }} · {{ executor.permissionStatus || t('projectAgents.notReported') }} · {{ executor.preflightStatus || t('projectAgents.strategy.availabilityUnreported') }} · {{ executor.healthStatus || t('projectAgents.notReported') }}</small>
                      <div class="project-agent-card-actions">
                        <Button size="sm" variant="ghost" data-executor-edit @click="openExecutorDialog(executor)">{{ t('projectAgents.routing.editExecutor') }}</Button>
                        <Button v-if="executor.permissionStatus !== 'authorized'" size="sm" variant="ghost" data-executor-authorize :disabled="Boolean(details.executorBusy.value)" :loading="details.executorBusy.value === executor.executorId && details.executorBusyAction.value === 'authorize'" :loading-label="t('projectAgents.routing.authorizing')" @click="details.authorizeExecutor(executor, 'authorized')">{{ t('projectAgents.routing.authorize') }}</Button>
                        <Button v-else size="sm" variant="ghost" data-executor-revoke :disabled="Boolean(details.executorBusy.value)" :loading="details.executorBusy.value === executor.executorId && details.executorBusyAction.value === 'revoke'" :loading-label="t('projectAgents.routing.revoking')" @click="details.authorizeExecutor(executor, 'revoked')">{{ t('projectAgents.routing.revoke') }}</Button>
                      </div>
                    </div>
                  </div>
                </ProjectAgentDetailState>
              </Card>
              <Card as="section" class="project-agent-card-section" data-detail-section="routing">
                <ProjectAgentDetailState v-bind="sourceState('routingRules')" :label="loadingLabel('routingRules')" @retry="details.refresh">
                  <div class="project-agent-section-heading"><h2>{{ t('projectAgents.sections.routing') }}</h2><div class="project-agent-section-tools"><span>{{ agent.routingRules?.length ?? 0 }}</span><Button size="sm" variant="outline" data-rule-add @click="openRuleDialog()">{{ t('projectAgents.routing.addRule') }}</Button></div></div>
                  <div v-if="agent.routingRules?.length" class="project-agent-rule-list">
                    <div v-for="rule in agent.routingRules" :key="rule.ruleId" class="project-agent-rule-row">
                      <strong>{{ rule.scope }} · {{ rule.priority }}</strong>
                      <span>{{ rule.workKind || rule.reason || t('projectAgents.notReported') }} · {{ rule.executorIds?.join(', ') || t('projectAgents.notReported') }}</span>
                      <Button v-if="rule.enabled" size="sm" variant="ghost" data-rule-disable :disabled="Boolean(details.recruitmentBusy.value)" :loading="details.recruitmentBusy.value === `rule:${rule.ruleId}` && details.recruitmentBusyAction.value === 'disable'" :loading-label="t('projectAgents.routing.disabling')" @click="details.disableRule(rule)">{{ t('projectAgents.routing.disable') }}</Button>
                    </div>
                  </div>
                  <p v-else class="project-agent-muted">{{ t('projectAgents.routing.empty') }}</p>
                  <small class="project-agent-note">{{ t('projectAgents.routing.priorityNote') }}</small>
                </ProjectAgentDetailState>
              </Card>
            </div>
          </div>

          <Button v-if="shows('execution') && agent.profile.cleanupEligible" variant="outline" size="sm" class="project-agent-cleanup" data-agent-cleanup :disabled="details.loading.value" :loading="details.cleanupBusy.value" :loading-label="t('projectAgents.source.cleanupLoading')" @click="cleanup(agent)">{{ t('projectAgents.source.cleanup') }}</Button>
        </div>
      </template>
    </div>

    <template v-if="agent">
      <AgentAssignmentDialog :open="assignmentDialogOpen" :agent="agent" :assignment="assignmentTarget" :action="assignmentAction" :projects="projects" :available-agents="agents" :default-project-id="dialogDefaultProjectId" @close="closeAssignment" @saved="assignmentSaved" @changed="assignmentChanged" />
      <ExecutorRoutingDialog :open="executorDialogOpen" :mode="executorDialogMode" :personal-space-id="spaceId" :executor="editingExecutor" :rule="editingRule" :projects="projects" :available-executors="agent.executorDirectory ?? []" @close="closeExecutorDialog" @saved="executorDialogSaved" />
      <EmployeeScopeDialog v-if="employeeId" :open="scopeDialogOpen" :personal-space-id="spaceId" :projects="projects" :template-id="employeeId" @close="scopeDialogOpen = false" @saved="employeeScopeSaved" />
    </template>
  </section>
</template>

<style src="@/features/agent-profile/agent-profile.css" />
<style scoped src="@/features/project-agents/AgentManagement.css"></style>
