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

test('knowledge graph pagination forwards a zero-based offset to the Provider', async () => {
  const requests = [];
  const app = new FederatedGraphApplication(CONFIG, {
    fetchImpl: async (rawUrl) => {
      requests.push(new URL(rawUrl));
      return new Response(JSON.stringify({
        space_id: 'personal-space',
        nodes: [],
        edges: [],
        truncated: false
      }), { headers: { 'content-type': 'application/json' } });
    }
  });

  await app.getKnowledgeGraph({
    spaceId: 'personal-space',
    limit: 100,
    offset: 200
  });

  assert.deepEqual(Object.fromEntries(requests[0].searchParams), {
    limit: '100',
    offset: '200'
  });
});
