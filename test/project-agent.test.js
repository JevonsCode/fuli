import assert from 'node:assert/strict';
import test from 'node:test';

import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';

const CONFIG = {
  version: 1,
  personal: {
    providerUrl: 'http://127.0.0.1:8787',
    accessToken: 'personal-token',
    principalId: 'person-local',
    spaceId: 'personal-space'
  },
  workspaces: []
};

test('project Agent capture keeps an explicit Agent knowledge boundary', async () => {
  const calls = [];
  const app = application(calls, {
    '/v1/knowledge/commits': { status: 'committed', episode_id: 'episode-1' }
  });

  await app.captureSessionKnowledge({
    ...episodeInput(),
    personalProjectId: 'fuli',
    projectAgentId: 'activity-agent'
  });

  const commit = calls.find(({ path }) => path === '/v1/knowledge/commits');
  assert.equal(commit.body.personal_project_id, 'fuli');
  assert.equal(commit.body.project_agent_id, 'activity-agent');
});

test('project Agent directory maps profiles without coupling them to a model', async () => {
  const calls = [];
  const app = application(calls, {
    '/v1/project-agents': projectAgentProviderRecord()
  });

  const result = await app.upsertProjectAgent({
    personalSpaceId: 'personal-space',
    personalProjectId: 'fuli',
    agentId: 'activity-agent',
    profile: projectAgentInputProfile()
  });

  assert.equal(result.agentId, 'activity-agent');
  assert.deepEqual(result.profile.initialPreferences, ['先给结论']);
  const request = calls.find(({ path }) => path === '/v1/project-agents');
  assert.deepEqual(request.body, {
    personal_space_id: 'personal-space',
    personal_project_id: 'fuli',
    agent_id: 'activity-agent',
    profile: {
      name: '活动 Agent',
      responsibility: '负责活动方案与复盘。',
      capabilities: ['活动策划'],
      initial_preferences: ['先给结论'],
      status: 'active'
    }
  });
});

test('project Agent directory can request every project in a personal space', async () => {
  const calls = [];
  const app = application(calls, {
    '/v1/project-agents': [projectAgentProviderRecord()]
  });

  const result = await app.listProjectAgents({
    personalSpaceId: 'personal-space'
  });

  assert.equal(result[0].profile.name, '活动 Agent');
  const request = calls.find(({ path }) => path === '/v1/project-agents');
  assert.equal(request.query.personal_space_id, 'personal-space');
  assert.equal('personal_project_id' in request.query, false);
});

test('project Agent context loads only the selected Agent scope', async () => {
  const calls = [];
  const app = application(calls, {
    '/v1/personal-projects': [{
      project_id: 'fuli',
      profile: { name: 'Fuli', sources: [], boundaries: [] }
    }],
    '/v1/project-agents/activity-agent': projectAgentProviderRecord(),
    '/v1/collaboration-preferences': {
      personal_space_id: 'personal-space',
      personal_project_id: 'fuli',
      project_agent_id: 'activity-agent',
      global_preferences: [],
      project_preferences: [],
      agent_preferences: [],
      effective_preferences: [],
      conflicts: []
    },
    '/v1/preference-conflicts': [],
    '/v1/search': { facts: [], entities: [{ id: 'agent-memory' }] }
  });

  const result = await app.getProjectAgentContext({
    projectPath: process.cwd(),
    agentId: 'activity-agent',
    queries: ['活动复盘格式']
  });

  assert.equal(result.status, 'ready');
  assert.equal(result.project_agent_id, 'activity-agent');
  assert.equal(result.knowledge_results[0].entities[0].id, 'agent-memory');
  const preferenceCall = calls.find(
    ({ path }) => path === '/v1/collaboration-preferences'
  );
  assert.equal(preferenceCall.query.project_agent_id, 'activity-agent');
  const searchCall = calls.find(({ path }) => path === '/v1/search');
  assert.equal(searchCall.body.project_agent_id, 'activity-agent');
  assert.equal(result.scope_policy.excludes_other_project_agents, true);
});

