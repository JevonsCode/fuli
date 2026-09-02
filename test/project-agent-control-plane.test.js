import assert from 'node:assert/strict';
import test from 'node:test';

import { GraphitiProviderClient } from '../src/graphiti/provider-client.js';
import {
  executorRecord,
  projectAgentActivityRecord,
  projectAgentCoordinationPolicyRecord,
  projectAgentRecruitmentPolicyRecord,
  projectAgentProfileRecord,
  projectAgentTaskRouteResult,
  projectAgentTaskRecord,
  providerExecutor,
  providerExecutorActualReport,
  providerExecutorAuthorization,
  providerExecutorHealth,
  providerExecutorPreflight,
  providerExecutorRoutingRule,
  providerProjectAgentCoordinationPolicy,
  providerProjectAgentProfile,
  providerProjectAgentTaskSubmit,
  providerProjectAgentTaskActivity
} from '../src/graphiti/project-agent-mapping.js';
import {
  projectAgentProfile,
  projectAgentTaskActivityInput,
  projectAgentTaskSubmitInput
} from '../src/agent-tools/project-agent-definitions.js';
import {
  listExecutors,
  listProjectAgentRoutingLearning,
  resetProjectAgentRoutingLearning,
  viewProjectAgentActivity,
  viewProjectAgentTask
} from '../src/graphiti/project-agent-workflows.js';

test('legacy recruitment policy warnings survive the Node mapping', () => {
  const warning = 'Use update_project_agent_coordination_policy for the exact project.';
  const mapped = projectAgentRecruitmentPolicyRecord({
    personal_space_id: 'space-1', confirmation_mode: 'automatic',
    policy_status: 'superseded', applies_to_recruitment: false, warning
  });
  assert.equal(mapped.policyStatus, 'superseded');
  assert.equal(mapped.appliesToRecruitment, false);
  assert.equal(mapped.warning, warning);
  assert.equal('policyStatus' in projectAgentRecruitmentPolicyRecord({
    personal_space_id: 'legacy-provider'
  }), false, 'old Provider metadata is unknown, not fabricated');
});

test('task route mapping preserves every recruitment slot for new clients', () => {
  const route = projectAgentTaskRouteResult({
    task: {},
    recruitment: { recruitment_id: 'lead-recruitment' },
    recruitments: [{
      recruitment_id: 'lead-recruitment',
      participant_role: 'lead',
      recruitment_slot: 'lead'
    }, {
      recruitment_id: 'collaborator-recruitment',
      participant_role: 'collaborator',
      recruitment_slot: 'collaborator-1'
    }]
  });

  assert.equal(route.recruitment.recruitmentId, 'lead-recruitment');
  assert.deepEqual(
    route.recruitments.map(({ recruitmentId, participantRole, recruitmentSlot }) => [
      recruitmentId,
      participantRole,
      recruitmentSlot
    ]),
    [
      ['lead-recruitment', 'lead', 'lead'],
      ['collaborator-recruitment', 'collaborator', 'collaborator-1']
    ]
  );
});

