export function providerProjectAgentProfile(profile) {
  if (!profile || typeof profile !== 'object') {
    throw new TypeError('Project Agent profile is required');
  }
  const result = {
    name: profile.name,
    responsibility: profile.responsibility,
    capabilities: profile.capabilities ?? [],
    initial_preferences: profile.initialPreferences ?? profile.initial_preferences ?? [],
    status: profile.status ?? 'active'
  };
  copyOptional(result, 'occupation_emoji', profile.occupationEmoji !== undefined
    ? profile.occupationEmoji : profile.occupation_emoji,
    hasAny(profile, ['occupationEmoji', 'occupation_emoji']));
  copyOptional(result, 'agent_type', profile.agentType ?? profile.agent_type,
    hasAny(profile, ['agentType', 'agent_type']));
  copyOptional(result, 'work_kinds', profile.workKinds ?? profile.work_kinds,
    hasAny(profile, ['workKinds', 'work_kinds']));
  copyOptional(
    result,
    'default_model_strategy',
    providerModelStrategy(profile.defaultModelStrategy ?? profile.default_model_strategy),
    hasAny(profile, ['defaultModelStrategy', 'default_model_strategy'])
  );
  copyOptional(result, 'allowed_clients', profile.allowedClients ?? profile.allowed_clients,
    hasAny(profile, ['allowedClients', 'allowed_clients']));
  copyOptional(result, 'test_source', profile.testSource ?? profile.test_source,
    hasAny(profile, ['testSource', 'test_source']));
  copyOptional(result, 'cleanup_eligible', profile.cleanupEligible ?? profile.cleanup_eligible,
    hasAny(profile, ['cleanupEligible', 'cleanup_eligible']));
  copyOptional(
    result,
    'executor_policy',
    providerExecutorPolicy(profile.executorPolicy ?? profile.executor_policy),
    hasAny(profile, ['executorPolicy', 'executor_policy'])
  );
  return result;
}

export function projectAgentRecord(value) {
  const profile = value.profile ?? {};
  const result = {
    agentId: value.agent_id,
    personalSpaceId: value.personal_space_id,
    personalProjectId: value.personal_project_id,
    profile: {
      name: profile.name,
      responsibility: profile.responsibility,
      capabilities: profile.capabilities ?? [],
      initialPreferences: profile.initial_preferences ?? [],
      status: profile.status
    },
    createdAt: value.created_at,
    updatedAt: value.updated_at
  };
  copyOptional(
    result.profile,
    'occupationEmoji',
    profile.occupationEmoji !== undefined ? profile.occupationEmoji : profile.occupation_emoji,
    hasAny(profile, ['occupationEmoji', 'occupation_emoji'])
  );
  copyOptional(result.profile, 'agentType', profile.agent_type,
    Object.hasOwn(profile, 'agent_type'));
  copyOptional(result.profile, 'workKinds', profile.work_kinds,
    Object.hasOwn(profile, 'work_kinds'));
  copyOptional(
    result.profile,
    'defaultModelStrategy',
    projectAgentModelStrategy(profile.default_model_strategy),
    Object.hasOwn(profile, 'default_model_strategy')
  );
  copyOptional(result.profile, 'allowedClients', profile.allowed_clients,
    Object.hasOwn(profile, 'allowed_clients'));
  copyOptional(result.profile, 'testSource', profile.test_source,
    Object.hasOwn(profile, 'test_source'));
  copyOptional(result.profile, 'cleanupEligible', profile.cleanup_eligible,
    Object.hasOwn(profile, 'cleanup_eligible'));
  copyOptional(
    result.profile,
    'executorPolicy',
    projectAgentExecutorPolicy(profile.executor_policy),
    Object.hasOwn(profile, 'executor_policy')
  );
  copyOptional(
    result,
    'executorPolicy',
    projectAgentExecutorPolicy(value.executor_policy),
    Object.hasOwn(value, 'executor_policy')
  );
  copyOptional(result, 'memoryScope', value.memory_scope,
    Object.hasOwn(value, 'memory_scope'));
  copyOptional(result, 'assignments', (value.assignments ?? []).map(projectAgentAssignmentRecord),
    Object.hasOwn(value, 'assignments'));
  copyOptional(result, 'recruitmentId', value.recruitment_id,
    Object.hasOwn(value, 'recruitment_id'));
  copyOptional(result, 'temporaryTaskId', value.temporary_task_id,
    Object.hasOwn(value, 'temporary_task_id'));
  copyOptional(result, 'workStatus', value.work_status,
    Object.hasOwn(value, 'work_status'));
  copyOptional(result, 'openTaskCount', value.open_task_count,
    Object.hasOwn(value, 'open_task_count'));
  copyOptional(result, 'currentTaskId', value.current_task_id,
    Object.hasOwn(value, 'current_task_id'));
  copyOptional(result, 'observedClients', value.observed_clients,
    Object.hasOwn(value, 'observed_clients'));
  copyOptional(result, 'recruitedAt', value.recruited_at,
    Object.hasOwn(value, 'recruited_at'));
  copyOptional(result, 'recruitmentReason', value.recruitment_reason,
    Object.hasOwn(value, 'recruitment_reason'));
  copyOptional(result, 'recruitmentSourceApplication', value.recruitment_source_application,
    Object.hasOwn(value, 'recruitment_source_application'));
  copyOptional(
    result,
    'executionSummary',
    projectAgentExecutionSummary(value.execution_summary ?? value.executionSummary),
    hasAny(value, ['execution_summary', 'executionSummary'])
  );
  return result;
}

export function providerModelStrategy(value) {
  if (value === undefined || value === null) return value ?? null;
  const strategy = {
    mode: value.mode ?? 'adaptive',
    reasoning_effort: value.reasoningEffort ?? value.reasoning_effort ?? 'default',
    capability_hints: value.capabilityHints ?? value.capability_hints ?? []
  };
  return strategy;
}

export function projectAgentModelStrategy(value) {
  if (value === undefined || value === null) return value ?? null;
  return {
    mode: value.mode ?? 'adaptive',
    reasoningEffort: value.reasoning_effort ?? value.reasoningEffort ?? 'default',
    capabilityHints: value.capability_hints ?? value.capabilityHints ?? []
  };
}

