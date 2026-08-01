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
      'human'
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