test('control-plane provider client uses durable task and activity routes', async () => {
  const calls = [];
  const client = providerClient(calls, {});

  await client.submitProjectAgentTask({
    personal_space_id: 'space-1',
    personal_project_id: 'project-1',
    idempotency_key: 'task-key-1'
  });
  await client.listProjectAgentTasks({
    personalSpaceId: 'space-1',
    personalProjectId: 'project-1',
    agentId: 'agent-1',
    status: 'completed',
    limit: 25
  });
  await client.deleteProjectAgent('space-1', 'agent-1', 'retired');
  await client.cleanupProjectAgentTestRoles('space-1', 'e2e-1');
  await client.recordProjectAgentTaskActivity({
    task_id: 'task-1',
    status: 'completed',
    summary: 'verified'
  });
  await client.viewProjectAgentTask('space-1', 'task-1', {
    personalProjectId: 'project-1',
    includeEvents: false
  });
  await client.listProjectAgentActivity({
    personalSpaceId: 'space-1',
    personalProjectId: 'project-1',
    agentId: 'agent-1',
    fromDate: '2026-08-01',
    toDate: '2026-08-17'
  });

  assert.deepEqual(calls.map(({ path }) => path), [
    '/v1/project-agent-tasks',
    '/v1/project-agent-tasks',
    '/v1/project-agents/agent-1',
    '/v1/project-agents/test-cleanup',
    '/v1/project-agent-tasks/task-1/events',
    '/v1/project-agent-tasks/task-1',
    '/v1/project-agents/agent-1/activity'
  ]);
  assert.deepEqual(calls[1].query, {
    personal_space_id: 'space-1',
    personal_project_id: 'project-1',
    agent_id: 'agent-1',
    status: 'completed',
    limit: '25'
  });
  assert.deepEqual(calls[5].query, {
    personal_space_id: 'space-1',
    personal_project_id: 'project-1',
    include_events: 'false'
  });
  assert.deepEqual(calls[6].query, {
    personal_space_id: 'space-1',
    personal_project_id: 'project-1',
    from: '2026-08-01',
    to: '2026-08-17'
  });
});

test('project-bound task and activity workflows preserve the project scope', async () => {
  const calls = [];
  const application = {
    personal: {
      viewProjectAgentTask: async (...args) => {
        calls.push(['task', ...args]);
        return { task_id: 'task-1' };
      },
      listProjectAgentActivity: async (input) => {
        calls.push(['activity', input]);
        return {
          agent_id: 'agent-1', personal_space_id: 'space-1',
          from_date: '2026-08-01', to_date: '2026-08-17', days: []
        };
      }
    }
  };

  await viewProjectAgentTask(application, {
    personalSpaceId: 'space-1', personalProjectId: 'project-1',
    taskId: 'task-1', includeEvents: false
  });
  await viewProjectAgentActivity(application, {
    personalSpaceId: 'space-1', personalProjectId: 'project-1',
    agentId: 'agent-1', fromDate: '2026-08-01', toDate: '2026-08-17'
  });

  assert.deepEqual(calls, [
    ['task', 'space-1', 'task-1', {
      personalProjectId: 'project-1', includeEvents: false
    }],
    ['activity', {
      personalSpaceId: 'space-1', personalProjectId: 'project-1',
      agentId: 'agent-1', fromDate: '2026-08-01', toDate: '2026-08-17'
    }]
  ]);
});

test('project coordination policy stays project-local across provider seams', async () => {
  const calls = [];
  const client = providerClient(calls, {
    '/v1/project-agent-coordination-policy': {
      personal_space_id: 'space-1',
      personal_project_id: 'activity-intake',
      ask_before_recruitment: true,
      auto_reuse_previous_agent: false,
      updated_at: '2026-08-24T00:00:00Z'
    }
  });

  const loaded = projectAgentCoordinationPolicyRecord(
    await client.getProjectAgentCoordinationPolicy('space-1', 'activity-intake')
  );
  const updated = providerProjectAgentCoordinationPolicy({
    personalSpaceId: 'space-1',
    personalProjectId: 'activity-intake',
    askBeforeRecruitment: false,
    autoReusePreviousAgent: true
  });
  await client.updateProjectAgentCoordinationPolicy(updated);

  assert.deepEqual(loaded, {
    personalSpaceId: 'space-1',
    personalProjectId: 'activity-intake',
    askBeforeRecruitment: true,
    autoReusePreviousAgent: false,
    updatedAt: '2026-08-24T00:00:00Z'
  });
  assert.deepEqual(calls[0].query, {
    personal_space_id: 'space-1',
    personal_project_id: 'activity-intake'
  });
  assert.equal(calls[1].options.method, 'PUT');
  assert.deepEqual(calls[1].body, {
    personal_space_id: 'space-1',
    personal_project_id: 'activity-intake',
    ask_before_recruitment: false,
    auto_reuse_previous_agent: true
  });
});