export function providerExecutorPolicy(value) {
  if (value === undefined || value === null) return value ?? null;
  return {
    mode: value.mode ?? 'flexible',
    locked_executor_ids: value.lockedExecutorIds ?? value.locked_executor_ids ?? [],
    preferred_executor_ids: value.preferredExecutorIds ?? value.preferred_executor_ids ?? []
  };
}

export function projectAgentExecutorPolicy(value) {
  if (value === undefined || value === null) return value ?? null;
  return {
    mode: value.mode ?? 'flexible',
    lockedExecutorIds: value.locked_executor_ids ?? value.lockedExecutorIds ?? [],
    preferredExecutorIds: value.preferred_executor_ids ?? value.preferredExecutorIds ?? []
  };
}

export function providerProjectAgentAssignment(input) {
  if (!input || typeof input !== 'object') {
    throw new TypeError('Project Agent assignment is required');
  }
  const result = {
    personal_space_id: input.personalSpaceId ?? input.personal_space_id,
    personal_project_id: input.personalProjectId ?? input.personal_project_id,
    agent_id: input.agentId ?? input.agent_id,
    idempotency_key: input.idempotencyKey ?? input.idempotency_key,
    responsibility: input.responsibility,
    work_kinds: input.workKinds ?? input.work_kinds ?? [],
    capabilities: input.capabilities ?? [],
    model_strategy_override: providerModelStrategy(
      input.modelStrategyOverride ?? input.model_strategy_override
    ),
    executor_policy_override: providerExecutorPolicy(
      input.executorPolicyOverride ?? input.executor_policy_override
    ),
    reason: input.reason,
    source_application: input.sourceApplication ?? input.source_application ?? null,
    source_session_id: input.sourceSessionId ?? input.source_session_id ?? null
  };
  return result;
}

export function providerProjectAgentAssignmentEnd(input) {
  return {
    personal_space_id: input.personalSpaceId ?? input.personal_space_id,
    personal_project_id: input.personalProjectId ?? input.personal_project_id,
    assignment_id: input.assignmentId ?? input.assignment_id,
    expected_revision: input.expectedRevision ?? input.expected_revision,
    reason: input.reason
  };
}

export function providerProjectAgentAssignmentReplace(input) {
  return {
    personal_space_id: input.personalSpaceId ?? input.personal_space_id,
    personal_project_id: input.personalProjectId ?? input.personal_project_id,
    assignment_id: input.assignmentId ?? input.assignment_id,
    expected_revision: input.expectedRevision ?? input.expected_revision,
    replacement_agent_id: input.replacementAgentId ?? input.replacement_agent_id,
    idempotency_key: input.idempotencyKey ?? input.idempotency_key,
    responsibility: input.responsibility,
    work_kinds: input.workKinds ?? input.work_kinds ?? [],
    capabilities: input.capabilities ?? [],
    model_strategy_override: providerModelStrategy(
      input.modelStrategyOverride ?? input.model_strategy_override
    ),
    executor_policy_override: providerExecutorPolicy(
      input.executorPolicyOverride ?? input.executor_policy_override
    ),
    reason: input.reason,
    source_application: input.sourceApplication ?? input.source_application ?? null,
    source_session_id: input.sourceSessionId ?? input.source_session_id ?? null
  };
}

export function projectAgentAssignmentRecord(value = {}) {
  return {
    assignmentId: value.assignment_id ?? value.id,
    personalSpaceId: value.personal_space_id,
    personalProjectId: value.personal_project_id,
    agentId: value.agent_id,
    responsibility: value.responsibility,
    workKinds: value.work_kinds ?? [],
    capabilities: value.capabilities ?? [],
    modelStrategyOverride: projectAgentModelStrategy(value.model_strategy_override),
    executorPolicyOverride: projectAgentExecutorPolicy(value.executor_policy_override),
    reason: value.reason,
    status: value.status,
    revision: value.revision,
    sourceApplication: value.source_application ?? null,
    sourceSessionId: value.source_session_id ?? null,
    assignedAt: value.assigned_at,
    updatedAt: value.updated_at,
    endedAt: value.ended_at ?? null,
    endReason: value.end_reason ?? null,
    replacedByAssignmentId: value.replaced_by_assignment_id ?? null
  };
}

export function providerProjectAgentTaskSubmit(input) {
  const result = {
    personal_space_id: input.personalSpaceId ?? input.personal_space_id,
    personal_project_id: input.personalProjectId ?? input.personal_project_id,
    idempotency_key: input.idempotencyKey ?? input.idempotency_key,
    title: input.title,
    objective: input.objective,
    work_kind: input.workKind ?? input.work_kind,
    required_capabilities: input.requiredCapabilities ?? input.required_capabilities ?? [],
    executor_capability_hints:
      input.executorCapabilityHints ?? input.executor_capability_hints ?? [],
    duration: input.duration ?? 'ongoing',
    staffing_intent: input.staffingIntent ?? input.staffing_intent ?? 'reuse_preferred',
    lead_agent_id: input.leadAgentId ?? input.lead_agent_id ?? null,
    collaborator_agent_ids: input.collaboratorAgentIds ?? input.collaborator_agent_ids ?? [],
    coordinator_agent_id: input.coordinatorAgentId ?? input.coordinator_agent_id ?? null,
    complexity_hint: input.complexityHint ?? input.complexity_hint ?? null,
    parallel_plan: providerParallelPlan(input.parallelPlan ?? input.parallel_plan),
    model_strategy_override: providerModelStrategy(
      input.modelStrategyOverride ?? input.model_strategy_override
    ),
    source_application: input.sourceApplication ?? input.source_application ?? null,
    source_session_id: input.sourceSessionId ?? input.source_session_id ?? null,
    routing_reason: input.routingReason ?? input.routing_reason,
    recruitment_profile: input.recruitmentProfile
      ? providerProjectAgentProfile(input.recruitmentProfile)
      : input.recruitment_profile ?? null,
    executor_policy_override: providerExecutorPolicy(
      input.executorPolicyOverride ?? input.executor_policy_override
    )
  };
  return result;
}

export function providerParallelPlan(value) {
  if (value === undefined || value === null) {
    return { enabled: false, independent_verification: false, conflict_free_scopes: false,
      reason: null, workstream_boundaries: [] };
  }
  return {
    enabled: value.enabled ?? false,
    independent_verification: value.independentVerification ?? value.independent_verification ?? false,
    conflict_free_scopes: value.conflictFreeScopes ?? value.conflict_free_scopes ?? false,
    reason: value.reason ?? null,
    workstream_boundaries: value.workstreamBoundaries ?? value.workstream_boundaries ?? []
  };
}

