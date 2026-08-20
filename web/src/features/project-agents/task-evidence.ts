import type {
  ConversationSourceApplication,
  ProjectAgentActualExecution,
  ProjectAgentAssignmentRecord,
  ProjectAgentExecutorPolicy,
  ProjectAgentModelStrategy,
  ProjectAgentParallelPlan,
  ProjectAgentRecord,
  ProjectAgentRoutingDecision,
  ProjectAgentTaskEvent,
  ProjectAgentTaskExecutionSummary,
  ProjectAgentTaskRecord,
  ProjectAgentTaskStatus,
} from '@/types'

export type UnknownRecord = Record<string, unknown>

export function unknownRecord(value: unknown): UnknownRecord {
  return value && typeof value === 'object' ? value as UnknownRecord : {}
}

export function valueOf(record: UnknownRecord, camel: string, snake: string) {
  return record[camel] ?? record[snake]
}

export function stringOf(record: UnknownRecord, camel: string, snake: string) {
  const value = valueOf(record, camel, snake)
  return typeof value === 'string' ? value : null
}

export function arrayOf(value: unknown) { return Array.isArray(value) ? value : [] }

export function agentValues(value: unknown) {
  const record = unknownRecord(value)
  return Array.isArray(value) ? value : arrayOf(record.agents ?? record.items)
}

export function normalizeStrategy(value: unknown): ProjectAgentModelStrategy | null {
  if (!value || typeof value !== 'object') return null
  const record = unknownRecord(value)
  return {
    mode: stringOf(record, 'mode', 'mode') as ProjectAgentModelStrategy['mode'] ?? null,
    reasoningEffort: stringOf(record, 'reasoningEffort', 'reasoning_effort') as ProjectAgentModelStrategy['reasoningEffort'] ?? null,
    capabilityHints: arrayOf(valueOf(record, 'capabilityHints', 'capability_hints')).filter((item): item is string => typeof item === 'string'),
  }
}

export function normalizeParallelPlan(value: unknown): ProjectAgentParallelPlan | null {
  if (!value || typeof value !== 'object') return null
  const record = unknownRecord(value)
  return {
    enabled: typeof record.enabled === 'boolean' ? record.enabled : null,
    independentVerification: typeof valueOf(record, 'independentVerification', 'independent_verification') === 'boolean'
      ? valueOf(record, 'independentVerification', 'independent_verification') as boolean : null,
    conflictFreeScopes: typeof valueOf(record, 'conflictFreeScopes', 'conflict_free_scopes') === 'boolean'
      ? valueOf(record, 'conflictFreeScopes', 'conflict_free_scopes') as boolean : null,
    reason: stringOf(record, 'reason', 'reason'),
    workstreamBoundaries: arrayOf(valueOf(record, 'workstreamBoundaries', 'workstream_boundaries'))
      .filter((item): item is string => typeof item === 'string'),
  }
}

export function normalizePolicy(value: unknown): ProjectAgentExecutorPolicy | null {
  if (!value || typeof value !== 'object') return null
  const record = unknownRecord(value)
  const allowList = arrayOf(valueOf(record, 'allowList', 'allow_list')).map((item) => {
    if (typeof item === 'string') return { executorId: item }
    const executor = unknownRecord(item)
    return {
      executorId: stringOf(executor, 'executorId', 'executor_id') ?? '',
      label: stringOf(executor, 'label', 'label'), provider: stringOf(executor, 'provider', 'provider'),
      model: stringOf(executor, 'model', 'model'), client: stringOf(executor, 'client', 'client') as ConversationSourceApplication | null,
    }
  }).filter(({ executorId }) => executorId)
  const lockedExecutorIds = arrayOf(valueOf(record, 'lockedExecutorIds', 'locked_executor_ids')).filter((item): item is string => typeof item === 'string')
  const preferredExecutorIds = arrayOf(valueOf(record, 'preferredExecutorIds', 'preferred_executor_ids')).filter((item): item is string => typeof item === 'string')
  return {
    mode: (stringOf(record, 'mode', 'mode') ?? 'flexible') as ProjectAgentExecutorPolicy['mode'],
    allowList,
    lockedExecutorIds,
    preferredExecutorIds,
  }
}

