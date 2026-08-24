import {
  executorActualReportRecord,
  executorRecord,
  executorRoutingRuleRecord,
  projectAgentActivityRecord,
  projectAgentAssignmentRecord,
  projectAgentCoordinationPolicyRecord,
  projectAgentRecruitmentPolicyRecord,
  projectAgentRecruitmentRecord,
  projectAgentTaskRecord,
  projectAgentTaskOutcomeRecord,
  projectAgentTaskRouteResult,
  providerExecutor,
  providerExecutorActualReport,
  providerExecutorAuthorization,
  providerExecutorHealth,
  providerExecutorPreflight,
  providerExecutorRoutingRule,
  providerExecutorRoutingRuleUpdate,
  providerModelStrategy,
  providerProjectAgentAssignment,
  providerProjectAgentAssignmentEnd,
  providerProjectAgentAssignmentReplace,
  providerProjectAgentCoordinationPolicy,
  providerProjectAgentRecruitmentDecision,
  providerProjectAgentTaskActivity,
  providerProjectAgentTaskOutcome,
  providerProjectAgentTaskSubmit,
  projectAgentRecord,
  providerProjectAgentProfile,
  routingLearningRecord
} from './project-agent-mapping.js';

export async function upsertProjectAgent(application, input) {
  const value = await application.personal.upsertProjectAgent({
    personal_space_id: input.personalSpaceId,
    personal_project_id: input.personalProjectId ?? null,
    agent_id: input.agentId,
    profile: providerProjectAgentProfile(input.profile)
  });
  return projectAgentRecord(value);
}

export async function listProjectAgents(application, input) {
  const value = await application.personal.listProjectAgents(
    input.personalSpaceId,
    input.personalProjectId,
    {
      status: input.status ?? null,
      capability: input.capability ?? null
    }
  );
  return asList(value, ['agents', 'items']).map(projectAgentRecord);
}

export async function listCurrentProjectAgents(
  application,
  projectResolution,
  input
) {
  const projectId = projectResolution.personal_project_id;
  if (!projectId) {
    return {
      status: 'project_unresolved',
      personal_space_id: application.config.personal.spaceId,
      personal_project_id: null,
      project_resolution: projectResolution,
      agents: []
    };
  }
  return {
    status: 'listed',
    personal_space_id: application.config.personal.spaceId,
    personal_project_id: projectId,
    project_resolution: projectResolution,
    agents: await listProjectAgents(application, {
      personalSpaceId: application.config.personal.spaceId,
      personalProjectId: projectId,
      status: input.status,
      capability: input.capability
    })
  };
}

export async function getProjectAgent(application, input) {
  return projectAgentRecord(await application.personal.getProjectAgent(
    input.personalSpaceId,
    input.personalProjectId,
    input.agentId
  ));
}

export async function deleteProjectAgent(application, input) {
  return projectAgentRecord(await application.personal.deleteProjectAgent(
    input.personalSpaceId,
    input.agentId,
    input.reason
  ));
}

export async function cleanupProjectAgentTestRoles(application, input) {
  return application.personal.cleanupProjectAgentTestRoles(
    input.personalSpaceId,
    input.testSource
  );
}

export async function createProjectAgentAssignment(application, input) {
  const value = await application.personal.createProjectAgentAssignment(
    providerProjectAgentAssignment(input)
  );
  return projectAgentAssignmentRecord(value);
}

export async function listProjectAgentAssignments(application, input) {
  const value = await application.personal.listProjectAgentAssignments({
    personalSpaceId: input.personalSpaceId,
    personalProjectId: input.personalProjectId ?? null,
    agentId: input.agentId ?? null,
    status: input.status ?? null
  });
  return asList(value, ['assignments', 'items']).map(projectAgentAssignmentRecord);
}

export async function endProjectAgentAssignment(application, input) {
  const value = await application.personal.endProjectAgentAssignment(
    providerProjectAgentAssignmentEnd(input)
  );
  return projectAgentAssignmentRecord(value);
}

export async function replaceProjectAgentAssignment(application, input) {
  const value = await application.personal.replaceProjectAgentAssignment(
    providerProjectAgentAssignmentReplace(input)
  );
  return {
    ended: projectAgentAssignmentRecord(value.ended),
    replacement: projectAgentAssignmentRecord(value.replacement)
  };
}

export async function submitProjectAgentTask(application, input) {
  const value = await application.personal.submitProjectAgentTask(
    providerProjectAgentTaskSubmit(input)
  );
  return projectAgentTaskRouteResult(value);
}