export function projectAgentParallelPlan(value = {}) {
  return {
    enabled: value.enabled ?? false,
    independentVerification: value.independent_verification ?? value.independentVerification ?? false,
    conflictFreeScopes: value.conflict_free_scopes ?? value.conflictFreeScopes ?? false,
    reason: value.reason ?? null,
    workstreamBoundaries: value.workstream_boundaries ?? value.workstreamBoundaries ?? []
  };
}

export function providerProjectAgentTokenUsage(value) {
  if (value === undefined || value === null) return value ?? null;
  return {
    source: value.source,
    total_tokens: value.totalTokens ?? value.total_tokens,
    input_tokens: value.inputTokens ?? value.input_tokens ?? null,
    output_tokens: value.outputTokens ?? value.output_tokens ?? null,
    cached_input_tokens: value.cachedInputTokens ?? value.cached_input_tokens ?? null,
    cache_write_input_tokens: value.cacheWriteInputTokens ??
      value.cache_write_input_tokens ?? null,
    reasoning_output_tokens: value.reasoningOutputTokens ??
      value.reasoning_output_tokens ?? null
  };
}

export function projectAgentTokenUsage(value) {
  if (value === undefined || value === null) return value ?? null;
  return {
    source: value.source,
    totalTokens: value.total_tokens ?? value.totalTokens,
    inputTokens: value.input_tokens ?? value.inputTokens ?? null,
    outputTokens: value.output_tokens ?? value.outputTokens ?? null,
    cachedInputTokens: value.cached_input_tokens ?? value.cachedInputTokens ?? null,
    cacheWriteInputTokens: value.cache_write_input_tokens ??
      value.cacheWriteInputTokens ?? null,
    reasoningOutputTokens: value.reasoning_output_tokens ??
      value.reasoningOutputTokens ?? null
  };
}

export function providerProjectAgentTaskActivity(input) {
  const result = withoutUndefined({
    personal_space_id: input.personalSpaceId ?? input.personal_space_id,
    personal_project_id: input.personalProjectId ?? input.personal_project_id,
    task_id: input.taskId ?? input.task_id,
    idempotency_key: input.idempotencyKey ?? input.idempotency_key,
    expected_revision: input.expectedRevision ?? input.expected_revision,
    status: input.status,
    summary: input.summary,
    agent_id: input.agentId ?? input.agent_id ?? null,
    actor_kind: input.actorKind ?? input.actor_kind ?? 'agent',
    source_application: input.sourceApplication ?? input.source_application ?? null,
    source_session_id: input.sourceSessionId ?? input.source_session_id ?? null,
    actual_model_provider: input.actualModelProvider ?? input.actual_model_provider ?? null,
    actual_model: input.actualModel ?? input.actual_model ?? null,
    actual_executor_id: input.actualExecutorId ?? input.actual_executor_id ??
      input.actualExecutor ?? input.actual_executor ?? null,
    matched_executor_rule_id: input.matchedExecutorRuleId ??
      input.matched_executor_rule_id ?? input.routingRuleId ?? input.routing_rule_id ?? null,
    executor_selection_reason: input.executorSelectionReason ??
      input.executor_selection_reason ?? null,
    executor_fallback_reason: input.executorFallbackReason ??
      input.executor_fallback_reason ?? input.fallbackReason ?? input.fallback_reason ?? null,
    executor_blocked_reason: input.executorBlockedReason ??
      input.executor_blocked_reason ?? null
  });
  if (hasAny(input, [
    'workerId', 'worker_id', 'workerLabel', 'worker_label',
    'workerOccupationEmoji', 'worker_occupation_emoji',
    'workerStatus', 'worker_status'
  ])) {
    Object.assign(result, {
      worker_id: input.workerId ?? input.worker_id ?? null,
      worker_label: input.workerLabel ?? input.worker_label ?? null,
      worker_occupation_emoji: input.workerOccupationEmoji ??
        input.worker_occupation_emoji ?? null,
      worker_status: input.workerStatus ?? input.worker_status ?? null
    });
  }
  if (hasAny(input, ['tokenUsage', 'token_usage'])) {
    result.token_usage = providerProjectAgentTokenUsage(
      input.tokenUsage ?? input.token_usage
    );
  }
  if (hasAny(input, ['workerRuntime', 'worker_runtime'])) {
    const runtime = input.workerRuntime ?? input.worker_runtime;
    result.worker_runtime = runtime ? withoutUndefined({
      application: runtime.application,
      session_id: runtime.sessionId ?? runtime.session_id ?? null,
      session_url: runtime.sessionUrl ?? runtime.session_url ?? null
    }) : null;
  }
  copyOptional(
    result,
    'source_session_url',
    input.sourceSessionUrl ?? input.source_session_url ?? null,
    hasAny(input, ['sourceSessionUrl', 'source_session_url'])
  );
  copyOptional(
    result,
    'tools_used',
    input.toolsUsed ?? input.tools_used ?? null,
    hasAny(input, ['toolsUsed', 'tools_used'])
  );
  return result;
}

