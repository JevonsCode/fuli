import { normalizeActivity } from './activity-evidence'
import {
  arrayOf,
  normalizeAssignment,
  normalizePolicy,
  normalizeStrategy,
  normalizeTask,
  stringOf,
  unknownRecord,
  valueOf,
} from './task-evidence'
import { taskHasAgent } from '@/features/agent-profile/agent-work-summary'
import type { AgentWorkbenchEntry, WorkbenchStatus } from '@/features/agent-profile/agent-workbench'
import type {
  ConversationSourceApplication,
  ProjectAgentAssignmentRecord,
  ProjectAgentClientEvidence,
  ProjectAgentExecutorRef,
  ProjectAgentLearningEvidence,
  ProjectAgentRecord,
  ProjectAgentRecruitmentRecord,
  ProjectAgentRoutingRule,
  ProjectAgentStatus,
  ProjectAgentTaskRecord,
  ProjectAgentTaskStatus,
  ProjectAgentType,
  ProjectAgentWorkStatus,
} from '@/types'

// The 编排 roster and its per-Agent detail sources, read from the console API
// (camelCase or the Provider's snake_case) into ProjectAgentRecord shapes.
// Several roster rows may describe one Agent (one per project); mergeAgents
// folds them into one record per Agent.

export const NON_TERMINAL_TASK_STATUSES = new Set<ProjectAgentTaskStatus>([
  'awaiting_recruitment', 'backlog', 'queued', 'running', 'paused', 'awaiting_review', 'blocked',
])

export function assignmentsFor(agent: ProjectAgentRecord) {
  return agent.assignments ?? (agent.personalProjectId ? [legacyAssignment(agent)] : [])
}