export async function coordinateProjectAgentTask(
  application,
  projectResolution,
  input
) {
  const projectId = projectResolution.personalProjectId ??
    projectResolution.personal_project_id ?? null;
  if (!projectId) {
    return {
      status: 'project_unresolved',
      personal_space_id: application.config.personal.spaceId,
      personal_project_id: null,
      project_resolution: projectResolution,
      required_action: projectResolution.status === 'ambiguous'
        ? 'Run from the exact project directory; Fuli will not guess among workspace children.'
        : 'Register this repository or directory as one local personal project first.',
      host_execution_required: false,
      worker_plan: []
    };
  }

  const route = await submitProjectAgentTask(application, {
    personalSpaceId: application.config.personal.spaceId,
    personalProjectId: projectId,
    idempotencyKey: input.idempotencyKey,
    title: input.title,
    objective: input.objective,
    workKind: input.workKind,
    requiredCapabilities: input.requiredCapabilities,
    duration: input.duration,
    staffingIntent: input.staffingIntent,
    leadAgentId: input.leadAgentId,
    collaboratorAgentIds: input.collaboratorAgentIds,
    coordinatorAgentId: input.coordinatorAgentId,
    complexityHint: input.complexityHint,
    parallelPlan: input.parallelPlan,
    modelStrategyOverride: input.modelStrategyOverride,
    executorPolicyOverride: input.executorPolicyOverride,
    sourceApplication: input.sourceApplication,
    sourceSessionId: input.sourceSessionId,
    routingReason: input.routingReason,
    recruitmentProfile: input.recruitmentProfile
  });
  const participants = route.task.participants ?? [];
  const boundaries = route.task.routingDecision?.parallelPlan?.workstreamBoundaries ?? [];
  const contexts = await Promise.all(participants.map((participant) => (
    getProjectAgentContext(application, projectResolution, {
      agentId: participant.agentId,
      queries: input.contextQueries,
      limitPerQuery: input.contextLimitPerQuery ?? 8,
      includePending: input.includePendingContext ?? false,
      sourceApplication: input.sourceApplication
    })
  )));
  const workerPlan = participants.map((participant, index) => ({
    agent_id: participant.agentId,
    participant_role: participant.role,
    assignment_summary: participant.assignmentSummary ?? null,
    workstream_boundary: boundaries[index] ?? null,
    context_status: contexts[index]?.status ?? 'unavailable',
    context: contexts[index]
  }));
  const contextsReady = workerPlan.every(({ context_status: status }) => status === 'ready');
  const hostExecutionRequired = route.task.status === 'queued' &&
    workerPlan.length > 0 && contextsReady;

  return {
    status: hostExecutionRequired
      ? 'ready_for_host_execution'
      : route.task.status === 'awaiting_recruitment'
        ? 'awaiting_recruitment'
        : route.task.status === 'blocked'
          ? 'blocked'
          : 'context_unavailable',
    personal_space_id: application.config.personal.spaceId,
    personal_project_id: projectId,
    project_resolution: projectResolution,
    route,
    host_execution_required: hostExecutionRequired,
    host_execution_policy: {
      fuli_is_control_plane_only: true,
      start_only_returned_workers: true,
      report_worker_start_and_terminal_events: true,
      report_actual_executor_only_after_real_use: true,
      release_runtime_lease_in_finally: true
    },
    worker_plan: workerPlan,
    unassigned_workstream_boundaries: boundaries.slice(workerPlan.length)
  };
}

export async function listProjectAgentTasks(application, input) {
  const value = await application.personal.listProjectAgentTasks({
    personalSpaceId: input.personalSpaceId,
    personalProjectId: input.personalProjectId ?? null,
    agentId: input.agentId ?? null,
    status: input.status ?? null,
    limit: input.limit ?? null
  });
  return asList(value, ['tasks', 'items']).map(projectAgentTaskRecord);
}

export async function viewProjectAgentTask(application, input) {
  const value = await application.personal.viewProjectAgentTask(
    input.personalSpaceId,
    input.taskId,
    { includeEvents: input.includeEvents ?? true }
  );
  return projectAgentTaskRecord(value.task ?? value);
}

export async function recordProjectAgentTaskActivity(application, input) {
  const value = await application.personal.recordProjectAgentTaskActivity(
    providerProjectAgentTaskActivity(input)
  );
  return value?.task ? projectAgentTaskRecord(value.task) : projectAgentTaskRecord(value);
}

export async function viewProjectAgentActivity(application, input) {
  const value = await application.personal.listProjectAgentActivity({
    personalSpaceId: input.personalSpaceId,
    agentId: input.agentId,
    fromDate: input.fromDate ?? null,
    toDate: input.toDate ?? null
  });
  return projectAgentActivityRecord(value);
}

export async function getProjectAgentCoordinationPolicy(application, input) {
  return projectAgentCoordinationPolicyRecord(
    await application.personal.getProjectAgentCoordinationPolicy(
      input.personalSpaceId,
      input.personalProjectId
    )
  );
}