export function projectAgentTaskRecord(value = {}) {
  const result = {
    taskId: value.task_id,
    personalSpaceId: value.personal_space_id,
    personalProjectId: value.personal_project_id,
    title: value.title,
    objective: value.objective,
    workKind: value.work_kind,
    requiredCapabilities: value.required_capabilities ?? [],
    executorCapabilityHints: value.executor_capability_hints ?? [],
    duration: value.duration,
    staffingIntent: value.staffing_intent,
    status: value.status,
    revision: value.revision,
    routingOutcome: value.routing_outcome,
    routingReason: value.routing_reason,
    routingExplanation: value.routing_explanation,
    matchBasis: value.match_basis ?? [],
    coordinatorAgentId: value.coordinator_agent_id,
    complexity: value.complexity,
    complexityBasis: value.complexity_basis ?? [],
    routingDecision: value.routing_decision
      ? projectAgentRoutingDecisionRecord(value.routing_decision) : null,
    leadAgentId: value.lead_agent_id ?? null,
    participants: (value.participants ?? []).map(projectAgentTaskParticipantRecord),
    effectiveModelStrategy: projectAgentModelStrategy(value.effective_model_strategy),
    modelStrategySource: value.model_strategy_source,
    executorPolicy: projectAgentExecutorPolicy(value.executor_policy),
    hrAgentId: value.hr_agent_id ?? null,
    recruitmentId: value.recruitment_id ?? null,
    sourceApplication: value.source_application ?? null,
    sourceSessionId: value.source_session_id ?? null,
    resultSummary: value.result_summary ?? null,
    failureReason: value.failure_reason ?? null,
    runId: value.actual_run_id ?? value.run_id ?? null,
    actualExecutor: value.actual_executor_id ?? value.actual_executor ?? null,
    selectedExecutorId: value.selected_executor_id ?? null,
    executorRuleId: value.executor_rule_id ?? value.rule_id ?? null,
    matchedExecutorRuleId: value.matched_executor_rule_id ?? value.routing_rule_id ?? null,
    executorSelectionReason: value.executor_selection_reason ?? null,
    executorFallbackReason: value.executor_fallback_reason ?? null,
    executorFallbackOutcome: value.executor_fallback_outcome ?? null,
    executorBlockedReason: value.executor_blocked_reason ?? null,
    executorDecision: value.executor_decision ?? null,
    auditId: value.audit_id ?? null,
    actualModelProvider: value.actual_model_provider ?? null,
    actualModel: value.actual_model ?? null,
    routingRuleId: value.matched_executor_rule_id ?? value.routing_rule_id ?? null,
    fallbackReason: value.executor_fallback_reason ?? value.fallback_reason ?? null,
    fallbackUsed: value.fallback_used ?? false,
    createdAt: value.created_at,
    updatedAt: value.updated_at,
    completedAt: value.completed_at ?? null,
    events: (value.events ?? []).map(projectAgentTaskEventRecord)
  };
  copyOptional(
    result,
    'executionSummary',
    projectAgentExecutionSummary(value.execution_summary ?? value.executionSummary),
    hasAny(value, ['execution_summary', 'executionSummary'])
  );
  return result;
}

export function projectAgentTaskParticipantRecord(value = {}) {
  return {
    agentId: value.agent_id,
    role: value.role,
    status: value.status,
    assignmentSummary: value.assignment_summary ?? null,
    joinedAt: value.joined_at,
    updatedAt: value.updated_at,
    endedAt: value.ended_at ?? null
  };
}

export function projectAgentTaskEventRecord(value = {}) {
  const result = {
    eventId: value.event_id,
    taskId: value.task_id,
    agentId: value.agent_id ?? null,
    status: value.status,
    actorKind: value.actor_kind,
    summary: value.summary,
    sourceApplication: value.source_application ?? null,
    sourceSessionId: value.source_session_id ?? null,
    actualExecutor: value.actual_executor_id ?? value.actual_executor ?? null,
    executorRuleId: value.executor_rule_id ?? value.rule_id ?? null,
    matchedExecutorRuleId: value.matched_executor_rule_id ?? value.routing_rule_id ?? null,
    executorSelectionReason: value.executor_selection_reason ?? null,
    executorFallbackReason: value.executor_fallback_reason ?? null,
    executorBlockedReason: value.executor_blocked_reason ?? null,
    auditId: value.audit_id ?? null,
    actualModelProvider: value.actual_model_provider ?? null,
    actualModel: value.actual_model ?? null,
    workerId: value.worker_id ?? value.workerId ?? null,
    workerLabel: value.worker_label ?? value.workerLabel ?? null,
    workerOccupationEmoji: value.worker_occupation_emoji ??
      value.workerOccupationEmoji ?? null,
    workerStatus: value.worker_status ?? value.workerStatus ?? null,
    routingRuleId: value.matched_executor_rule_id ?? value.routing_rule_id ?? null,
    fallbackReason: value.executor_fallback_reason ?? value.fallback_reason ?? null,
    fallbackUsed: value.fallback_used ?? false,
    createdAt: value.created_at
  };
  copyOptional(
    result,
    'workerRuntime',
    projectAgentWorkerRuntime(value.worker_runtime ?? value.workerRuntime),
    hasAny(value, ['worker_runtime', 'workerRuntime'])
  );
  copyOptional(
    result,
    'sourceSessionUrl',
    value.source_session_url ?? value.sourceSessionUrl ?? null,
    hasAny(value, ['source_session_url', 'sourceSessionUrl'])
  );
  copyOptional(
    result,
    'toolsUsed',
    value.tools_used ?? value.toolsUsed ?? null,
    hasAny(value, ['tools_used', 'toolsUsed'])
  );
  copyOptional(
    result,
    'tokenUsage',
    projectAgentTokenUsage(value.token_usage ?? value.tokenUsage),
    hasAny(value, ['token_usage', 'tokenUsage'])
  );
  return result;
}

export function projectAgentRoutingDecisionRecord(value = {}) {
  return {
    decisionId: value.decision_id,
    taskId: value.task_id,
    coordinatorAgentId: value.coordinator_agent_id,
    complexity: value.complexity,
    complexityBasis: value.complexity_basis ?? [],
    selectedModelStrategy: projectAgentModelStrategy(value.selected_model_strategy),
    modelStrategySource: value.model_strategy_source,
    outcome: value.outcome,
    reason: value.reason,
    matchBasis: value.match_basis ?? [],
    candidateAgentIds: value.candidate_agent_ids ?? [],
    optimizationPriority: value.optimization_priority ?? [
      'quality_and_acceptance', 'token_and_cost', 'time'
    ],
    parallelPlan: projectAgentParallelPlan(value.parallel_plan),
    actualExecutor: value.actual_executor_id ?? value.actual_executor ?? null,
    selectedExecutorId: value.selected_executor_id ?? null,
    executorRuleId: value.executor_rule_id ?? value.rule_id ?? null,
    matchedExecutorRuleId: value.matched_executor_rule_id ?? value.routing_rule_id ?? null,
    executorSelectionReason: value.executor_selection_reason ?? null,
    executorFallbackReason: value.executor_fallback_reason ?? null,
    executorFallbackOutcome: value.executor_fallback_outcome ?? null,
    executorBlockedReason: value.executor_blocked_reason ?? null,
    executorDecision: value.executor_decision ?? null,
    executorPolicy: projectAgentExecutorPolicy(value.executor_policy),
    actualModelProvider: value.actual_model_provider ?? null,
    actualModel: value.actual_model ?? null,
    routingRuleId: value.matched_executor_rule_id ?? value.routing_rule_id ?? null,
    fallbackReason: value.executor_fallback_reason ?? value.fallback_reason ?? null,
    fallbackUsed: value.fallback_used ?? false,
    auditId: value.audit_id ?? null,
    createdAt: value.created_at
  };
}