test('executor registration and routing payloads follow provider-neutral Python contracts', async () => {
  const calls = [];
  const client = providerClient(calls, {});

  await client.upsertExecutor(providerExecutor({
    personalSpaceId: 'space-1',
    executorId: 'codex-local',
    displayName: 'Codex local',
    executorKind: 'external',
    capabilities: ['javascript'],
    advertisedModels: [{ provider: 'openai', model: 'model-x' }],
    idempotencyKey: 'executor-key-1',
    sourceApplication: 'codex'
  }));
  await client.upsertExecutorRoutingRule(providerExecutorRoutingRule({
    personalSpaceId: 'space-1',
    scope: 'project',
    personalProjectId: 'project-1',
    workKind: 'runtime-change',
    requiredCapabilities: ['javascript'],
    executorIds: ['codex-local'],
    priority: 10,
    reason: 'explicit user rule',
    idempotencyKey: 'rule-key-1'
  }));

  assert.equal(calls[0].path, '/v1/executors');
  assert.equal(calls[0].options.method, 'PUT');
  assert.deepEqual(calls[0].body, {
    personal_space_id: 'space-1',
    executor_id: 'codex-local',
    display_name: 'Codex local',
    executor_kind: 'external',
    capabilities: ['javascript'],
    advertised_models: [{
      provider: 'openai',
      model: 'model-x',
      capabilities: [],
      strategy_modes: [],
      reasoning_efforts: [],
      available: true
    }],
    idempotency_key: 'executor-key-1',
    source_application: 'codex'
  });
  assert.equal(calls[1].path, '/v1/executor-routing-rules');
  assert.deepEqual(calls[1].body, {
    personal_space_id: 'space-1',
    scope: 'project',
    personal_project_id: 'project-1',
    work_kind: 'runtime-change',
    required_capabilities: ['javascript'],
    executor_ids: ['codex-local'],
    model_strategy: null,
    priority: 10,
    reason: 'explicit user rule',
    idempotency_key: 'rule-key-1'
  });

  await client.preflightExecutor(providerExecutorPreflight({
    personalSpaceId: 'space-1',
    executorId: 'codex-local',
    status: 'passed',
    workspacePermission: true,
    capabilities: ['javascript'],
    availableModels: [{ provider: 'openai', model: 'model-x', available: true }],
    checkedAt: '2026-08-17T00:00:00Z',
    idempotencyKey: 'preflight-key-1',
    sourceApplication: 'codex'
  }));
  await client.authorizeExecutor(providerExecutorAuthorization({
    personalSpaceId: 'space-1',
    executorId: 'codex-local',
    status: 'authorized',
    reason: 'workspace approval',
    idempotencyKey: 'authorization-key-1'
  }));
  await client.reportExecutorHealth(providerExecutorHealth({
    personalSpaceId: 'space-1',
    executorId: 'codex-local',
    status: 'healthy',
    checkedAt: '2026-08-17T00:00:00Z',
    idempotencyKey: 'health-key-1',
    sourceApplication: 'codex'
  }));
  await client.recordProjectAgentExecutorActual(providerExecutorActualReport({
    personalSpaceId: 'space-1',
    personalProjectId: 'project-1',
    taskId: 'task-1',
    runId: 'run-1',
    agentId: 'agent-1',
    executorId: 'codex-local',
    provider: 'openai',
    model: 'model-x',
    idempotencyKey: 'actual-key-1',
    occurredAt: '2026-08-17T00:00:00Z',
    sourceApplication: 'codex'
  }));
  assert.equal(calls[2].path, '/v1/executors/preflight');
  assert.equal(calls[2].body.status, 'passed');
  assert.equal(calls[2].body.available_models[0].provider, 'openai');
  assert.equal(calls[3].path, '/v1/executors/authorization');
  assert.equal(calls[3].body.status, 'authorized');
  assert.equal(calls[4].path, '/v1/executors/health');
  assert.equal(calls[4].body.status, 'healthy');
  assert.equal(calls[5].path, '/v1/project-agent-executor-actuals');
  assert.equal(calls[5].body.executor_id, 'codex-local');
});