export function normalizeActual(value: unknown): ProjectAgentActualExecution | null {
  if (!value || typeof value !== 'object') return null
  const record = unknownRecord(value)
  const actual = {
    executor: stringOf(record, 'executor', 'executor'),
    provider: stringOf(record, 'provider', 'provider') ?? stringOf(record, 'actualModelProvider', 'actual_model_provider'),
    model: stringOf(record, 'model', 'model') ?? stringOf(record, 'actualModel', 'actual_model'),
    client: stringOf(record, 'client', 'client') ?? stringOf(record, 'sourceApplication', 'source_application'),
    rule: stringOf(record, 'rule', 'rule'), fallback: stringOf(record, 'fallback', 'fallback'),
    reportedAt: stringOf(record, 'reportedAt', 'reported_at'),
  }
  return [actual.executor, actual.provider, actual.model, actual.rule, actual.fallback]
    .some(Boolean) ? actual as ProjectAgentActualExecution : null
}

export function normalizeAssignment(value: unknown, fallback: ProjectAgentRecord): ProjectAgentAssignmentRecord | null {
  const record = unknownRecord(value)
  const projectId = stringOf(record, 'personalProjectId', 'personal_project_id')
  const assignmentId = stringOf(record, 'assignmentId', 'assignment_id')
  if (!projectId || !assignmentId) return null
  return {
    assignmentId, personalSpaceId: stringOf(record, 'personalSpaceId', 'personal_space_id') ?? fallback.personalSpaceId,
    personalProjectId: projectId, agentId: stringOf(record, 'agentId', 'agent_id') ?? fallback.agentId,
    responsibility: stringOf(record, 'responsibility', 'responsibility') ?? fallback.profile.responsibility,
    scope: stringOf(record, 'scope', 'scope'), workKinds: arrayOf(valueOf(record, 'workKinds', 'work_kinds')).filter((item): item is string => typeof item === 'string'),
    capabilities: arrayOf(record.capabilities).filter((item): item is string => typeof item === 'string'),
    modelStrategyOverride: normalizeStrategy(valueOf(record, 'modelStrategyOverride', 'model_strategy_override')),
    executorPolicyOverride: normalizePolicy(valueOf(record, 'executorPolicyOverride', 'executor_policy_override')),
    reason: stringOf(record, 'reason', 'reason'), status: (stringOf(record, 'status', 'status') ?? 'active') as ProjectAgentAssignmentRecord['status'],
    revision: typeof record.revision === 'number' ? record.revision : undefined,
    sourceApplication: stringOf(record, 'sourceApplication', 'source_application') as ConversationSourceApplication | null,
    sourceSessionId: stringOf(record, 'sourceSessionId', 'source_session_id'), assignedAt: stringOf(record, 'assignedAt', 'assigned_at') ?? fallback.createdAt,
    updatedAt: stringOf(record, 'updatedAt', 'updated_at') ?? fallback.updatedAt, endedAt: stringOf(record, 'endedAt', 'ended_at'),
    endReason: stringOf(record, 'endReason', 'end_reason'), replacedByAssignmentId: stringOf(record, 'replacedByAssignmentId', 'replaced_by_assignment_id'),
  }
}

export function normalizeParticipant(value: unknown): ProjectAgentTaskRecord['participants'][number] {
  const record = unknownRecord(value)
  return {
    agentId: stringOf(record, 'agentId', 'agent_id') ?? '', assignmentId: stringOf(record, 'assignmentId', 'assignment_id'),
    role: stringOf(record, 'role', 'role') ?? 'collaborator', status: stringOf(record, 'status', 'status') as ProjectAgentTaskStatus,
    assignmentSummary: stringOf(record, 'assignmentSummary', 'assignment_summary'), joinedAt: stringOf(record, 'joinedAt', 'joined_at'),
    updatedAt: stringOf(record, 'updatedAt', 'updated_at'), endedAt: stringOf(record, 'endedAt', 'ended_at'),
  }
}

