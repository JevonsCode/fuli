import assert from 'node:assert/strict';
import test from 'node:test';

import { createServer } from '../src/server.js';
import { closeServer, getJson, requestJson } from '../test-support/server.js';

test('Web server exposes the Graphiti facade and graph console', async () => {
  const calls = [];
  const app = graphApp(calls);
  const { server, url } = await createServer({ app, port: 0 });
  try {
    const state = await getJson(`${url}/api/state`);
    assert.equal(state.mode, 'graphiti');

    const policy = await requestJson(`${url}/api/capture-policy`, {
      method: 'PATCH',
      body: { enabled: false }
    });
    assert.equal(policy.status, 200);
    assert.equal(policy.body.enabled, false);
    assert.equal((await getJson(`${url}/api/capture-policy`)).enabled, false);

    const agentAccess = await requestJson(`${url}/api/agent-access-policy`, {
      method: 'PATCH',
      body: { enabled: false }
    });
    assert.equal(agentAccess.status, 200);
    assert.equal(agentAccess.body.enabled, false);
    assert.equal(
      (await getJson(`${url}/api/agent-access-policy`)).enabled,
      false
    );

    const search = await getJson(
      `${url}/api/search?personalSpaceId=personal-1&q=rule&projectId=project-1` +
      '&personalProjectId=project-a&contextPersonalProjectId=project-b' +
      '&contextPersonalProjectId=project-c'
    );
    assert.deepEqual(search, { query: 'rule', facts: [] });
    const input = calls.find(([name]) => name === 'search')[1];
    assert.deepEqual(input.projectIds, ['project-1']);
    assert.equal(input.personalProjectId, 'project-a');
    assert.deepEqual(input.contextPersonalProjectIds, ['project-b', 'project-c']);

    await getJson(`${url}/api/graph?spaceId=personal-1&limit=100&offset=0`);
    assert.deepEqual(calls.find(([name]) => name === 'graph')[1], {
      spaceId: 'personal-1',
      providerUrl: null,
      personalProjectId: null,
      limit: 100,
      offset: 0
    });

    const writingTaste = await getJson(
      `${url}/api/writing-taste-profile?personalSpaceId=personal-1&limit=120`
    );
    assert.equal(writingTaste.status, 'collecting');
    assert.deepEqual(calls.find(([name]) => name === 'writing-taste')[1], {
      personalSpaceId: 'personal-1',
      personalProjectId: null,
      limit: 120
    });

    await getJson(
      `${url}/api/project-agents?personalSpaceId=personal-1&status=active`
    );
    assert.deepEqual(calls.find(([name]) => name === 'project-agent-list')[1], {
      personalSpaceId: 'personal-1',
      personalProjectId: null,
      status: 'active',
      capability: null
    });

    const agentInput = {
      personalSpaceId: 'personal-1',
      personalProjectId: 'project-a',
      agentId: 'activity-agent',
      profile: {
        name: '活动 Agent',
        responsibility: '负责活动方案与复盘。',
        capabilities: ['活动策划'],
        initialPreferences: [],
        status: 'active'
      }
    };
    await requestJson(`${url}/api/project-agents`, {
      method: 'PUT',
      body: agentInput
    });
    assert.deepEqual(
      calls.find(([name]) => name === 'project-agent-upsert')[1],
      agentInput
    );

    const tasks = await getJson(
      `${url}/api/project-agent-tasks?personalSpaceId=personal-1&agentId=activity-agent` +
      '&status=completed&limit=25'
    );
    assert.deepEqual(tasks, []);
    assert.deepEqual(calls.find(([name]) => name === 'project-agent-task-list')[1], {
      personalSpaceId: 'personal-1',
      personalProjectId: null,
      agentId: 'activity-agent',
      status: 'completed',
      limit: 25
    });

    const contextInput = {
      projectPath: '/project',
      agentId: 'activity-agent',
      queries: ['活动复盘']
    };
    await requestJson(`${url}/api/project-agent-context`, {
      method: 'POST',
      body: contextInput
    });
    assert.deepEqual(
      calls.find(([name]) => name === 'project-agent-context')[1],
      contextInput
    );

    const agentArchive = await fetch(
      `${url}/api/project-agents/activity-agent?personalSpaceId=personal-1&reason=retired`,
      { method: 'DELETE' }
    );
    assert.equal(agentArchive.status, 200);
    assert.deepEqual(calls.find(([name]) => name === 'project-agent-delete')[1], {
      personalSpaceId: 'personal-1',
      agentId: 'activity-agent',
      reason: 'retired'
    });
    const cleanup = await requestJson(
      `${url}/api/project-agents/test-cleanup?personalSpaceId=personal-1&testSource=e2e-1`,
      { method: 'POST', body: {} }
    );
    assert.equal(cleanup.status, 200);
    assert.deepEqual(calls.find(([name]) => name === 'project-agent-test-cleanup')[1], {
      personalSpaceId: 'personal-1',
      testSource: 'e2e-1'
    });
    const unsupportedTaskUpdate = await fetch(
      `${url}/api/project-agent-tasks/task-1?personalSpaceId=personal-1`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'running' })
      }
    );
    assert.equal(unsupportedTaskUpdate.status, 404);

    const learningUpdate = await requestJson(
      `${url}/api/project-agent-learning/evidence-1`,
      {
        method: 'PATCH',
        body: {
          action: 'ignore',
          personalSpaceId: 'personal-1',
          personalProjectId: 'project-a',
          agentId: 'activity-agent',
          idempotencyKey: 'learning-ignore-1',
          reason: 'Explicit test evidence review'
        }
      }
    );
    assert.equal(learningUpdate.status, 200);
    assert.deepEqual(
      calls.find(([name]) => name === 'project-agent-learning-ignore')[1],
      {
        action: 'ignore',
        personalSpaceId: 'personal-1',
        personalProjectId: 'project-a',
        agentId: 'activity-agent',
        evidenceId: 'evidence-1',
        idempotencyKey: 'learning-ignore-1',
        reason: 'Explicit test evidence review'
      }
    );

    const actualReport = await requestJson(
      `${url}/api/project-agent-executor-actuals`,
      {
        method: 'POST',
        body: {
          personalSpaceId: 'personal-1',
          personalProjectId: 'project-a',
          taskId: 'task-1',
          runId: 'run-1',
          agentId: 'activity-agent',
          executorId: 'executor-1',
          provider: 'openai',
          model: 'model-x',
          idempotencyKey: 'actual-report-1',
          occurredAt: '2026-08-17T00:00:00Z'
        }
      }
    );
    assert.equal(actualReport.status, 200);
    assert.equal(
      calls.find(([name]) => name === 'project-agent-executor-actual')[1].executorId,
      'executor-1'
    );

    const authorization = await requestJson(
      `${url}/api/executors/authorization`,
      {
        method: 'POST',
        body: {
          personalSpaceId: 'personal-1',
          executorId: 'executor-1',
          status: 'authorized',
          reason: 'Approved for this workspace.',
          idempotencyKey: 'authorization-1'
        }
      }
    );
    assert.equal(authorization.status, 200);
    assert.equal(
      calls.find(([name]) => name === 'executor-authorization')[1].executorId,
      'executor-1'
    );

    const health = await requestJson(
      `${url}/api/executors/health`,
      {
        method: 'POST',
        body: {
          personalSpaceId: 'personal-1',
          executorId: 'executor-1',
          status: 'healthy',
          checkedAt: '2026-08-17T00:00:00Z',
          idempotencyKey: 'health-report-1',
          sourceApplication: 'codex'
        }
      }
    );
    assert.equal(health.status, 200);
    assert.equal(
      calls.find(([name]) => name === 'executor-health')[1].status,
      'healthy'
    );

    const unsubscribe = await fetch(
      `${url}/api/subscriptions/project-1?` + new URLSearchParams({
        personalSpaceId: 'personal-1',
        providerUrl: 'https://workspace.example'
      }),
      { method: 'DELETE' }
    );
    assert.equal(unsubscribe.status, 200);
    assert.deepEqual(calls.find(([name]) => name === 'unsubscribe')[1], {
      personalSpaceId: 'personal-1',
      projectId: 'project-1',
      providerUrl: 'https://workspace.example'
    });

    const batchInput = {
      personalSpaceId: 'personal-1',
      groupKind: 'source',
      groupValue: 'episode-1',
      reason: 'Reviewed the source group.',
      confirmer: { kind: 'user' },
      items: [{ itemId: 'a' }, { itemId: 'b' }]
    };
    const batch = await requestJson(`${url}/api/knowledge/batch-confirmation`, {
      method: 'POST',
      body: batchInput
    });
    assert.equal(batch.status, 200);
    assert.deepEqual(
      calls.find(([name]) => name === 'batch-confirm')[1],
      { ...batchInput, operationActor: 'human' }
    );

    const queued = await getJson(
      `${url}/api/preference-conflicts?personalSpaceId=personal-1&status=ai_pending`
    );
    assert.deepEqual(queued, []);
    assert.deepEqual(
      calls.find(([name]) => name === 'preference-conflicts')[1],
      {
        personalSpaceId: 'personal-1',
        status: 'ai_pending',
        limit: 500
      }
    );

    const deferred = await requestJson(`${url}/api/preference-conflicts/defer`, {
      method: 'POST',
      body: {
        personalSpaceId: 'personal-1',
        conflictId: 'conflict-1',
        preferenceKey: 'tone',
        preferenceScope: 'global',
        leftItemId: 'left',
        leftItemKind: 'entity',
        rightItemId: 'right',
        rightItemKind: 'entity',
        reason: '使用时交给 AI 判断。'
      }
    });
    assert.equal(deferred.status, 200);
    assert.equal(
      calls.find(([name]) => name === 'defer-preference-conflict')[1].operationActor,
      'agent'
    );

    const completed = await requestJson(
      `${url}/api/preference-conflicts/conflict-1/complete`,
      {
        method: 'POST',
        body: {
          personalSpaceId: 'personal-1',
          resolution: 'merge',
          reason: '用户已完成合并。'
        }
      }
    );
    assert.equal(completed.status, 200);
    assert.equal(
      calls.find(([name]) => name === 'complete-preference-conflict')[1].conflictId,
      'conflict-1'
    );

    const html = await fetch(url).then((response) => response.text());
    assert.match(html, /id="app"/);
    assert.match(html, /\/assets\/.+\.js/);

    const routedHtml = await fetch(`${url}/personal/personal-1/projects/graph`)
      .then((response) => response.text());
    assert.match(routedHtml, /id="app"/);
  } finally {
    await closeServer(server);
  }
});