export async function updateProjectAgentCoordinationPolicy(application, input) {
  return projectAgentCoordinationPolicyRecord(
    await application.personal.updateProjectAgentCoordinationPolicy(
      providerProjectAgentCoordinationPolicy(input)
    )
  );
}

export async function getProjectAgentRecruitmentPolicy(application, input) {
  return projectAgentRecruitmentPolicyRecord(
    await application.personal.getProjectAgentRecruitmentPolicy(input.personalSpaceId)
  );
}

export async function updateProjectAgentRecruitmentPolicy(application, input) {
  return projectAgentRecruitmentPolicyRecord(
    await application.personal.updateProjectAgentRecruitmentPolicy({
      personal_space_id: input.personalSpaceId,
      confirmation_mode: input.confirmationMode
    })
  );
}

export async function listProjectAgentRecruitments(application, input) {
  const value = await application.personal.listProjectAgentRecruitments({
    personalSpaceId: input.personalSpaceId,
    personalProjectId: input.personalProjectId ?? null,
    taskId: input.taskId ?? null,
    status: input.status ?? null
  });
  return asList(value, ['recruitments', 'items']).map(projectAgentRecruitmentRecord);
}

export async function decideProjectAgentRecruitment(application, input) {
  const value = await application.personal.decideProjectAgentRecruitment(
    providerProjectAgentRecruitmentDecision(input)
  );
  return projectAgentRecruitmentRecord(
    value?.recruitment ?? value?.record ?? value
  );
}

export async function upsertExecutor(application, input) {
  return executorRecord(await application.personal.upsertExecutor(providerExecutor(input)));
}

export async function listExecutors(application, input) {
  const value = await application.personal.listExecutors(input.personalSpaceId, {
    capability: input.capability ?? null,
    availableOnly: input.availableOnly ?? false
  });
  return asList(value, ['executors', 'items']).map(executorRecord);
}

export async function getExecutor(application, input) {
  return executorRecord(await application.personal.getExecutor(
    input.personalSpaceId,
    input.executorId
  ));
}

export async function deleteExecutor(application, input) {
  return application.personal.deleteExecutor(input.personalSpaceId, input.executorId);
}

export async function preflightExecutor(application, input) {
  return executorRecord(await application.personal.preflightExecutor(
    providerExecutorPreflight(input)
  ));
}

export async function authorizeExecutor(application, input) {
  return executorRecord(await application.personal.authorizeExecutor(
    providerExecutorAuthorization(input)
  ));
}

export async function reportExecutorHealth(application, input) {
  return executorRecord(await application.personal.reportExecutorHealth(
    providerExecutorHealth(input)
  ));
}

export async function recordProjectAgentExecutorActual(application, input) {
  return executorActualReportRecord(
    await application.personal.recordProjectAgentExecutorActual(
      providerExecutorActualReport(input)
    )
  );
}

export async function upsertExecutorRoutingRule(application, input) {
  return executorRoutingRuleRecord(
    await application.personal.upsertExecutorRoutingRule(
      providerExecutorRoutingRule(input)
    )
  );
}

export async function updateExecutorRoutingRule(application, input) {
  return executorRoutingRuleRecord(
    await application.personal.updateExecutorRoutingRule(
      providerExecutorRoutingRuleUpdate(input)
    )
  );
}

export async function listExecutorRoutingRules(application, input) {
  const value = await application.personal.listExecutorRoutingRules({
    personalSpaceId: input.personalSpaceId,
    scope: input.scope ?? null,
    personalProjectId: input.personalProjectId ?? null,
    taskId: input.taskId ?? null,
    status: input.status ?? null,
    enabled: input.enabled ?? null
  });
  return asList(value, ['rules', 'items']).map(executorRoutingRuleRecord);
}

export async function getExecutorRoutingRule(application, input) {
  return executorRoutingRuleRecord(await application.personal.getExecutorRoutingRule(
    input.personalSpaceId,
    input.ruleId
  ));
}

export async function deleteExecutorRoutingRule(application, input) {
  return application.personal.deleteExecutorRoutingRule(
    input.personalSpaceId,
    input.ruleId
  );
}

export async function recordProjectAgentTaskOutcome(application, input) {
  const value = await application.personal.recordProjectAgentTaskOutcome(
    providerProjectAgentTaskOutcome(input)
  );
  return projectAgentTaskOutcomeRecord(value?.evidence ?? value?.record ?? value);
}