test('project Agent context exposes Provider-reported worker execution summaries', async () => {
  const calls = [];
  const app = application(calls, {
    '/v1/personal-projects': [{
      project_id: 'fuli',
      profile: { name: 'Fuli', sources: [], boundaries: [] }
    }],
    '/v1/project-agents/activity-agent': projectAgentProviderRecord({
      executionSummary: [{
        worker_id: 'worker-context-1',
        worker_label: '🔌 集成工程师',
        worker_occupation_emoji: '🔌',
        actual_executor_id: 'codex',
        source_application: 'codex',
        summary: '验证任务上下文透传。',
        worker_status: 'completed'
      }]
    }),
    '/v1/collaboration-preferences': {
      personal_space_id: 'personal-space',
      personal_project_id: 'fuli',
      project_agent_id: 'activity-agent',
      global_preferences: [],
      project_preferences: [],
      agent_preferences: [],
      effective_preferences: [],
      conflicts: []
    },
    '/v1/preference-conflicts': [],
    '/v1/search': { facts: [], entities: [] }
  });

  const result = await app.getProjectAgentContext({
    projectPath: process.cwd(),
    agentId: 'activity-agent',
    queries: ['活动复盘格式']
  });

  assert.deepEqual(result.executionSummary, [{
    agentId: null,
    agentName: null,
    occupationEmoji: null,
    workerId: 'worker-context-1',
    workerLabel: '🔌 集成工程师',
    workerOccupationEmoji: '🔌',
    participantRole: null,
    executor: 'codex',
    executorId: 'codex',
    actualExecutor: 'codex',
    sourceApplication: 'codex',
    actualModelProvider: null,
    actualModel: null,
    workSummary: '验证任务上下文透传。',
    summary: '验证任务上下文透传。',
    status: 'completed',
    workerStatus: 'completed'
  }]);
  assert.deepEqual(result.agent.executionSummary, result.executionSummary);
});

test('project Agent context refuses a client outside the Agent allow-list', async () => {
  const calls = [];
  const app = application(calls, {
    '/v1/personal-projects': [{
      project_id: 'fuli',
      profile: { name: 'Fuli', sources: [], boundaries: [] }
    }],
    '/v1/project-agents/activity-agent': projectAgentProviderRecord({
      allowedClients: ['claude_code']
    })
  });

  const result = await app.getProjectAgentContext({
    projectPath: process.cwd(),
    agentId: 'activity-agent',
    queries: ['活动复盘格式'],
    sourceApplication: 'codex'
  });

  assert.equal(result.status, 'client_not_allowed');
  assert.equal(result.source_application, 'codex');
  assert.equal(calls.some(({ path }) => path === '/v1/search'), false);
  assert.equal(
    calls.some(({ path }) => path === '/v1/collaboration-preferences'),
    false
  );
});

test('project Agent coordinator returns isolated contexts for the Provider-selected team', async () => {
  const calls = [];
  const app = application(calls, {
    '/v1/personal-projects': [{
      project_id: 'fuli',
      profile: { name: 'Fuli', sources: [], boundaries: [] }
    }],
    '/v1/project-agent-tasks': {
      task: {
        task_id: 'task-team-1',
        personal_space_id: 'personal-space',
        personal_project_id: 'fuli',
        status: 'queued',
        revision: 0,
        participants: [{
          agent_id: 'agent-a', role: 'lead', status: 'queued',
          assignment_summary: '实现桥接。'
        }, {
          agent_id: 'agent-b', role: 'collaborator', status: 'queued',
          assignment_summary: '验证桥接。'
        }],
        routing_decision: {
          parallel_plan: {
            enabled: true,
            workstream_boundaries: ['src/', 'test/']
          }
        },
        events: []
      },
      assigned_agent: null,
      recruitment: null,
      decision: 'assigned_existing'
    },
    '/v1/project-agents/agent-a': projectAgentProviderRecord({ agentId: 'agent-a' }),
    '/v1/project-agents/agent-b': projectAgentProviderRecord({ agentId: 'agent-b' }),
    '/v1/collaboration-preferences': {
      personal_space_id: 'personal-space',
      personal_project_id: 'fuli',
      global_preferences: [],
      project_preferences: [],
      agent_preferences: [],
      effective_preferences: [],
      conflicts: []
    },
    '/v1/preference-conflicts': [],
    '/v1/search': { facts: [], entities: [] }
  });

  const result = await app.coordinateProjectAgentTask({
    projectPath: process.cwd(),
    idempotencyKey: 'coordinate-team-1',
    title: '实现宿主桥接',
    objective: '让持久 Agent 对应按需启动的真实工作进程。',
    workKind: 'implementation',
    routingReason: '复杂任务由项目协调者排班。',
    contextQueries: ['宿主桥接', '生命周期测试'],
    sourceApplication: 'codex'
  });

  assert.equal(result.status, 'ready_for_host_execution');
  assert.equal(result.host_execution_required, true);
  assert.deepEqual(result.worker_plan.map((worker) => [
    worker.agent_id,
    worker.participant_role,
    worker.workstream_boundary,
    worker.context_status
  ]), [
    ['agent-a', 'lead', 'src/', 'ready'],
    ['agent-b', 'collaborator', 'test/', 'ready']
  ]);
  const submit = calls.find(({ path }) => path === '/v1/project-agent-tasks');
  assert.equal(submit.body.personal_space_id, 'personal-space');
  assert.equal(submit.body.personal_project_id, 'fuli');
  assert.equal(submit.body.source_application, 'codex');
  assert.deepEqual(
    calls.filter(({ path }) => path === '/v1/search')
      .map(({ body }) => body.project_agent_id),
    ['agent-a', 'agent-a', 'agent-b', 'agent-b']
  );
});