function graphApp(calls) {
  let capturePolicy = { enabled: true, updatedAt: null };
  let agentAccessPolicy = { enabled: true, updatedAt: null };
  return {
    graphiti: true,
    state: async () => ({ mode: 'graphiti', personalSpaces: [], projects: [], subscriptions: [] }),
    searchKnowledge: async (input) => {
      calls.push(['search', input]);
      return { query: input.query, facts: [] };
    },
    getKnowledgeGraph: async (input) => {
      calls.push(['graph', input]);
      return { nodes: [], edges: [], truncated: false };
    },
    getWritingTasteProfile: async (input) => {
      calls.push(['writing-taste', input]);
      return { status: 'collecting', ready: false, rules: [] };
    },
    listProjectAgents: async (input) => {
      calls.push(['project-agent-list', input]);
      return [];
    },
    upsertProjectAgent: async (input) => {
      calls.push(['project-agent-upsert', input]);
      return input;
    },
    getProjectAgentContext: async (input) => {
      calls.push(['project-agent-context', input]);
      return { status: 'ready' };
    },
    deleteProjectAgent: async (input) => {
      calls.push(['project-agent-delete', input]);
      return input;
    },
    cleanupProjectAgentTestRoles: async (input) => {
      calls.push(['project-agent-test-cleanup', input]);
      return { archivedCount: 1 };
    },
    listProjectAgentTasks: async (input) => {
      calls.push(['project-agent-task-list', input]);
      return [];
    },
    ignoreProjectAgentRoutingLearning: async (input) => {
      calls.push(['project-agent-learning-ignore', input]);
      return input;
    },
    resetProjectAgentRoutingLearning: async (input) => {
      calls.push(['project-agent-learning-reset', input]);
      return input;
    },
    recordProjectAgentExecutorActual: async (input) => {
      calls.push(['project-agent-executor-actual', input]);
      return input;
    },
    authorizeExecutor: async (input) => {
      calls.push(['executor-authorization', input]);
      return input;
    },
    reportExecutorHealth: async (input) => {
      calls.push(['executor-health', input]);
      return input;
    },
    captureSessionKnowledge: async () => ({}),
    confirmKnowledgeBatch: async (input) => {
      calls.push(['batch-confirm', input]);
      return { confirmed_count: input.items.length };
    },
    listPreferenceConflicts: async (input) => {
      calls.push(['preference-conflicts', input]);
      return [];
    },
    deferPreferenceConflict: async (input) => {
      calls.push(['defer-preference-conflict', input]);
      return { id: input.conflictId, status: 'ai_pending' };
    },
    completePreferenceConflict: async (input) => {
      calls.push(['complete-preference-conflict', input]);
      return { id: input.conflictId, status: 'resolved' };
    },
    getCapturePolicy: () => capturePolicy,
    updateCapturePolicy: ({ enabled }) => {
      if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean');
      capturePolicy = { enabled, updatedAt: '2026-07-22T10:00:00.000Z' };
      return capturePolicy;
    },
    getAgentAccessPolicy: () => agentAccessPolicy,
    updateAgentAccessPolicy: ({ enabled }) => {
      if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean');
      agentAccessPolicy = { enabled, updatedAt: '2026-07-28T10:00:00.000Z' };
      return agentAccessPolicy;
    },
    subscribePublicProject: async () => ({}),
    unsubscribePublicProject: async (input) => {
      calls.push(['unsubscribe', input]);
      return { project_id: input.projectId, deleted: true };
    },
    listReviewQueue: async () => ({ proposals: [] }),
    reviewProposal: async () => ({}),
    getGraphitiStatus: async () => ({ personal: {}, workspaces: [] }),
    close: () => calls.push(['close'])
  };
}
