import assert from 'node:assert/strict';
import test from 'node:test';

import { currentKnowledgeGraph } from '../web/js/knowledge-graph-projection.js';

test('current graph excludes invalid nodes, invalid edges, and dangling relationships', () => {
  const graph = currentKnowledgeGraph({
    space_id: 'personal-1',
    nodes: [
      { id: 'current-a', invalid_at: null },
      { id: 'current-b', invalid_at: null },
      { id: 'historical', invalid_at: '2026-07-22T00:00:00Z' }
    ],
    edges: [
      { id: 'current', source: 'current-a', target: 'current-b', invalid_at: null },
      {
        id: 'historical-edge', source: 'current-a', target: 'current-b',
        invalid_at: '2026-07-22T00:00:00Z'
      },
      { id: 'dangling', source: 'current-a', target: 'historical', invalid_at: null }
    ]
  });

  assert.deepEqual(graph.nodes.map(({ id }) => id), ['current-a', 'current-b']);
  assert.deepEqual(graph.edges.map(({ id }) => id), ['current']);
});