export async function listProjectAgentRoutingLearning(application, input) {
  const value = await application.personal.listProjectAgentRoutingLearning({
    personalSpaceId: input.personalSpaceId,
    personalProjectId: input.personalProjectId ?? null,
    workKind: input.workKind ?? null,
    agentId: input.agentId ?? null,
    executorId: input.executorId ?? null
  });
  return asList(value, ['learning', 'evidence', 'items']).map(routingLearningRecord);
}

export async function ignoreProjectAgentRoutingLearning(application, input) {
  return application.personal.ignoreProjectAgentRoutingLearning({
    personal_space_id: input.personalSpaceId,
    personal_project_id: input.personalProjectId,
    agent_id: input.agentId,
    evidence_id: input.evidenceId ?? input.learningId,
    idempotency_key: input.idempotencyKey,
    reason: input.reason
  });
}

export async function resetProjectAgentRoutingLearning(application, input) {
  return application.personal.resetProjectAgentRoutingLearning({
    personal_space_id: input.personalSpaceId,
    personal_project_id: input.personalProjectId,
    work_kind: input.workKind,
    agent_id: input.agentId,
    executor_id: input.executorId,
    model_strategy: providerModelStrategy(input.modelStrategy ?? input.model_strategy ?? {}),
    model_strategy_key: input.modelStrategyKey ?? input.model_strategy_key,
    idempotency_key: input.idempotencyKey,
    reset_at: input.resetAt,
    reason: input.reason
  });
}

export async function getProjectAgentContext(
  application,
  projectResolution,
  {
    agentId,
    queries,
    limitPerQuery = 12,
    includePending = false,
    sourceApplication = 'other'
  }
) {
  const projectId = projectResolution.personalProjectId ??
    projectResolution.personal_project_id ?? null;
  if (!projectId) {
    return {
      status: 'project_unresolved',
      personal_space_id: application.config.personal.spaceId,
      personal_project_id: null,
      project_resolution: projectResolution,
      required_action: projectResolution.status === 'ambiguous'
        ? 'Run from the exact project directory; Fuli will not guess among workspace children.'
        : 'Register this repository or directory as one local personal project first.'
    };
  }

  const agent = await application.getProjectAgent({
    personalSpaceId: application.config.personal.spaceId,
    personalProjectId: projectId,
    agentId
  });
  if (agent.profile.status !== 'active') {
    return {
      status: 'agent_unavailable',
      personal_space_id: application.config.personal.spaceId,
      personal_project_id: projectId,
      project_agent_id: agentId,
      project_resolution: projectResolution,
      agent,
      executionSummary: agent.executionSummary ?? [],
      required_action: 'Choose an active project Agent or reactivate this Agent before use.'
    };
  }
  if (!(agent.profile.allowedClients ?? []).includes(sourceApplication)) {
    return {
      status: 'client_not_allowed',
      personal_space_id: application.config.personal.spaceId,
      personal_project_id: projectId,
      project_agent_id: agentId,
      project_resolution: projectResolution,
      source_application: sourceApplication,
      agent,
      executionSummary: agent.executionSummary ?? [],
      required_action: (
        'Use a client in this Agent\'s allow-list or update the Agent profile '
        + 'before loading its context.'
      )
    };
  }

  const [preferences, results] = await Promise.all([
    application.getCollaborationPreferences({
      personalProjectId: projectId,
      projectAgentId: agentId,
      agentInvocation: true,
      agentToolName: 'get_project_agent_context'
    }),
    Promise.all(queries.map((query) => application.searchKnowledge({
      personalSpaceId: application.config.personal.spaceId,
      personalProjectId: projectId,
      projectAgentId: agentId,
      query,
      limit: limitPerQuery,
      includePending,
      agentInvocation: true,
      agentToolName: 'get_project_agent_context'
    })))
  ]);

  return {
    status: 'ready',
    personal_space_id: application.config.personal.spaceId,
    personal_project_id: projectId,
    project_agent_id: agentId,
    source_application: sourceApplication,
    project_resolution: projectResolution,
    agent,
    executionSummary: agent.executionSummary ?? [],
    role_instructions: {
      responsibility: agent.profile.responsibility,
      initial_preferences: agent.profile.initialPreferences
    },
    effective_preferences: preferences.effective_preferences,
    deferred_conflicts: preferences.deferred_conflicts,
    active_conflicts: preferences.active_conflicts,
    knowledge_results: results,
    scope_policy: {
      includes_personal_global_preferences: true,
      includes_project_preferences_and_shared_knowledge: true,
      includes_only_selected_agent_preferences_and_memory: true,
      excludes_other_project_agents: true,
      inherited_project_relation_types: ['PART_OF', 'USES_KNOWLEDGE_FROM'],
      max_project_inheritance_hops: 2
    }
  };
}

function asList(value, keys = []) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  for (const key of keys) {
    if (Array.isArray(value[key])) return value[key];
  }
  return [];
}