export function projectAgentTaskRouteResult(value = {}) {
  return {
    task: projectAgentTaskRecord(value.task ?? {}),
    assignedAgent: value.assigned_agent ? projectAgentRecord(value.assigned_agent) : null,
    recruitment: value.recruitment ? projectAgentRecruitmentRecord(value.recruitment) : null,
    recruitments: (value.recruitments ?? []).map(projectAgentRecruitmentRecord),
    decision: value.decision,
    mustDiscloseRecruitment: value.must_disclose_recruitment ?? false,
    clientNotice: value.client_notice ?? null
  };
}

export function projectAgentRecruitmentRecord(value = {}) {
  return {
    recruitmentId: value.recruitment_id,
    personalSpaceId: value.personal_space_id,
    personalProjectId: value.personal_project_id,
    taskId: value.task_id,
    coordinatorAgentId: value.coordinator_agent_id,
    hrAgentId: value.hr_agent_id ?? null,
    positionKind: value.position_kind,
    workKind: value.work_kind,
    requiredCapabilities: value.required_capabilities ?? [],
    reasonCode: value.reason_code,
    reason: value.reason,
    status: value.status,
    confirmationMode: value.confirmation_mode,
    proposedAgentId: value.proposed_agent_id,
    participantRole: value.participant_role ?? 'lead',
    recruitmentSlot: value.recruitment_slot ?? 'lead',
    proposedProfile: value.proposed_profile
      ? projectAgentProfileRecord(value.proposed_profile) : null,
    triggerSourceApplication: value.trigger_source_application ?? null,
    triggerSourceSessionId: value.trigger_source_session_id ?? null,
    revision: value.revision,
    recruitedAgentId: value.recruited_agent_id ?? null,
    testSource: value.test_source ?? null,
    cleanupEligible: value.cleanup_eligible ?? false,
    createdAt: value.created_at,
    updatedAt: value.updated_at,
    fulfilledAt: value.fulfilled_at ?? null
  };
}

export function projectAgentProfileRecord(profile = {}) {
  return {
    name: profile.name,
    responsibility: profile.responsibility,
    occupationEmoji: profile.occupation_emoji !== undefined
      ? profile.occupation_emoji : profile.occupationEmoji ?? null,
    agentType: profile.agent_type ?? 'durable',
    workKinds: profile.work_kinds ?? [],
    capabilities: profile.capabilities ?? [],
    initialPreferences: profile.initial_preferences ?? [],
    defaultModelStrategy: projectAgentModelStrategy(profile.default_model_strategy),
    executorPolicy: projectAgentExecutorPolicy(profile.executor_policy),
    allowedClients: profile.allowed_clients ?? [],
    testSource: profile.test_source ?? null,
    cleanupEligible: profile.cleanup_eligible ?? false,
    status: profile.status ?? 'active'
  };
}

export function projectAgentExecutionSummary(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry = {}) => {
    const actualExecutor = entry.actual_executor_id ?? entry.actual_executor ??
      entry.actualExecutor ?? null;
    const workSummary = entry.work_summary ?? entry.workSummary ?? entry.summary ?? null;
    const status = entry.status ?? entry.worker_status ?? entry.workerStatus ?? null;
    const result = {
      agentId: entry.agent_id ?? entry.agentId ?? null,
      agentName: entry.agent_name ?? entry.agentName ?? null,
      occupationEmoji: entry.occupation_emoji ?? entry.occupationEmoji ?? null,
      workerId: entry.worker_id ?? entry.workerId ?? null,
      workerLabel: entry.worker_label ?? entry.workerLabel ?? null,
      workerOccupationEmoji: entry.worker_occupation_emoji ??
        entry.workerOccupationEmoji ?? null,
      participantRole: entry.participant_role ?? entry.participantRole ?? null,
      executor: entry.executor ?? entry.executor_id ?? entry.executorId ?? actualExecutor,
      executorId: entry.executor_id ?? entry.executorId ?? actualExecutor,
      actualExecutor,
      sourceApplication: entry.source_application ?? entry.sourceApplication ?? null,
      actualModelProvider: entry.actual_model_provider ?? entry.actualModelProvider ?? null,
      actualModel: entry.actual_model ?? entry.actualModel ?? null,
      workSummary,
      summary: workSummary,
      status,
      workerStatus: entry.worker_status ?? entry.workerStatus ?? null
    };
    copyOptional(
      result,
      'workerRuntime',
      projectAgentWorkerRuntime(entry.worker_runtime ?? entry.workerRuntime),
      hasAny(entry, ['worker_runtime', 'workerRuntime'])
    );
    copyOptional(
      result,
      'sourceSessionId',
      entry.source_session_id ?? entry.sourceSessionId ?? null,
      hasAny(entry, ['source_session_id', 'sourceSessionId'])
    );
    copyOptional(
      result,
      'sourceSessionUrl',
      entry.source_session_url ?? entry.sourceSessionUrl ?? null,
      hasAny(entry, ['source_session_url', 'sourceSessionUrl'])
    );
    copyOptional(
      result,
      'toolsUsed',
      entry.tools_used ?? entry.toolsUsed ?? null,
      hasAny(entry, ['tools_used', 'toolsUsed'])
    );
    copyOptional(
      result,
      'tokenUsage',
      projectAgentTokenUsage(entry.token_usage ?? entry.tokenUsage),
      hasAny(entry, ['token_usage', 'tokenUsage'])
    );
    return result;
  });
}

export function projectAgentWorkerRuntime(value) {
  if (!value || typeof value !== 'object') return null;
  return withoutUndefined({
    application: value.application,
    sessionId: value.session_id ?? value.sessionId ?? null,
    sessionUrl: value.session_url ?? value.sessionUrl ?? null
  });
}