test('task and executor mappings preserve actual audit evidence without inventing connected state', async () => {
  const task = projectAgentTaskRecord({
    task_id: 'task-1',
    personal_space_id: 'space-1',
    personal_project_id: 'project-1',
    actual_executor_id: 'codex-local',
    actual_model_provider: 'openai',
    actual_model: 'model-x',
    matched_executor_rule_id: 'rule-1',
    executor_fallback_reason: 'preflight unavailable',
    audit_id: 'audit-1',
    events: [{
      event_id: 'event-1',
      task_id: 'task-1',
      status: 'completed',
      actor_kind: 'agent',
      summary: 'verified',
      actual_executor_id: 'codex-local',
      matched_executor_rule_id: 'rule-1',
      audit_id: 'audit-2'
    }]
  });
  const executor = executorRecord({
    executor_id: 'codex-local',
    personal_space_id: 'space-1',
    registration_status: 'registered',
    permission_revision: 3
  });

  assert.equal(task.actualExecutor, 'codex-local');
  assert.equal(task.matchedExecutorRuleId, 'rule-1');
  assert.equal(task.fallbackReason, 'preflight unavailable');
  assert.equal(task.auditId, 'audit-1');
  assert.equal(task.events[0].auditId, 'audit-2');
  assert.equal(executor.registrationStatus, 'registered');
  assert.equal(executor.permissionRevision, 3);
  assert.equal('connected' in executor, false);
  assert.deepEqual(providerExecutor({
    personalSpaceId: 'space-1',
    executorId: 'codex-local',
    displayName: 'Codex local',
    idempotencyKey: 'executor-key-1'
  }), {
    personal_space_id: 'space-1',
    executor_id: 'codex-local',
    display_name: 'Codex local',
    executor_kind: 'external',
    capabilities: [],
    advertised_models: [],
    idempotency_key: 'executor-key-1'
  });
});

test('workflow list seams accept provider envelopes and keep learning evidence explicit', async () => {
  let resetPayload = null;
  const application = {
    personal: {
      listExecutors: async () => ({
        items: [{
          executor_id: 'executor-1',
          registration_status: 'registered'
        }]
      }),
      listProjectAgentRoutingLearning: async () => ({
        evidence: [{
          learning_id: 'learning-1',
          evidence_kind: 'explicit_praise',
          contribution: 0.5,
          as_of: '2026-08-17T00:00:00Z',
          half_life: 30,
          status: 'neutral',
          model_strategy: { mode: 'deep', reasoning_effort: 'high' },
          model_strategy_key: 'strategy-key-1'
        }]
      }),
      resetProjectAgentRoutingLearning: async (input) => {
        resetPayload = input;
        return input;
      }
    }
  };

  const executors = await listExecutors(application, { personalSpaceId: 'space-1' });
  const learning = await listProjectAgentRoutingLearning(application, {
    personalSpaceId: 'space-1'
  });

  assert.equal(executors[0].registrationStatus, 'registered');
  assert.equal(learning[0].evidenceKind, 'explicit_praise');
  assert.equal(learning[0].contribution, 0.5);
  assert.equal(learning[0].halfLife, 30);
  assert.equal(learning[0].modelStrategy.mode, 'deep');
  assert.equal(learning[0].modelStrategyKey, 'strategy-key-1');

  await resetProjectAgentRoutingLearning(application, {
    personalSpaceId: 'space-1',
    personalProjectId: 'project-1',
    workKind: 'review',
    agentId: 'agent-1',
    executorId: 'executor-1',
    modelStrategy: { mode: 'deep', reasoningEffort: 'high' },
    modelStrategyKey: 'strategy-key-1',
    idempotencyKey: 'reset-key-1',
    resetAt: '2026-08-17T00:00:00Z',
    reason: 'explicit reset'
  });
  assert.deepEqual(resetPayload.model_strategy, {
    mode: 'deep',
    reasoning_effort: 'high',
    capability_hints: []
  });
  assert.equal(resetPayload.model_strategy_key, 'strategy-key-1');
});