export function normalizeExecutionSummary(value: unknown): ProjectAgentTaskExecutionSummary[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.map((item) => {
    const record = unknownRecord(item)
    return {
      agentId: stringOf(record, 'agentId', 'agent_id'),
      agentName: stringOf(record, 'agentName', 'agent_name'),
      occupationEmoji: stringOf(record, 'occupationEmoji', 'occupation_emoji'),
      workerId: stringOf(record, 'workerId', 'worker_id'),
      workerLabel: stringOf(record, 'workerLabel', 'worker_label'),
      workerOccupationEmoji: stringOf(record, 'workerOccupationEmoji', 'worker_occupation_emoji'),
      participantRole: stringOf(record, 'participantRole', 'participant_role'),
      executor: stringOf(record, 'executor', 'executor'),
      executorId: stringOf(record, 'executorId', 'executor_id'),
      sourceApplication: stringOf(record, 'sourceApplication', 'source_application') as ConversationSourceApplication | null,
      actualModelProvider: stringOf(record, 'actualModelProvider', 'actual_model_provider'),
      actualModel: stringOf(record, 'actualModel', 'actual_model'),
      workSummary: stringOf(record, 'workSummary', 'work_summary'),
      status: stringOf(record, 'status', 'status'),
    }
  })
}

export function normalizeEvent(value: unknown): ProjectAgentTaskEvent | null {
  const record = unknownRecord(value)
  const eventId = stringOf(record, 'eventId', 'event_id'); const taskId = stringOf(record, 'taskId', 'task_id')
  if (!eventId || !taskId) return null
  const reportedActual = normalizeActual(valueOf(record, 'actualExecution', 'actual_execution'))
    ?? normalizeActual({
      executor: stringOf(record, 'actualExecutor', 'actual_executor'),
      provider: stringOf(record, 'actualModelProvider', 'actual_model_provider'),
      model: stringOf(record, 'actualModel', 'actual_model'),
      client: stringOf(record, 'sourceApplication', 'source_application'),
      rule: stringOf(record, 'routingRuleId', 'routing_rule_id')
        ?? stringOf(record, 'matchedExecutorRuleId', 'matched_executor_rule_id'),
      fallback: stringOf(record, 'fallbackReason', 'fallback_reason')
        ?? stringOf(record, 'executorFallbackReason', 'executor_fallback_reason'),
      reportedAt: stringOf(record, 'createdAt', 'created_at'),
    })
  return {
    eventId, taskId, agentId: stringOf(record, 'agentId', 'agent_id'), status: stringOf(record, 'status', 'status') as ProjectAgentTaskStatus,
    actorKind: stringOf(record, 'actorKind', 'actor_kind') ?? undefined, summary: stringOf(record, 'summary', 'summary') ?? '',
    sourceApplication: stringOf(record, 'sourceApplication', 'source_application') as ConversationSourceApplication | null,
    sourceSessionId: stringOf(record, 'sourceSessionId', 'source_session_id'), actualExecution: reportedActual,
    actualModelProvider: stringOf(record, 'actualModelProvider', 'actual_model_provider'), actualModel: stringOf(record, 'actualModel', 'actual_model'),
    workerId: stringOf(record, 'workerId', 'worker_id'), workerLabel: stringOf(record, 'workerLabel', 'worker_label'),
    workerOccupationEmoji: stringOf(record, 'workerOccupationEmoji', 'worker_occupation_emoji'),
    workerStatus: stringOf(record, 'workerStatus', 'worker_status'),
    createdAt: stringOf(record, 'createdAt', 'created_at') ?? '',
  }
}

