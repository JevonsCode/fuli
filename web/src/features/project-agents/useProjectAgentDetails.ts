import { computed, ref, watch, type Ref } from 'vue'
import { deleteJson, getJson, patchJson, postJson } from '@/api/client'
import { isAgentTaskDataComplete, taskHasAgent } from '@/features/agent-profile/agent-work-summary'
import { t } from '@/i18n'
import type {
  ProjectAgentExecutorRef,
  ProjectAgentLearningEvidence,
  ProjectAgentRecord,
  ProjectAgentRecruitmentRecord,
  ProjectAgentRoutingRule,
  ProjectAgentTaskRecord,
} from '@/types'
import { activityRange, normalizeActivity } from './activity-evidence'
import {
  assignmentValues,
  clientValues,
  dedupeById,
  executorValues,
  learningValues,
  recruitmentBelongsTo,
  recruitmentValues,
  routingValues,
  taskValues,
} from './agent-roster-records'
import { normalizeTask, unknownRecord } from './task-evidence'

const DETAIL_SOURCES = [
  'assignments', 'tasks', 'activity', 'recruitments',
  'executors', 'routingRules', 'learning',
] as const
export type DetailSource = typeof DETAIL_SOURCES[number]
type DetailSourceStatus = 'idle' | 'loading' | 'ready' | 'error'
interface DetailSourceState { status: DetailSourceStatus; error: string }

interface Roster {
  agents: Ref<ProjectAgentRecord[]>
  update: (agentId: string, change: (agent: ProjectAgentRecord) => ProjectAgentRecord) => void
}

function actionIdempotencyKey(prefix: string) {
  const suffix = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `${prefix}:${suffix}`
}

function assertReportedCollection(value: unknown, keys: string[], allowRecord = false) {
  if (Array.isArray(value)) return
  const record = unknownRecord(value)
  const reported = keys.some((key) => Array.isArray(record[key])
    || (allowRecord && typeof record[key] === 'object' && record[key] !== null && !Array.isArray(record[key])))
  if (!reported) throw new Error(t('projectAgents.detail.sectionUnavailable'))
}

/**
 * One Agent's management workspace: seven sources read on their own, each
 * with its own loading or error state, and the human decisions taken there
 * (learning evidence, recruitments, executor authorization, routing rules,
 * test-role cleanup). Every write re-reads the sources it can change.
 */