test('task activity mapping sends actual executor fields and no inferred satisfaction', () => {
  assert.deepEqual(providerProjectAgentTaskActivity({
    personalSpaceId: 'space-1',
    personalProjectId: 'project-1',
    taskId: 'task-1',
    idempotencyKey: 'event-key-1',
    status: 'completed',
    summary: 'done',
    actualExecutorId: 'executor-1',
    matchedExecutorRuleId: 'rule-1',
    executorFallbackReason: null,
    sourceApplication: 'codex'
  }), {
    personal_space_id: 'space-1',
    personal_project_id: 'project-1',
    task_id: 'task-1',
    idempotency_key: 'event-key-1',
    status: 'completed',
    summary: 'done',
    agent_id: null,
    actor_kind: 'agent',
    source_application: 'codex',
    source_session_id: null,
    actual_model_provider: null,
    actual_model: null,
    actual_executor_id: 'executor-1',
    matched_executor_rule_id: 'rule-1',
    executor_selection_reason: null,
    executor_fallback_reason: null,
    executor_blocked_reason: null
  });
});

test('activity history exposes session links and concrete tools without inference', () => {
  const activity = projectAgentActivityRecord({
    agent_id: 'agent-1',
    personal_space_id: 'space-1',
    from_date: '2026-08-28',
    to_date: '2026-08-28',
    days: [{
      date: '2026-08-28',
      completed: 1,
      total: 1,
      tasks: [{
        task_id: 'task-1',
        title: 'Evidence task',
        status: 'completed',
        summary: 'Verified.',
        occurred_at: '2026-08-28T00:00:00Z',
        source_session_url: 'codex://threads/01234567-89ab-cdef-0123-456789abcdef',
        tools_used: ['pytest', 'rg']
      }]
    }]
  });

  assert.equal(
    activity.days[0].tasks[0].sourceSessionUrl,
    'codex://threads/01234567-89ab-cdef-0123-456789abcdef'
  );
  assert.deepEqual(activity.days[0].tasks[0].toolsUsed, ['pytest', 'rg']);
});

test('activity history preserves worker and executor audit fields', () => {
  const activity = projectAgentActivityRecord({
    days: [{
      tasks: [{
        task_id: 'task-worker-1',
        title: 'Worker task',
        status: 'completed',
        summary: 'done',
        occurred_at: '2026-08-30T00:00:00Z',
        worker_id: 'worker-1',
        worker_label: '验证工位',
        worker_occupation_emoji: '🔌',
        worker_status: 'completed',
        selected_executor_id: 'codex-local',
        executor_rule_id: 'rule-1',
        actual_executor_id: 'codex-local',
        executor_selection_reason: 'preferred executor',
        executor_fallback_reason: 'fallback reason',
        executor_fallback_outcome: 'fallback outcome',
        executor_blocked_reason: 'blocked reason',
        executor_decision: 'selected',
        audit_id: 'audit-1'
      }]
    }]
  });

  assert.deepEqual(activity.days[0].tasks[0], {
    taskId: 'task-worker-1',
    title: 'Worker task',
    status: 'completed',
    summary: 'done',
    occurredAt: '2026-08-30T00:00:00Z',
    workerId: 'worker-1',
    workerLabel: '验证工位',
    workerOccupationEmoji: '🔌',
    workerStatus: 'completed',
    sourceApplication: null,
    sourceSessionId: null,
    sourceSessionUrl: null,
    toolsUsed: null,
    actualExecutor: 'codex-local',
    selectedExecutorId: 'codex-local',
    executorRuleId: 'rule-1',
    matchedExecutorRuleId: null,
    executorSelectionReason: 'preferred executor',
    executorFallbackReason: 'fallback reason',
    executorFallbackOutcome: 'fallback outcome',
    executorBlockedReason: 'blocked reason',
    executorDecision: 'selected',
    auditId: 'audit-1',
    actualModelProvider: null,
    actualModel: null,
    tokenUsage: null,
    executionSummary: [],
    routingRuleId: null,
    fallbackReason: 'fallback reason',
    fallbackUsed: false
  });
});

