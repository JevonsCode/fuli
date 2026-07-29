import assert from 'node:assert/strict';
import test from 'node:test';

import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';

test('material knowledge use maps to the personal usage audit endpoint', async () => {
  const calls = [];
  const app = new FederatedGraphApplication({
    version: 1,
    personal: {
      providerUrl: 'http://127.0.0.1:8787',
      accessToken: 'personal-token',
      principalId: 'person-local',
      spaceId: 'personal-space'
    },
    workspaces: []
  }, {
    fetchImpl: async (rawUrl, options = {}) => {
      const url = new URL(rawUrl);
      calls.push({
        path: url.pathname,
        body: options.body ? JSON.parse(options.body) : null
      });
      return new Response(JSON.stringify({
        recorded_count: 1,
        duplicate_count: 0,
        promoted_count: 0,
        items: []
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  });

  const result = await app.recordKnowledgeUsage({
    personalSpaceId: 'personal-space',
    taskId: 'task-1',
    sessionId: 'session-1',
    toolName: 'search_knowledge_graph',
    items: [{
      itemId: 'entity-1',
      itemKind: 'entity',
      useKind: 'applied'
    }]
  });

  assert.equal(result.recorded_count, 1);
  assert.equal(calls[0].path, '/v1/knowledge/usage');
  assert.deepEqual(calls[0].body, {
    personal_space_id: 'personal-space',
    task_id: 'task-1',
    session_id: 'session-1',
    tool_name: 'search_knowledge_graph',
    items: [{
      item_id: 'entity-1',
      item_kind: 'entity',
      use_kind: 'applied'
    }]
  });
});
