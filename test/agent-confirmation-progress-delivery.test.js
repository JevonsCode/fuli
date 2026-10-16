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

const UNKNOWN_USAGE = {
  required_qualified_uses: 5,
  required_distinct_tasks: 3,
  qualified_use_count: null,
  distinct_task_count: null,
  has_open_conflict: true,
  blocking_reasons: ['open_conflict', 'usage_unknown']
};

const PREFERENCE_CONFLICT = {
  required_qualified_uses: 5,
  required_distinct_tasks: 3,
  qualified_use_count: 6,
  distinct_task_count: 3,
  has_open_conflict: true,
  blocking_reasons: ['open_conflict']
};

test('knowledge graph delivers the Provider confirmation progress unchanged, including unknown counts', async () => {
  const app = new FederatedGraphApplication(CONFIG, {
    fetchImpl: async () => new Response(JSON.stringify({
      space_id: 'personal-space',
      nodes: [{
        id: 'synthetic-node',
        qualified_use_count: 0,
        distinct_task_count: 0,
        agent_confirmation_progress: UNKNOWN_USAGE
      }],
      edges: [{
        id: 'synthetic-edge',
        qualified_use_count: 6,
        distinct_task_count: 3,
        agent_confirmation_progress: PREFERENCE_CONFLICT
      }],
      truncated: false
    }), { headers: { 'content-type': 'application/json' } })
  });

  const graph = await app.getKnowledgeGraph({ spaceId: 'personal-space' });

  assert.deepEqual(graph.nodes[0].agent_confirmation_progress, UNKNOWN_USAGE);
  assert.equal(graph.nodes[0].qualified_use_count, 0);
  assert.deepEqual(graph.edges[0].agent_confirmation_progress, PREFERENCE_CONFLICT);
});