export function projectAgentActivityRecord(value = {}) {
  return {
    agentId: value.agent_id,
    personalSpaceId: value.personal_space_id,
    fromDate: value.from_date,
    toDate: value.to_date,
    days: (value.days ?? []).map((day) => ({
      date: day.date,
      completed: day.completed ?? 0,
      failed: day.failed ?? 0,
      cancelled: day.cancelled ?? 0,
      total: day.total ?? 0,
      tasks: (day.tasks ?? []).map((task) => ({
        taskId: task.task_id,
        title: task.title,
        status: task.status,
        summary: task.summary,
        occurredAt: task.occurred_at,
        sourceApplication: task.source_application ?? null,
        sourceSessionId: task.source_session_id ?? null,
        sourceSessionUrl: task.source_session_url ?? task.sourceSessionUrl ?? null,
        toolsUsed: task.tools_used ?? task.toolsUsed ?? null,
        actualExecutor: task.actual_executor_id ?? task.actual_executor ?? null,
        selectedExecutorId: task.selected_executor_id ?? null,
        executorRuleId: task.executor_rule_id ?? task.rule_id ?? null,
        matchedExecutorRuleId: task.matched_executor_rule_id ?? task.routing_rule_id ?? null,
        executorSelectionReason: task.executor_selection_reason ?? null,
        executorFallbackReason: task.executor_fallback_reason ?? null,
        executorFallbackOutcome: task.executor_fallback_outcome ?? null,
        executorBlockedReason: task.executor_blocked_reason ?? null,
        executorDecision: task.executor_decision ?? null,
        auditId: task.audit_id ?? null,
        actualModelProvider: task.actual_model_provider ?? null,
        actualModel: task.actual_model ?? null,
        workerId: task.worker_id ?? task.workerId ?? null,
        workerLabel: task.worker_label ?? task.workerLabel ?? null,
        workerOccupationEmoji: task.worker_occupation_emoji ??
          task.workerOccupationEmoji ?? null,
        workerStatus: task.worker_status ?? task.workerStatus ?? null,
        tokenUsage: projectAgentTokenUsage(task.token_usage ?? task.tokenUsage),
        ...(hasAny(task, ['worker_runtime', 'workerRuntime']) ? {
          workerRuntime: projectAgentWorkerRuntime(task.worker_runtime ?? task.workerRuntime)
        } : {}),
        executionSummary: projectAgentExecutionSummary(
          task.execution_summary ?? task.executionSummary
        ),
        routingRuleId: task.matched_executor_rule_id ?? task.routing_rule_id ?? null,
        fallbackReason: task.executor_fallback_reason ?? task.fallback_reason ?? null,
        fallbackUsed: task.fallback_used ?? false
      }))
    }))
  };
}

export function projectAgentRecruitmentPolicyRecord(value = {}) {
  return {
    personalSpaceId: value.personal_space_id,
    confirmationMode: value.confirmation_mode ?? 'automatic',
    updatedAt: value.updated_at ?? null,
    ...(value.policy_status ? {
      policyStatus: value.policy_status,
      appliesToRecruitment: value.applies_to_recruitment,
      warning: value.warning
    } : {})
  };
}

export function projectAgentCoordinationPolicyRecord(value = {}) {
  return {
    personalSpaceId: value.personal_space_id,
    personalProjectId: value.personal_project_id,
    askBeforeRecruitment: value.ask_before_recruitment ?? true,
    autoReusePreviousAgent: value.auto_reuse_previous_agent ?? true,
    updatedAt: value.updated_at ?? null
  };
}

export function providerProjectAgentCoordinationPolicy(input) {
  return {
    personal_space_id: input.personalSpaceId ?? input.personal_space_id,
    personal_project_id: input.personalProjectId ?? input.personal_project_id,
    ask_before_recruitment:
      input.askBeforeRecruitment ?? input.ask_before_recruitment ?? true,
    auto_reuse_previous_agent:
      input.autoReusePreviousAgent ?? input.auto_reuse_previous_agent ?? true
  };
}

export function providerProjectAgentRecruitmentDecision(input) {
  return {
    personal_space_id: input.personalSpaceId ?? input.personal_space_id,
    personal_project_id: input.personalProjectId ?? input.personal_project_id,
    recruitment_id: input.recruitmentId ?? input.recruitment_id,
    expected_revision: input.expectedRevision ?? input.expected_revision,
    decision: input.decision,
    reason: input.reason
  };
}

function providerExecutorModel(value = {}) {
  return withoutUndefined({
    provider: value.provider,
    model: value.model,
    capabilities: value.capabilities ?? [],
    strategy_modes: value.strategyModes ?? value.strategy_modes ?? [],
    reasoning_efforts: value.reasoningEfforts ?? value.reasoning_efforts ?? [],
    available: value.available ?? true,
    observed_at: value.observedAt ?? value.observed_at,
    source_application: value.sourceApplication ?? value.source_application,
    unavailable_reason: value.unavailableReason ?? value.unavailable_reason
  });
}

function executorModelRecord(value = {}) {
  return withoutUndefined({
    provider: value.provider,
    model: value.model,
    capabilities: value.capabilities ?? [],
    strategyModes: value.strategy_modes ?? value.strategyModes ?? [],
    reasoningEfforts: value.reasoning_efforts ?? value.reasoningEfforts ?? [],
    available: value.available,
    observedAt: value.observed_at ?? value.observedAt,
    sourceApplication: value.source_application ?? value.sourceApplication,
    unavailableReason: value.unavailable_reason ?? value.unavailableReason
  });
}

export function providerExecutorAuthorization(input) {
  return withoutUndefined({
    personal_space_id: input.personalSpaceId ?? input.personal_space_id,
    executor_id: input.executorId ?? input.executor_id,
    status: input.status,
    reason: input.reason,
    expected_revision: input.expectedRevision ?? input.expected_revision,
    idempotency_key: input.idempotencyKey ?? input.idempotency_key
  });
}

export function providerExecutorHealth(input) {
  return withoutUndefined({
    personal_space_id: input.personalSpaceId ?? input.personal_space_id,
    executor_id: input.executorId ?? input.executor_id,
    status: input.status,
    reason: input.reason,
    checked_at: input.checkedAt ?? input.checked_at,
    idempotency_key: input.idempotencyKey ?? input.idempotency_key,
    source_application: input.sourceApplication ?? input.source_application,
    source_session_id: input.sourceSessionId ?? input.source_session_id
  });
}

