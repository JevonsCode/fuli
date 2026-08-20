import assert from 'node:assert/strict';
import test from 'node:test';

import { GraphitiProviderClient } from '../src/graphiti/provider-client.js';
import {
  executorRecord,
  projectAgentProfileRecord,
  projectAgentTaskRecord,
  providerExecutor,
  providerExecutorActualReport,
  providerExecutorAuthorization,
  providerExecutorHealth,
  providerExecutorPreflight,
  providerExecutorRoutingRule,
  providerProjectAgentProfile,
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
  resetProjectAgentRoutingLearning
} from '../src/graphiti/project-agent-workflows.js';

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
  await client.listProjectAgentActivity({
    personalSpaceId: 'space-1',
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
    from: '2026-08-01',
    to: '2026-08-17'
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
    workerStatus: 'completed'
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
    worker_status: 'completed'
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
      summary: '运行了真实测试。',
      worker_status: 'completed'
    }],
    events: [{
      event_id: 'event-real',
      task_id: 'task-real',
      status: 'running',
      summary: 'worker event',
      worker_id: 'worker-1',
      worker_label: '验证工位',
      worker_occupation_emoji: '🔌',
      worker_status: 'completed'
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
    actualModelProvider: null,
    actualModel: null,
    workSummary: '运行了真实测试。',
    summary: '运行了真实测试。',
    status: 'completed',
    workerStatus: 'completed'
  }]);
  assert.equal(task.events[0].workerId, 'worker-1');
  assert.equal(task.events[0].workerStatus, 'completed');

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
  assert.equal(providerShape.actualExecutor, 'codex-local');
  assert.equal(providerShape.workSummary, 'Provider reported the worker result.');
  assert.equal(providerShape.workerStatus, 'completed');
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