test('project Agent coordinator never routes work when the local project is unresolved', async () => {
  const calls = [];
  const app = application(calls, {
    '/v1/personal-projects': [{
      project_id: 'another-project',
      profile: { name: 'Another', sources: [], boundaries: [] }
    }]
  });

  const result = await app.coordinateProjectAgentTask({
    projectPath: process.cwd(),
    idempotencyKey: 'coordinate-unresolved-1',
    title: 'Do not route',
    objective: 'Require an exact project match.',
    workKind: 'verification',
    routingReason: 'Project scope must be exact.',
    contextQueries: ['exact scope']
  });

  assert.equal(result.status, 'project_unresolved');
  assert.equal(result.host_execution_required, false);
  assert.deepEqual(result.worker_plan, []);
  assert.equal(calls.some(({ path }) => path === '/v1/project-agent-tasks'), false);
});

function application(calls, routes) {
  return new FederatedGraphApplication(CONFIG, {
    fetchImpl: providerFetch(calls, routes)
  });
}

function projectAgentInputProfile() {
  return {
    name: '活动 Agent',
    responsibility: '负责活动方案与复盘。',
    capabilities: ['活动策划'],
    initialPreferences: ['先给结论'],
    status: 'active'
  };
}

function projectAgentProviderRecord({
  agentId = 'activity-agent',
  allowedClients = ['codex', 'claude_code', 'cursor', 'kiro', 'other'],
  executionSummary = null
} = {}) {
  return {
    agent_id: agentId,
    personal_space_id: 'personal-space',
    personal_project_id: 'fuli',
    profile: {
      name: '活动 Agent',
      responsibility: '负责活动方案与复盘。',
      capabilities: ['活动策划'],
      initial_preferences: ['先给结论'],
      allowed_clients: allowedClients,
      status: 'active'
    },
    ...(executionSummary ? { execution_summary: executionSummary } : {}),
    created_at: '2026-08-17T00:00:00Z',
    updated_at: '2026-08-17T00:00:00Z'
  };
}

function episodeInput() {
  return {
    targetKind: 'personal',
    spaceId: 'personal-space',
    sessionId: 'session-1',
    idempotencyKey: 'project-agent-memory-1',
    name: '活动复盘偏好',
    sourceKind: 'conversation',
    sourceDescription: '用户确认了活动复盘格式。',
    referenceTime: '2026-08-17T00:00:00Z',
    entities: [{
      key: 'activity.format',
      name: '活动复盘格式',
      type: 'Preference',
      originQuadrant: 'known_known',
      confirmationStatus: 'pending',
      confirmationBasis: {
        existenceReason: '当前任务提出了这条候选偏好。',
        quadrantReason: '这是待确认的项目 Agent 偏好。',
        proposedBy: { kind: 'agent', label: 'Codex' }
      }
    }],
    relationships: []
  };
}

function providerFetch(calls, routes) {
  return async (rawUrl, options = {}) => {
    const url = new URL(rawUrl);
    calls.push({
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body: options.body ? JSON.parse(options.body) : null
    });
    return new Response(JSON.stringify(routes[url.pathname] ?? []), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };
}