test('project Agent profiles expose an optional occupation emoji independently of name', () => {
  assert.equal(projectAgentProfile.properties.occupationEmoji.type.join(','), 'string,null');
  assert.equal(projectAgentProfile.required.includes('occupationEmoji'), false);
  assert.deepEqual(
    projectAgentTaskSubmitInput.properties.recruitmentProfile.properties.occupationEmoji,
    projectAgentProfile.properties.occupationEmoji
  );
  assert.equal(
    providerProjectAgentProfile({
      name: '活动 Agent',
      responsibility: '负责活动方案与复盘。',
      occupationEmoji: '🎭'
    }).occupation_emoji,
    '🎭'
  );
  assert.equal(
    providerProjectAgentProfile({
      name: '旧 Agent',
      responsibility: '保留旧 profile 形状。'
    }).occupation_emoji,
    undefined
  );
  assert.equal(
    providerProjectAgentProfile({
      name: '清除 emoji',
      responsibility: '允许显式清除可选 emoji。',
      occupationEmoji: null
    }).occupation_emoji,
    null
  );
  assert.equal(
    projectAgentProfileRecord({
      name: '活动 Agent',
      responsibility: '负责活动方案与复盘。',
      occupation_emoji: '🎭'
    }).occupationEmoji,
    '🎭'
  );
});

test('task executor hints stay separate from Agent staffing capabilities', () => {
  assert.equal(
    projectAgentTaskSubmitInput.properties.executorCapabilityHints.type,
    'array'
  );
  assert.deepEqual(providerProjectAgentTaskSubmit({
    personalSpaceId: 'space-1',
    personalProjectId: 'project-1',
    idempotencyKey: 'separate-capabilities-1',
    title: 'Verify executor routing',
    objective: 'Keep domain expertise out of runtime capability gates.',
    workKind: 'hotel-planning',
    requiredCapabilities: ['hotel planning', 'research'],
    executorCapabilityHints: ['testing'],
    routingReason: 'Use separate routing vocabularies.'
  }), {
    personal_space_id: 'space-1',
    personal_project_id: 'project-1',
    idempotency_key: 'separate-capabilities-1',
    title: 'Verify executor routing',
    objective: 'Keep domain expertise out of runtime capability gates.',
    work_kind: 'hotel-planning',
    required_capabilities: ['hotel planning', 'research'],
    executor_capability_hints: ['testing'],
    duration: 'ongoing',
    staffing_intent: 'reuse_preferred',
    lead_agent_id: null,
    collaborator_agent_ids: [],
    coordinator_agent_id: null,
    complexity_hint: null,
    parallel_plan: {
      enabled: false,
      independent_verification: false,
      conflict_free_scopes: false,
      reason: null,
      workstream_boundaries: []
    },
    model_strategy_override: null,
    source_application: null,
    source_session_id: null,
    routing_reason: 'Use separate routing vocabularies.',
    recruitment_profile: null,
    executor_policy_override: null
  });
});