export function providerExecutor(input) {
  return withoutUndefined({
    personal_space_id: input.personalSpaceId ?? input.personal_space_id,
    executor_id: input.executorId ?? input.executor_id,
    display_name: input.displayName ?? input.display_name ?? input.name,
    executor_kind: input.executorKind ?? input.executor_kind ??
      input.executorType ?? input.executor_type ?? 'external',
    capabilities: input.capabilities ?? [],
    advertised_models: (input.advertisedModels ?? input.advertised_models ?? [])
      .map(providerExecutorModel),
    global_priority: input.globalPriority ?? input.global_priority,
    health_required: input.healthRequired ?? input.health_required,
    expected_revision: input.expectedRevision ?? input.expected_revision,
    idempotency_key: input.idempotencyKey ?? input.idempotency_key,
    source_application: input.sourceApplication ?? input.source_application ??
      input.client,
    source_session_id: input.sourceSessionId ?? input.source_session_id,
    test_source: input.testSource ?? input.test_source,
    cleanup_eligible: input.cleanupEligible ?? input.cleanup_eligible
  });
}

export function executorRecord(value = {}) {
  return withoutUndefined({
    executorId: value.executor_id,
    personalSpaceId: value.personal_space_id,
    displayName: value.display_name ?? value.name,
    executorKind: value.executor_kind ?? value.executor_type,
    capabilities: value.capabilities ?? [],
    advertisedModels: (value.advertised_models ?? []).map(executorModelRecord),
    availableModels: (value.available_models ?? []).map(executorModelRecord),
    globalPriority: value.global_priority,
    healthRequired: value.health_required,
    registrationStatus: value.registration_status,
    permissionStatus: value.permission_status,
    preflightStatus: value.preflight_status,
    healthStatus: value.health_status,
    workspacePermission: value.workspace_permission,
    revision: value.revision,
    permissionRevision: value.permission_revision,
    preflightAt: value.preflight_at,
    healthCheckedAt: value.health_checked_at,
    registeredAt: value.registered_at ?? value.created_at,
    updatedAt: value.updated_at,
    testSource: value.test_source,
    cleanupEligible: value.cleanup_eligible,
    // These are observations only.  In particular, omit `connected` when the
    // Provider did not return it instead of deriving an online state.
    allowed: value.allowed,
    observed: value.observed,
    connected: value.connected,
    actualExecutor: value.actual_executor_id ?? value.actual_executor,
    actualModelProvider: value.actual_model_provider,
    actualModel: value.actual_model,
    routingRuleId: value.matched_executor_rule_id ?? value.routing_rule_id,
    fallbackReason: value.executor_fallback_reason ?? value.fallback_reason,
    fallbackUsed: value.fallback_used,
    auditId: value.audit_id
  });
}

export function providerExecutorRoutingRule(input) {
  return withoutUndefined({
    personal_space_id: input.personalSpaceId ?? input.personal_space_id,
    scope: input.scope,
    personal_project_id: input.personalProjectId ?? input.personal_project_id,
    task_id: input.taskId ?? input.task_id,
    work_kind: input.workKind ?? input.work_kind,
    required_capabilities: input.requiredCapabilities ?? input.required_capabilities ?? [],
    executor_ids: input.executorIds ?? input.executor_ids ??
      input.executorAllowList ?? input.executor_allow_list ?? [],
    model_strategy: providerModelStrategy(input.modelStrategy ?? input.model_strategy),
    priority: input.priority,
    reason: input.reason,
    idempotency_key: input.idempotencyKey ?? input.idempotency_key
  });
}

export function providerExecutorRoutingRuleUpdate(input) {
  return withoutUndefined({
    personal_space_id: input.personalSpaceId ?? input.personal_space_id,
    rule_id: input.ruleId ?? input.rule_id,
    expected_revision: input.expectedRevision ?? input.expected_revision,
    status: input.status,
    reason: input.reason,
    idempotency_key: input.idempotencyKey ?? input.idempotency_key
  });
}

export function executorRoutingRuleRecord(value = {}) {
  return withoutUndefined({
    ruleId: value.rule_id,
    personalSpaceId: value.personal_space_id,
    scope: value.scope,
    personalProjectId: value.personal_project_id,
    taskId: value.task_id,
    workKind: value.work_kind,
    requiredCapabilities: value.required_capabilities ?? [],
    executorIds: value.executor_ids ?? value.executor_allow_list ?? [],
    modelStrategy: projectAgentModelStrategy(value.model_strategy),
    priority: value.priority,
    status: value.status,
    revision: value.revision,
    reason: value.reason,
    createdAt: value.created_at,
    updatedAt: value.updated_at,
    actualExecutor: value.actual_executor_id ?? value.actual_executor,
    actualModelProvider: value.actual_model_provider,
    actualModel: value.actual_model,
    routingRuleId: value.matched_executor_rule_id ?? value.routing_rule_id,
    fallbackReason: value.executor_fallback_reason ?? value.fallback_reason,
    fallbackUsed: value.fallback_used,
    auditId: value.audit_id,
    // Preserve the explicit Agent allow-list when a compatible Provider adds
    // it, without manufacturing one for the canonical rule model.
    agentId: value.agent_id,
    lockedAgentIds: value.locked_agent_ids,
    source: value.source,
    owner: value.owner,
    enabled: value.enabled,
    conditions: value.conditions
  });
}

export function providerExecutorPreflight(input) {
  return withoutUndefined({
    personal_space_id: input.personalSpaceId ?? input.personal_space_id,
    executor_id: input.executorId ?? input.executor_id,
    status: input.status,
    workspace_permission: input.workspacePermission ?? input.workspace_permission,
    capabilities: input.capabilities ?? [],
    available_models: (input.availableModels ?? input.available_models ?? [])
      .map(providerExecutorModel),
    reason: input.reason,
    checked_at: input.checkedAt ?? input.checked_at,
    idempotency_key: input.idempotencyKey ?? input.idempotency_key,
    source_application: input.sourceApplication ?? input.source_application,
    source_session_id: input.sourceSessionId ?? input.source_session_id
  });
}

export function executorPreflightRecord(value = {}) {
  return withoutUndefined({
    executorId: value.executor_id,
    personalSpaceId: value.personal_space_id,
    displayName: value.display_name,
    executorKind: value.executor_kind,
    registrationStatus: value.registration_status,
    permissionStatus: value.permission_status,
    preflightStatus: value.preflight_status,
    healthStatus: value.health_status,
    healthRequired: value.health_required,
    globalPriority: value.global_priority,
    revision: value.revision,
    registeredAt: value.registered_at,
    updatedAt: value.updated_at,
    status: value.status,
    available: value.available,
    workspacePermission: value.workspace_permission,
    capabilities: value.capabilities ?? [],
    availableModels: (value.available_models ?? value.advertised_models ?? [])
      .map(executorModelRecord),
    checkedAt: value.checked_at ?? value.preflight_at,
    connected: value.connected,
    reason: value.reason,
    testSource: value.test_source,
    cleanupEligible: value.cleanup_eligible
  });
}