export function useProjectAgentDetails(
  roster: Roster,
  agent: Ref<ProjectAgentRecord | null>,
  spaceId: Ref<string>,
  link: { project: Ref<string>; task: Ref<string> },
) {
  const agentId = computed(() => agent.value?.agentId ?? '')
  const states = ref<Record<string, Record<DetailSource, DetailSourceState>>>({})
  const taskListPartial = ref<Record<string, boolean>>({})
  const loading = ref(false)
  const notice = ref('')
  const cleanupBusy = ref(false)
  const learningBusy = ref('')
  const learningBusyAction = ref<'ignore' | 'reset' | ''>('')
  const recruitmentBusy = ref('')
  const recruitmentBusyAction = ref<'approve' | 'cancel' | 'disable' | ''>('')
  const executorBusy = ref('')
  const executorBusyAction = ref<'authorize' | 'revoke' | ''>('')
  let version = 0
  // The task list also follows the link's project and task scope, which can
  // change on its own (same Agent, another ?project= or ?task=).
  let taskVersion = 0

  function emptyStates(status: DetailSourceStatus = 'idle'): Record<DetailSource, DetailSourceState> {
    return Object.fromEntries(DETAIL_SOURCES.map((source) => [source, { status, error: '' }])) as Record<DetailSource, DetailSourceState>
  }
  function setState(id: string, source: DetailSource, state: DetailSourceState) {
    states.value = { ...states.value, [id]: { ...(states.value[id] ?? emptyStates()), [source]: state } }
  }
  /** Several sources shown together report the worst of their states. */
  function state(source: DetailSource | DetailSource[]): DetailSourceState {
    const sources = Array.isArray(source) ? source : [source]
    const list = sources.map((item) => states.value[agentId.value]?.[item] ?? { status: 'idle' as const, error: '' })
    return list.find(({ status }) => status === 'error')
      ?? list.find(({ status }) => status === 'loading')
      ?? list.find(({ status }) => status === 'idle')
      ?? { status: 'ready', error: '' }
  }
  function isCurrent(requested: number, id: string, space: string) {
    return requested === version && id === agentId.value && space === spaceId.value
  }

  async function loadScopedTasks(space: string, id: string, project: string, taskId: string) {
    // The provider's Agent filter only matches participants. Read the authorized
    // space and apply the shared ownership rules so owner-only tasks remain visible.
    const query = new URLSearchParams({ personalSpaceId: space, limit: '200' })
    if (project) query.set('personalProjectId', project)
    const value = await getJson<unknown>(`/api/project-agent-tasks?${query}`)
    assertReportedCollection(value, ['tasks', 'items'])
    const belongs = (task: ProjectAgentTaskRecord) =>
      (!task.personalSpaceId || task.personalSpaceId === space)
      && (!project || task.personalProjectId === project)
      && taskHasAgent(task, id)
    const tasks = taskValues(value).filter(belongs)
    if (taskId && !tasks.some(task => task.taskId === taskId)) {
      const task = normalizeTask(await getJson<unknown>(`/api/project-agent-tasks/${encodeURIComponent(taskId)}?${query}`))
      if (task && belongs(task)) tasks.unshift(task)
    }
    return { tasks, partial: !isAgentTaskDataComplete(value) }
  }

  function apply(person: ProjectAgentRecord, source: DetailSource, value: unknown, space: string) {
    let patch: Partial<ProjectAgentRecord>
    switch (source) {
      case 'assignments':
        assertReportedCollection(value, ['assignments', 'items'])
        patch = { assignments: assignmentValues(value, person) }
        break
      case 'tasks':
        assertReportedCollection(value, ['tasks', 'items'])
        taskListPartial.value = { ...taskListPartial.value, [person.agentId]: unknownRecord(value).partial === true }
        patch = { tasks: taskValues(value) }
        break
      case 'activity': {
        const activity = normalizeActivity(value, { agentId: person.agentId, personalSpaceId: space })
        if (!activity) throw new Error(t('projectAgents.detail.sectionUnavailable'))
        patch = { activity }
        break
      }
      case 'recruitments':
        assertReportedCollection(value, ['recruitments', 'items'])
        patch = { recruitments: recruitmentValues(value, space).filter((item) => recruitmentBelongsTo(item, person)) }
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
    roster.update(person.agentId, (item) => ({ ...item, ...patch }))
  }

  function taskScope() { return { project: link.project.value, task: link.task.value } }
  function isCurrentTaskScope(requested: number, scope: { project: string; task: string }) {
    return requested === taskVersion && scope.project === link.project.value && scope.task === link.task.value
  }

  /** Re-reads only the task list, for a new project or task scope of the same Agent. */
  async function refreshTasks() {
    const person = agent.value
    const space = spaceId.value
    if (!person || !space) return
    const id = person.agentId
    const requested = version
    const scope = taskScope()
    const taskRequested = ++taskVersion
    setState(id, 'tasks', { status: 'loading', error: '' })
    const current = () => isCurrent(requested, id, space) && isCurrentTaskScope(taskRequested, scope)
    try {
      const value = await loadScopedTasks(space, id, scope.project, scope.task)
      if (!current()) return
      apply(person, 'tasks', value, space)
      setState(id, 'tasks', { status: 'ready', error: '' })
    } catch (cause) {
      if (!current()) return
      setState(id, 'tasks', {
        status: 'error',
        error: cause instanceof Error ? cause.message : t('projectAgents.detail.sectionUnavailable'),
      })
    }
  }

  async function refresh() {
    const person = agent.value
    const space = spaceId.value
    if (!person || !space) return
    const id = person.agentId
    const requested = ++version
    loading.value = true
    notice.value = ''
    states.value = { ...states.value, [id]: emptyStates('loading') }
    const query = new URLSearchParams({ personalSpaceId: space, agentId: id })
    const range = activityRange()
    const activityQuery = new URLSearchParams({ personalSpaceId: space, agentId: id, fromDate: range.fromDate, toDate: range.toDate })
    const spaceQuery = encodeURIComponent(space)
    const scope = taskScope()
    const taskRequested = ++taskVersion
    const requests: Record<DetailSource, Promise<unknown>> = {
      assignments: getJson<unknown>(`/api/project-agent-assignments?${query}`),
      tasks: loadScopedTasks(space, id, scope.project, scope.task),
      activity: getJson<unknown>(`/api/project-agent-activity?${activityQuery}`),
      recruitments: getJson<unknown>(`/api/project-agent-recruitments?personalSpaceId=${spaceQuery}`),
      executors: getJson<unknown>(`/api/executors?personalSpaceId=${spaceQuery}`),
      routingRules: getJson<unknown>(`/api/executor-routing-rules?personalSpaceId=${spaceQuery}`),
      learning: getJson<unknown>(`/api/project-agent-routing-learning?${query}`),
    }
    await Promise.all(DETAIL_SOURCES.map(async (source) => {
      try {
        const value = await requests[source]
        if (!isCurrent(requested, id, space)) return
        if (source === 'tasks' && !isCurrentTaskScope(taskRequested, scope)) return
        apply(person, source, value, space)
        setState(id, source, { status: 'ready', error: '' })
      } catch (cause) {
        if (!isCurrent(requested, id, space)) return
        if (source === 'tasks' && !isCurrentTaskScope(taskRequested, scope)) return
        setState(id, source, {
          status: 'error',
          error: cause instanceof Error ? cause.message : t('projectAgents.detail.sectionUnavailable'),
        })
      }
    }))
    if (isCurrent(requested, id, space)) loading.value = false
  }

  // Reads once the Agent is known (a direct link waits for the roster), and
  // again when the page moves to another Agent or space. A new project or task
  // scope for the same Agent re-reads its task list only; anything else in the
  // URL (the open tab) reads nothing.
  watch([agentId, spaceId, link.project, link.task], ([id, space], previous) => {
    if (!id || !space) return
    const [previousId, previousSpace] = previous ?? []
    if (id !== previousId || space !== previousSpace) void refresh()
    else void refreshTasks()
  }, { immediate: true })

  async function updateLearning(evidence: ProjectAgentLearningEvidence, action: 'ignore' | 'reset', contributionEvidenceId?: string) {
    const evidenceId = action === 'ignore' ? contributionEvidenceId : evidence.learningKey ?? evidence.modelStrategyKey
    const person = agent.value
    if (!evidenceId || !person || !spaceId.value || learningBusy.value) return
    if (action === 'reset' && (!evidence.personalProjectId || !evidence.workKind || !evidence.executor)) {
      notice.value = t('projectAgents.learning.resetUnavailable')
      return
    }
    learningBusy.value = evidenceId
    learningBusyAction.value = action
    try {
      await patchJson(`/api/project-agent-learning/${encodeURIComponent(evidenceId)}`, {
        action,
        personalSpaceId: spaceId.value,
        personalProjectId: evidence.personalProjectId,
        agentId: person.agentId,
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
      await refresh()
    } catch (cause) {
      notice.value = cause instanceof Error ? cause.message : t('projectAgents.learning.updateFailed')
    } finally {
      learningBusy.value = ''
      learningBusyAction.value = ''
    }
  }

  async function decideRecruitment(recruitment: ProjectAgentRecruitmentRecord, decision: 'approve' | 'cancel') {
    if (!spaceId.value || recruitmentBusy.value) return
    recruitmentBusy.value = recruitment.recruitmentId
    recruitmentBusyAction.value = decision
    try {
      await postJson('/api/project-agent-recruitments/decision', {
        personalSpaceId: spaceId.value,
        personalProjectId: recruitment.personalProjectId,
        recruitmentId: recruitment.recruitmentId,
        expectedRevision: recruitment.revision ?? 0,
        decision,
        reason: t(`projectAgents.recruitment.${decision}Reason`),
      })
      await refresh()
    } catch (cause) {
      notice.value = cause instanceof Error ? cause.message : t('projectAgents.recruitment.decisionFailed')
    } finally {
      recruitmentBusy.value = ''
      recruitmentBusyAction.value = ''
    }
  }

  async function authorizeExecutor(executor: ProjectAgentExecutorRef, status: 'authorized' | 'revoked') {
    if (!spaceId.value || executorBusy.value) return
    executorBusy.value = executor.executorId
    executorBusyAction.value = status === 'authorized' ? 'authorize' : 'revoke'
    try {
      await postJson('/api/executors/authorization', {
        personalSpaceId: spaceId.value,
        executorId: executor.executorId,
        status,
        expectedRevision: executor.permissionRevision ?? 0,
        idempotencyKey: actionIdempotencyKey(`console-executor:${executor.executorId}:${status}`),
        reason: t(`projectAgents.routing.${status === 'authorized' ? 'authorizeReason' : 'revokeReason'}`),
      })
      await refresh()
    } catch (cause) {
      notice.value = cause instanceof Error ? cause.message : t('projectAgents.routing.authorizationFailed')
    } finally {
      executorBusy.value = ''
      executorBusyAction.value = ''
    }
  }

  async function disableRule(rule: ProjectAgentRoutingRule) {
    if (!spaceId.value || !rule.ruleId || recruitmentBusy.value) return
    recruitmentBusy.value = `rule:${rule.ruleId}`
    recruitmentBusyAction.value = 'disable'
    try {
      await patchJson(`/api/executor-routing-rules/${encodeURIComponent(rule.ruleId)}`, {
        personalSpaceId: spaceId.value,
        ruleId: rule.ruleId,
        expectedRevision: rule.revision ?? 0,
        status: 'disabled',
        idempotencyKey: `console-rule:${rule.ruleId}:disable`,
        reason: 'Console disabled explicit routing rule',
      })
      await refresh()
    } catch (cause) {
      notice.value = cause instanceof Error ? cause.message : t('projectAgents.routing.updateFailed')
    } finally {
      recruitmentBusy.value = ''
      recruitmentBusyAction.value = ''
    }
  }

  /** Removes an archived test role; true once the Provider has removed it. */
  async function cleanupTestAgent(person: ProjectAgentRecord) {
    if (!person.profile.cleanupEligible) return false
    cleanupBusy.value = true
    loading.value = true
    try {
      await deleteJson(`/api/project-agents/${encodeURIComponent(person.agentId)}?personalSpaceId=${encodeURIComponent(person.personalSpaceId)}&reason=${encodeURIComponent('archived test role')}`)
      return true
    } catch (cause) {
      notice.value = cause instanceof Error ? cause.message : t('projectAgents.source.cleanupFailed')
      return false
    } finally {
      cleanupBusy.value = false
      loading.value = false
    }
  }

  function executorSaved(executor: ProjectAgentExecutorRef) {
    if (!agentId.value) return
    roster.update(agentId.value, (item) => ({
      ...item, executorDirectory: dedupeById([...(item.executorDirectory ?? []), executor], ({ executorId }) => executorId),
    }))
  }
  function ruleSaved(rule: ProjectAgentRoutingRule) {
    if (!agentId.value) return
    roster.update(agentId.value, (item) => ({
      ...item, routingRules: dedupeById([...(item.routingRules ?? []), rule], ({ ruleId }) => ruleId),
    }))
  }

  return {
    state, taskListPartial, loading, notice, refresh,
    cleanupBusy, learningBusy, learningBusyAction, recruitmentBusy, recruitmentBusyAction, executorBusy, executorBusyAction,
    updateLearning, decideRecruitment, authorizeExecutor, disableRule, cleanupTestAgent, executorSaved, ruleSaved,
  }
}