export function normalizeRoutingDecision(value: unknown): ProjectAgentRoutingDecision | null {
  if (!value || typeof value !== 'object') return null
  const record = unknownRecord(value)
  return {
    decisionId: stringOf(record, 'decisionId', 'decision_id') ?? undefined,
    taskId: stringOf(record, 'taskId', 'task_id') ?? undefined,
    coordinatorAgentId: stringOf(record, 'coordinatorAgentId', 'coordinator_agent_id'),
    complexity: (() => {
      const complexity = valueOf(record, 'complexity', 'complexity')
      return typeof complexity === 'string' || typeof complexity === 'number' ? complexity : null
    })(),
    complexityBasis: arrayOf(valueOf(record, 'complexityBasis', 'complexity_basis')).filter((item): item is string => typeof item === 'string'),
    outcome: stringOf(record, 'outcome', 'outcome') ?? stringOf(record, 'routingOutcome', 'routing_outcome'),
    reason: stringOf(record, 'reason', 'reason') ?? stringOf(record, 'routingReason', 'routing_reason'),
    matchBasis: arrayOf(valueOf(record, 'matchBasis', 'match_basis')).filter((item): item is string => typeof item === 'string'),
    candidateAgentIds: arrayOf(valueOf(record, 'candidateAgentIds', 'candidate_agent_ids')).filter((item): item is string => typeof item === 'string'),
    optimizationPriority: arrayOf(valueOf(record, 'optimizationPriority', 'optimization_priority')).filter((item): item is string => typeof item === 'string'),
    parallelPlan: normalizeParallelPlan(valueOf(record, 'parallelPlan', 'parallel_plan')),
    selectedModelStrategy: normalizeStrategy(valueOf(record, 'selectedModelStrategy', 'selected_model_strategy')),
    modelStrategySource: stringOf(record, 'modelStrategySource', 'model_strategy_source') ?? undefined,
    ruleId: stringOf(record, 'ruleId', 'rule_id') ?? stringOf(record, 'matchedExecutorRuleId', 'matched_executor_rule_id') ?? stringOf(record, 'executorRuleId', 'executor_rule_id'),
    fallback: stringOf(record, 'fallback', 'fallback') ?? stringOf(record, 'fallbackReason', 'fallback_reason') ?? stringOf(record, 'executorFallbackReason', 'executor_fallback_reason'),
  }
}

function hasReportedValue(value: unknown) {
  return value !== undefined && value !== null
    && (typeof value !== 'string' || value.length > 0)
    && (!Array.isArray(value) || value.length > 0)
}

function normalizeTaskRoutingDecision(record: UnknownRecord): ProjectAgentRoutingDecision | null {
  const keys = [
    'staffingIntent', 'staffing_intent', 'routingOutcome', 'routing_outcome',
    'routingReason', 'routing_reason', 'routingExplanation', 'routing_explanation',
    'coordinatorAgentId', 'coordinator_agent_id', 'complexity', 'complexityBasis', 'complexity_basis',
    'matchBasis', 'match_basis', 'candidateAgentIds', 'candidate_agent_ids',
  ]
  if (!keys.some((key) => hasReportedValue(record[key]))) return null
  return normalizeRoutingDecision({
    outcome: valueOf(record, 'routingOutcome', 'routing_outcome'),
    reason: valueOf(record, 'routingReason', 'routing_reason'),
    matchBasis: valueOf(record, 'matchBasis', 'match_basis'),
    coordinatorAgentId: valueOf(record, 'coordinatorAgentId', 'coordinator_agent_id'),
    complexity: valueOf(record, 'complexity', 'complexity'),
    complexityBasis: valueOf(record, 'complexityBasis', 'complexity_basis'),
    candidateAgentIds: valueOf(record, 'candidateAgentIds', 'candidate_agent_ids'),
  })
}