export function providerExecutorActualReport(input) {
  return withoutUndefined({
    personal_space_id: input.personalSpaceId ?? input.personal_space_id,
    personal_project_id: input.personalProjectId ?? input.personal_project_id,
    task_id: input.taskId ?? input.task_id,
    run_id: input.runId ?? input.run_id,
    agent_id: input.agentId ?? input.agent_id,
    executor_id: input.executorId ?? input.executor_id,
    provider: input.provider,
    model: input.model,
    model_strategy: providerModelStrategy(
      input.modelStrategy ?? input.model_strategy ?? {}
    ),
    model_strategy_source: input.modelStrategySource ?? input.model_strategy_source ?? 'agent',
    matched_rule_id: input.matchedRuleId ?? input.matched_rule_id,
    fallback_reason: input.fallbackReason ?? input.fallback_reason,
    idempotency_key: input.idempotencyKey ?? input.idempotency_key,
    occurred_at: input.occurredAt ?? input.occurred_at,
    source_application: input.sourceApplication ?? input.source_application,
    source_session_id: input.sourceSessionId ?? input.source_session_id
  });
}

export function executorActualReportRecord(value = {}) {
  return withoutUndefined({
    personalSpaceId: value.personal_space_id,
    personalProjectId: value.personal_project_id,
    taskId: value.task_id,
    runId: value.run_id,
    agentId: value.agent_id,
    executorId: value.executor_id,
    provider: value.provider,
    model: value.model,
    modelStrategy: projectAgentModelStrategy(value.model_strategy),
    modelStrategySource: value.model_strategy_source,
    matchedRuleId: value.matched_rule_id,
    fallbackReason: value.fallback_reason,
    idempotencyKey: value.idempotency_key,
    occurredAt: value.occurred_at,
    sourceApplication: value.source_application,
    sourceSessionId: value.source_session_id
  });
}

export function providerProjectAgentTaskOutcome(input) {
  return withoutUndefined({
    personal_space_id: input.personalSpaceId ?? input.personal_space_id,
    personal_project_id: input.personalProjectId ?? input.personal_project_id,
    work_kind: input.workKind ?? input.work_kind,
    agent_id: input.agentId ?? input.agent_id,
    executor_id: input.executorId ?? input.executor_id,
    task_id: input.taskId ?? input.task_id,
    run_id: input.runId ?? input.run_id,
    model_strategy: providerModelStrategy(
      input.modelStrategy ?? input.model_strategy ?? {}
    ),
    idempotency_key: input.idempotencyKey ?? input.idempotency_key,
    evidence_kind: input.evidenceKind ?? input.evidence_kind,
    source: input.source,
    terminal_outcome: input.terminalOutcome ?? input.terminal_outcome,
    rating: input.rating,
    reference_ids: input.referenceIds ?? input.reference_ids ?? [],
    note: input.note ?? input.summary ?? input.reason,
    occurred_at: input.occurredAt ?? input.occurred_at
  });
}

export function projectAgentTaskOutcomeRecord(value = {}) {
  return withoutUndefined({
    evidenceId: value.evidence_id,
    personalSpaceId: value.personal_space_id,
    personalProjectId: value.personal_project_id,
    workKind: value.work_kind,
    agentId: value.agent_id,
    executorId: value.executor_id,
    taskId: value.task_id,
    runId: value.run_id ?? null,
    modelStrategy: projectAgentModelStrategy(value.model_strategy),
    evidenceKind: value.evidence_kind,
    source: value.source,
    terminalOutcome: value.terminal_outcome ?? null,
    rating: value.rating ?? null,
    referenceIds: value.reference_ids ?? [],
    note: value.note ?? null,
    idempotencyKey: value.idempotency_key,
    occurredAt: value.occurred_at,
    ignored: value.ignored ?? false,
    ignoredReason: value.ignored_reason ?? null,
    createdAt: value.created_at
  });
}

export function routingLearningRecord(value = {}) {
  return withoutUndefined({
    learningId: value.learning_id ?? value.evidence_id,
    personalSpaceId: value.personal_space_id,
    personalProjectId: value.personal_project_id,
    workKind: value.work_kind,
    agentId: value.agent_id,
    executorId: value.executor_id,
    modelStrategy: projectAgentModelStrategy(value.model_strategy),
    modelStrategyKey: value.model_strategy_key,
    routingRuleId: value.routing_rule_id,
    evidenceKind: value.evidence_kind,
    source: value.source,
    evidence: value.evidence,
    signal: value.signal,
    value: value.value,
    decayWeight: value.decay_weight,
    weight: value.weight,
    contribution: value.contribution ?? value.decay_weight,
    asOf: value.as_of,
    halfLife: value.half_life ?? value.decay_half_life_days,
    status: value.status,
    ignored: value.ignored,
    resetAt: value.reset_at,
    taskId: value.task_id,
    sampleCount: value.sample_count,
    recentCount: value.recent_count,
    successCount: value.success_count,
    reworkCount: value.rework_count,
    failureCount: value.failure_count,
    ratingCount: value.rating_count,
    averageRating: value.average_rating,
    neutralDueToInsufficientEvidence: value.neutral_due_to_insufficient_evidence,
    validationWarnings: value.validation_warnings,
    weightedSuccess: value.weighted_success,
    weightedFailure: value.weighted_failure,
    evidenceRefs: value.evidence_refs,
    evidenceContributions: (value.evidence_contributions ?? []).map((item) => ({
      evidenceId: item.evidence_id,
      evidenceKind: item.evidence_kind,
      signal: item.signal,
      value: item.value,
      decayWeight: item.decay_weight,
      occurredAt: item.occurred_at,
      referenceIds: item.reference_ids ?? []
    })),
    sourceApplication: value.source_application,
    createdAt: value.created_at,
    updatedAt: value.updated_at
  });
}

function hasAny(value, keys) {
  return keys.some((key) => Object.hasOwn(value, key));
}

function copyOptional(target, key, value, include) {
  if (include) target[key] = value;
}

function withoutUndefined(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined)
  );
}
