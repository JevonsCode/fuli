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

test('Agent deferred-conflict resolution maps one audited decision to the personal Provider',
  async () => {
    const calls = [];
    const app = new FederatedGraphApplication(CONFIG, {
      fetchImpl: providerFetch(calls, {
        '/v1/preference-conflicts/conflict-1/resolve': {
          id: 'conflict-1',
          status: 'resolved',
          resolved_by: 'agent',
          resolution: 'merge'
        }
      })
    });

    const result = await app.resolveDeferredPreferenceConflict({
      personalSpaceId: 'personal-space',
      conflictId: 'conflict-1',
      resolution: 'merge',
      canonicalItemId: 'preference-b',
      mergedInstruction: '保留双方已经确认且互补的内容。',
      reason: '当前任务需要该偏好，两条内容互补。',
      operationActor: 'agent'
    });

    assert.equal(result.resolved_by, 'agent');
    assert.equal(calls[0].path, '/v1/preference-conflicts/conflict-1/resolve');
    assert.deepEqual(calls[0].body, {
      personal_space_id: 'personal-space',
      resolution: 'merge',
      reason: '当前任务需要该偏好，两条内容互补。',
      canonical_item_id: 'preference-b',
      merged_instruction: '保留双方已经确认且互补的内容。',
      split_item_id: null,
      split_project_id: null,
      operation_actor: 'agent'
    });
  });

function providerFetch(calls, routes) {
  return async (rawUrl, options = {}) => {
    const url = new URL(rawUrl);
    calls.push({
      path: url.pathname,
      method: options.method ?? 'GET',
      body: options.body ? JSON.parse(options.body) : null
    });
    return new Response(JSON.stringify(routes[url.pathname] ?? []), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };
}