test('task activity schema and mapping preserve optional concrete worker attribution', () => {
  assert.deepEqual(projectAgentTaskActivityInput.properties.workerId, {
    type: ['string', 'null'],
    minLength: 1,
    maxLength: 128
  });
  assert.deepEqual(projectAgentTaskActivityInput.properties.workerLabel, {
    type: ['string', 'null'],
    minLength: 1,
    maxLength: 160
  });
  assert.deepEqual(projectAgentTaskActivityInput.properties.workerOccupationEmoji, {
    type: ['string', 'null'],
    minLength: 1,
    maxLength: 32
  });
  assert.deepEqual(projectAgentTaskActivityInput.properties.workerStatus.type, ['string', 'null']);
  assert.deepEqual(projectAgentTaskActivityInput.properties.workerStatus.enum, [
    'awaiting_recruitment', 'queued', 'running', 'paused', 'failed',
    'awaiting_review', 'blocked', 'completed', 'cancelled'
  ]);
  assert.deepEqual(projectAgentTaskActivityInput.properties.tokenUsage.required, [
    'source', 'totalTokens'
  ]);
  assert.deepEqual(projectAgentTaskActivityInput.properties.tokenUsage.properties.source.enum, [
    'executor', 'host', 'dingdong'
  ]);
  assert.equal(projectAgentTaskActivityInput.properties.sourceSessionUrl.maxLength, 2048);
  assert.equal(projectAgentTaskActivityInput.properties.toolsUsed.maxItems, 32);

  assert.deepEqual(providerProjectAgentTaskActivity({
    personalSpaceId: 'space-1',
    personalProjectId: 'project-1',
    taskId: 'task-1',
    idempotencyKey: 'event-worker-1',
    status: 'running',
    summary: 'worker completed its bounded slice',
    workerId: 'worker-1',
    workerLabel: '验证工位',
    workerOccupationEmoji: '🔌',
    workerStatus: 'completed',
    sourceSessionUrl: 'codex://threads/01234567-89ab-cdef-0123-456789abcdef',
    toolsUsed: ['pytest', 'rg'],
    tokenUsage: {
      source: 'executor',
      totalTokens: 150,
      inputTokens: 100,
      outputTokens: 50,
      cachedInputTokens: 25
    }
  }), {
    personal_space_id: 'space-1',
    personal_project_id: 'project-1',
    task_id: 'task-1',
    idempotency_key: 'event-worker-1',
    status: 'running',
    summary: 'worker completed its bounded slice',
    agent_id: null,
    actor_kind: 'agent',
    source_application: null,
    source_session_id: null,
    source_session_url: 'codex://threads/01234567-89ab-cdef-0123-456789abcdef',
    tools_used: ['pytest', 'rg'],
    actual_model_provider: null,
    actual_model: null,
    actual_executor_id: null,
    matched_executor_rule_id: null,
    executor_selection_reason: null,
    executor_fallback_reason: null,
    executor_blocked_reason: null,
    worker_id: 'worker-1',
    worker_label: '验证工位',
    worker_occupation_emoji: '🔌',
    worker_status: 'completed',
    token_usage: {
      source: 'executor',
      total_tokens: 150,
      input_tokens: 100,
      output_tokens: 50,
      cached_input_tokens: 25,
      cache_write_input_tokens: null,
      reasoning_output_tokens: null
    }
  });
});