export function currentAssignmentsFor(agent: ProjectAgentRecord) {
  return [...new Map(assignmentsFor(agent).filter((assignment) => assignment.status === 'active')
    .map((assignment) => [assignment.personalProjectId, assignment])).values()]
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

export function currentWork(agent: ProjectAgentRecord) {
  return (agent.tasks ?? []).find((task) => NON_TERMINAL_TASK_STATUSES.has(task.status)) ?? null
}

/** The same current work as the quick look's work line: the open task, else a reported wait, else idle. */
export function currentWorkEntry(agent: ProjectAgentRecord): AgentWorkbenchEntry {
  const task = currentWork(agent)
  const waiting = agent.workStatus === 'blocked' || agent.workStatus === 'queued' ? agent.workStatus : null
  return {
    status: (task?.status ?? waiting ?? 'none') as WorkbenchStatus,
    source: 'tasks',
    taskId: task?.taskId ?? null,
    title: task?.title ?? null,
    lastUpdateAt: task?.updatedAt ?? null,
    reason: null,
    blocker: task?.status === 'blocked' ? task.blocker ?? null : null,
    runningSince: null,
  }
}
function taskBelongsTo(agent: ProjectAgentRecord, task: ProjectAgentTaskRecord) {
  return taskHasAgent(task, agent.agentId)
}
export function attachTasks(items: ProjectAgentRecord[], tasks: ProjectAgentTaskRecord[]) {
  return items.map((agent) => {
    const matching = tasks.filter((task) => taskBelongsTo(agent, task))
    return matching.length ? { ...agent, tasks: dedupeById([...(agent.tasks ?? []), ...matching], ({ taskId }) => taskId) } : agent
  })
}

export function normalizeAgent(value: unknown, spaceId: string): ProjectAgentRecord {
  const record = unknownRecord(value); const rawProfile = unknownRecord(record.profile); const agentId = stringOf(record, 'agentId', 'agent_id') ?? ''
  const createdAt = stringOf(record, 'createdAt', 'created_at') ?? ''; const updatedAt = stringOf(record, 'updatedAt', 'updated_at') ?? createdAt
  const profile = {
    name: stringOf(rawProfile, 'name', 'name') ?? agentId, displayName: stringOf(rawProfile, 'displayName', 'display_name'), responsibility: stringOf(rawProfile, 'responsibility', 'responsibility') ?? '',
    capabilities: arrayOf(rawProfile.capabilities).filter((item): item is string => typeof item === 'string'), initialPreferences: arrayOf(valueOf(rawProfile, 'initialPreferences', 'initial_preferences')).filter((item): item is string => typeof item === 'string'),
    status: (stringOf(rawProfile, 'status', 'status') ?? 'active') as ProjectAgentStatus, occupationEmoji: stringOf(rawProfile, 'occupationEmoji', 'occupation_emoji'), agentType: stringOf(rawProfile, 'agentType', 'agent_type') as ProjectAgentType | undefined,
    workKinds: arrayOf(valueOf(rawProfile, 'workKinds', 'work_kinds')).filter((item): item is string => typeof item === 'string'), defaultModelStrategy: normalizeStrategy(valueOf(rawProfile, 'defaultModelStrategy', 'default_model_strategy')), executorPolicy: normalizePolicy(valueOf(rawProfile, 'executorPolicy', 'executor_policy')),
    allowedClients: arrayOf(valueOf(rawProfile, 'allowedClients', 'allowed_clients')).filter((item): item is ConversationSourceApplication => typeof item === 'string'),
    character: { judgment: String(unknownRecord(rawProfile.character).judgment ?? ''), taste: String(unknownRecord(rawProfile.character).taste ?? ''), personality: String(unknownRecord(rawProfile.character).personality ?? '') }, expectations: stringOf(rawProfile, 'expectations', 'expectations') ?? '',
    testSource: stringOf(rawProfile, 'testSource', 'test_source'), cleanupEligible: valueOf(rawProfile, 'cleanupEligible', 'cleanup_eligible') === true,
  }
  const fallback: ProjectAgentRecord = { agentId, personalSpaceId: stringOf(record, 'personalSpaceId', 'personal_space_id') ?? spaceId, personalProjectId: stringOf(record, 'personalProjectId', 'personal_project_id'), profile, createdAt, updatedAt }
  return {
    ...fallback, memoryScope: stringOf(record, 'memoryScope', 'memory_scope') ?? undefined,
    assignments: Array.isArray(record.assignments)
      ? record.assignments.map((item) => normalizeAssignment(item, fallback)).filter(Boolean) as ProjectAgentAssignmentRecord[] : undefined,
    legacyAgentIds: arrayOf(record.legacyAgentIds ?? record.legacy_agent_ids).filter((item): item is string => typeof item === 'string'),
    recruitments: recruitmentValues(record.recruitments ?? record.recruitmentHistory, spaceId).filter((item) => recruitmentBelongsTo(item, fallback)),
    recruitmentId: stringOf(record, 'recruitmentId', 'recruitment_id'), temporaryTaskId: stringOf(record, 'temporaryTaskId', 'temporary_task_id'), workStatus: stringOf(record, 'workStatus', 'work_status') as ProjectAgentWorkStatus | undefined,
    openTaskCount: typeof record.openTaskCount === 'number' ? record.openTaskCount : typeof record.open_task_count === 'number' ? record.open_task_count : undefined, currentTaskId: stringOf(record, 'currentTaskId', 'current_task_id'),
    observedClients: arrayOf(record.observedClients ?? record.observed_clients).filter((item): item is ConversationSourceApplication => typeof item === 'string'), recruitedAt: stringOf(record, 'recruitedAt', 'recruited_at'),
    recruitmentReason: stringOf(record, 'recruitmentReason', 'recruitment_reason'), recruitmentSourceApplication: stringOf(record, 'recruitmentSourceApplication', 'recruitment_source_application') as ConversationSourceApplication | null,
    isTestRole: Boolean(profile.testSource) || profile.cleanupEligible || record.isTestRole === true || record.is_test_role === true,
    tasks: arrayOf(record.tasks ?? record.taskHistory).map(normalizeTask).filter(Boolean) as ProjectAgentTaskRecord[],
    activity: normalizeActivity(record.activity, { agentId, personalSpaceId: spaceId }),
    clientEvidence: clientValues(record.clientEvidence ?? record.client_evidence), routingRules: routingValues(record.routingRules ?? record.routing_rules), learningEvidence: normalizeLearningMap(record.learningEvidence ?? record.learning_evidence),
  }
}

function normalizeClient(value: unknown): ProjectAgentClientEvidence | null {
  const record = unknownRecord(value); const client = stringOf(record, 'client', 'client'); if (!client) return null; const actual = unknownRecord(valueOf(record, 'actualUse', 'actual_use'))
  return { client: client as ConversationSourceApplication, allowed: record.allowed === true, integrationStatus: stringOf(record, 'integrationStatus', 'integration_status') ?? undefined, actualUse: Object.keys(actual).length ? { count: typeof actual.count === 'number' ? actual.count : 0, lastUsedAt: stringOf(actual, 'lastUsedAt', 'last_used_at') } : null }
}
export function assignmentValues(value: unknown, fallback: ProjectAgentRecord) {
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
export function executorValues(value: unknown): ProjectAgentExecutorRef[] {
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
export function taskValues(value: unknown) { const record = unknownRecord(value); return arrayOf(Array.isArray(value) ? value : record.tasks ?? record.items).map(normalizeTask).filter(Boolean) as ProjectAgentTaskRecord[] }
function normalizeRecruitment(value: unknown, spaceId: string): ProjectAgentRecruitmentRecord | null {
  const record = unknownRecord(value)
  const recruitmentId = stringOf(record, 'recruitmentId', 'recruitment_id')
  if (!recruitmentId) return null
  return {
    recruitmentId,
    personalSpaceId: stringOf(record, 'personalSpaceId', 'personal_space_id') ?? spaceId,
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
export function recruitmentValues(value: unknown, spaceId: string) {
  const record = unknownRecord(value)
  return arrayOf(Array.isArray(value) ? value : record.recruitments ?? record.items)
    .map((item) => normalizeRecruitment(item, spaceId))
    .filter((item): item is ProjectAgentRecruitmentRecord => Boolean(item))
}
export function recruitmentBelongsTo(recruitment: ProjectAgentRecruitmentRecord, agent: ProjectAgentRecord) {
  return recruitment.recruitedAgentId === agent.agentId
    || recruitment.proposedAgentId === agent.agentId
    || recruitment.recruitmentId === agent.recruitmentId
}
export function clientValues(value: unknown) { const record = unknownRecord(value); return arrayOf(Array.isArray(value) ? value : record.clients ?? record.executors ?? record.items).map(normalizeClient).filter(Boolean) as ProjectAgentClientEvidence[] }
export function routingValues(value: unknown) { const record = unknownRecord(value); return arrayOf(Array.isArray(value) ? value : record.rules ?? record.items).map(normalizeRule).filter(Boolean) as ProjectAgentRoutingRule[] }
export function learningValues(value: unknown) { const record = unknownRecord(value); return normalizeLearningMap(record.learningEvidence ?? record.learning_evidence ?? value) }

export function mergeAgents(values: unknown[], spaceId: string) {
  const merged = new Map<string, ProjectAgentRecord>()
  values.map((value) => normalizeAgent(value, spaceId)).forEach((agent) => {
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
export function dedupeById<T>(values: T[], key: (value: T) => string) { return [...new Map(values.map((value) => [key(value), value])).values()] }
export function unique<T>(values: T[]) { return [...new Set(values)] }