export function normalizeTask(value: unknown): ProjectAgentTaskRecord | null {
  const record = unknownRecord(value); const taskId = stringOf(record, 'taskId', 'task_id'); if (!taskId) return null
  const reportedActual = normalizeActual(valueOf(record, 'actualExecution', 'actual_execution')) ?? normalizeActual({
    executor: stringOf(record, 'actualExecutor', 'actual_executor'),
    provider: stringOf(record, 'actualModelProvider', 'actual_model_provider'),
    model: stringOf(record, 'actualModel', 'actual_model'),
    client: stringOf(record, 'sourceApplication', 'source_application'),
    rule: stringOf(record, 'routingRuleId', 'routing_rule_id') ?? stringOf(record, 'matchedExecutorRuleId', 'matched_executor_rule_id'),
    fallback: stringOf(record, 'fallbackReason', 'fallback_reason') ?? stringOf(record, 'executorFallbackReason', 'executor_fallback_reason'),
  })
  const routingDecision = normalizeRoutingDecision(valueOf(record, 'routingDecision', 'routing_decision'))
    ?? normalizeTaskRoutingDecision(record)
  return {
    taskId, personalSpaceId: stringOf(record, 'personalSpaceId', 'personal_space_id') ?? undefined, personalProjectId: stringOf(record, 'personalProjectId', 'personal_project_id'),
    title: stringOf(record, 'title', 'title') ?? taskId, objective: stringOf(record, 'objective', 'objective'), workKind: stringOf(record, 'workKind', 'work_kind'),
    status: stringOf(record, 'status', 'status') as ProjectAgentTaskStatus, runId: stringOf(record, 'runId', 'run_id'), executionId: stringOf(record, 'executionId', 'execution_id'),
    ownerAgentId: stringOf(record, 'ownerAgentId', 'owner_agent_id'), leadAgentId: stringOf(record, 'leadAgentId', 'lead_agent_id'), coordinatorAgentId: stringOf(record, 'coordinatorAgentId', 'coordinator_agent_id'), hrAgentId: stringOf(record, 'hrAgentId', 'hr_agent_id'), recruitmentId: stringOf(record, 'recruitmentId', 'recruitment_id'), participants: arrayOf(record.participants).map(normalizeParticipant),
    sourceApplication: stringOf(record, 'sourceApplication', 'source_application') as ConversationSourceApplication | null, sourceSessionId: stringOf(record, 'sourceSessionId', 'source_session_id'),
    resultSummary: stringOf(record, 'resultSummary', 'result_summary'), failureReason: stringOf(record, 'failureReason', 'failure_reason'), createdAt: stringOf(record, 'createdAt', 'created_at'),
    updatedAt: stringOf(record, 'updatedAt', 'updated_at'), completedAt: stringOf(record, 'completedAt', 'completed_at'), effectiveModelStrategy: normalizeStrategy(valueOf(record, 'effectiveModelStrategy', 'effective_model_strategy')), effectiveExecutorPolicy: normalizePolicy(valueOf(record, 'effectiveExecutorPolicy', 'effective_executor_policy') ?? valueOf(record, 'executorPolicy', 'executor_policy')),
    staffingIntent: stringOf(record, 'staffingIntent', 'staffing_intent'), routingOutcome: stringOf(record, 'routingOutcome', 'routing_outcome'), routingReason: stringOf(record, 'routingReason', 'routing_reason'), routingExplanation: stringOf(record, 'routingExplanation', 'routing_explanation'),
    matchBasis: arrayOf(valueOf(record, 'matchBasis', 'match_basis')).filter((item): item is string => typeof item === 'string'), complexity: (() => { const complexity = valueOf(record, 'complexity', 'complexity'); return typeof complexity === 'string' || typeof complexity === 'number' ? complexity : null })(), complexityBasis: arrayOf(valueOf(record, 'complexityBasis', 'complexity_basis')).filter((item): item is string => typeof item === 'string'),
    modelStrategySource: stringOf(record, 'modelStrategySource', 'model_strategy_source') ?? undefined, actualExecution: reportedActual,
    executionSummary: normalizeExecutionSummary(valueOf(record, 'executionSummary', 'execution_summary')),
    routingDecision, events: arrayOf(record.events).map(normalizeEvent).filter(Boolean) as ProjectAgentTaskEvent[],
  }
}

export function workerEventEvidence(task: ProjectAgentTaskRecord) {
  if (task.executionSummary !== undefined) return []
  return (task.events ?? []).filter((event) => Boolean(
    event.workerId || event.workerLabel || event.workerOccupationEmoji || event.workerStatus,
  ))
}

export function parallelPlanHasEvidence(plan: ProjectAgentParallelPlan | null | undefined) {
  return Boolean(plan && (
    plan.enabled || plan.independentVerification || plan.conflictFreeScopes
    || plan.reason || plan.workstreamBoundaries?.length
  ))
}

export function eventExecution(event: ProjectAgentTaskEvent): ProjectAgentActualExecution {
  return event.actualExecution ?? { provider: event.actualModelProvider ?? null, model: event.actualModel ?? null, client: event.sourceApplication ?? null, reportedAt: event.createdAt }
}