test('task view mapping exposes empty and provider-reported execution summaries without inference', () => {
  assert.equal(
    Object.hasOwn(projectAgentTaskRecord({ task_id: 'task-absent' }), 'executionSummary'),
    false
  );
  assert.deepEqual(projectAgentTaskRecord({
    task_id: 'task-empty',
    execution_summary: []
  }).executionSummary, []);

  const task = projectAgentTaskRecord({
    task_id: 'task-real',
    execution_summary: [{
      worker_id: 'worker-1',
      worker_label: '验证工位',
      worker_occupation_emoji: '🔌',
      actual_executor_id: 'codex-local',
      source_application: 'codex',
      source_session_id: 'session-worker-1',
      source_session_url: 'codex://threads/01234567-89ab-cdef-0123-456789abcdef',
      tools_used: ['pytest', 'rg'],
      summary: '运行了真实测试。',
      worker_status: 'completed',
      token_usage: {
        source: 'dingdong',
        total_tokens: 1234,
        input_tokens: 1200,
        output_tokens: 34,
        cached_input_tokens: 500,
        cache_write_input_tokens: 0,
        reasoning_output_tokens: 12
      }
    }],
    events: [{
      event_id: 'event-real',
      task_id: 'task-real',
      status: 'running',
      summary: 'worker event',
      worker_id: 'worker-1',
      worker_label: '验证工位',
      worker_occupation_emoji: '🔌',
      worker_status: 'completed',
      source_session_id: 'session-worker-1',
      source_session_url: 'codex://threads/01234567-89ab-cdef-0123-456789abcdef',
      tools_used: ['pytest'],
      token_usage: {
        source: 'dingdong',
        total_tokens: 1234
      }
    }]
  });

  assert.deepEqual(task.executionSummary, [{
    agentId: null,
    agentName: null,
    occupationEmoji: null,
    workerId: 'worker-1',
    workerLabel: '验证工位',
    workerOccupationEmoji: '🔌',
    participantRole: null,
    executor: 'codex-local',
    executorId: 'codex-local',
    actualExecutor: 'codex-local',
    sourceApplication: 'codex',
    sourceSessionId: 'session-worker-1',
    sourceSessionUrl: 'codex://threads/01234567-89ab-cdef-0123-456789abcdef',
    toolsUsed: ['pytest', 'rg'],
    actualModelProvider: null,
    actualModel: null,
    tokenUsage: {
      source: 'dingdong',
      totalTokens: 1234,
      inputTokens: 1200,
      outputTokens: 34,
      cachedInputTokens: 500,
      cacheWriteInputTokens: 0,
      reasoningOutputTokens: 12
    },
    workSummary: '运行了真实测试。',
    summary: '运行了真实测试。',
    status: 'completed',
    workerStatus: 'completed'
  }]);
  assert.equal(task.events[0].workerId, 'worker-1');
  assert.equal(task.events[0].workerStatus, 'completed');
  assert.equal(task.events[0].sourceSessionId, 'session-worker-1');
  assert.equal(
    task.events[0].sourceSessionUrl,
    'codex://threads/01234567-89ab-cdef-0123-456789abcdef'
  );
  assert.deepEqual(task.events[0].toolsUsed, ['pytest']);
  assert.equal(task.events[0].tokenUsage.totalTokens, 1234);

  const providerShape = projectAgentTaskRecord({
    task_id: 'task-provider-shape',
    execution_summary: [{
      agent_id: 'agent-1',
      agent_name: '活动 Agent',
      occupation_emoji: '🎭',
      participant_role: 'lead',
      executor: 'Codex',
      executor_id: 'codex-local',
      source_application: 'codex',
      actual_model_provider: 'openai',
      actual_model: 'gpt-5',
      work_summary: 'Provider reported the worker result.',
      status: 'completed',
      worker_id: 'worker-1',
      worker_label: '🔌 集成工程师',
      worker_occupation_emoji: '🔌'
    }]
  }).executionSummary[0];
  assert.equal(providerShape.agentName, '活动 Agent');
  assert.equal(providerShape.occupationEmoji, '🎭');
  assert.equal(providerShape.executor, 'Codex');
  assert.equal(providerShape.executorId, 'codex-local');
  assert.equal(providerShape.actualExecutor, null);
  assert.equal(providerShape.workSummary, 'Provider reported the worker result.');
  assert.equal(providerShape.workerStatus, null);

  const activityConfiguredOnly = projectAgentActivityRecord({
    agent_id: 'agent-1',
    personal_space_id: 'space-1',
    days: [{
      date: '2026-09-01',
      tasks: [{
        task_id: 'task-configured-only',
        execution_summary: [{
          executor: 'Codex',
          executor_id: 'codex-local',
          selected_executor_id: 'codex-local',
          status: 'completed'
        }]
      }]
    }]
  });
  const configuredOnlySummary = activityConfiguredOnly.days[0].tasks[0].executionSummary[0];
  assert.equal(configuredOnlySummary.executor, 'Codex');
  assert.equal(configuredOnlySummary.executorId, 'codex-local');
  assert.equal(configuredOnlySummary.actualExecutor, null);
  assert.equal(configuredOnlySummary.workerId, null);
  assert.equal(configuredOnlySummary.workerStatus, null);
});

function providerClient(calls, routes) {
  return new GraphitiProviderClient({
    baseUrl: 'http://127.0.0.1:8787',
    accessToken: 'test-token',
    fetchImpl: async (rawUrl, options = {}) => {
      const url = new URL(rawUrl);
      const body = options.body ? JSON.parse(options.body) : null;
      calls.push({
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        options,
        body
      });
      return new Response(JSON.stringify(routes[url.pathname] ?? {}), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  });
}
