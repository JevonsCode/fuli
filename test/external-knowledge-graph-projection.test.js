import assert from 'node:assert/strict';
import test from 'node:test';

import { mergeExternalKnowledgeProjection } from '../src/external-knowledge/graph-projection.js';

test('personal graph results include the scoped external knowledge projection', () => {
  const graph = {
    space_id: 'personal-space',
    nodes: [{ id: 'project', name: 'FULI', type: 'PersonalProject' }],
    edges: []
  };
  let projectionInput;
  const result = mergeExternalKnowledgeProjection({
    projectGraphProjection(input) {
      projectionInput = input;
      return {
        nodes: [{
          id: 'external-knowledge-source:binding-1',
          name: 'LLM Wiki',
          type: 'ExternalKnowledgeSource'
        }],
        edges: [{
          id: 'external-knowledge-binding:binding-1:target-1',
          source: 'project',
          target: 'external-knowledge-source:binding-1',
          type: 'USES_EXTERNAL_KNOWLEDGE'
        }]
      };
    }
  }, graph, 'personal-space', 'fuli');

  assert.equal(projectionInput.personalSpaceId, 'personal-space');
  assert.equal(projectionInput.personalProjectId, 'fuli');
  assert.equal(result.nodes.at(-1).type, 'ExternalKnowledgeSource');
  assert.equal(result.edges.at(-1).type, 'USES_EXTERNAL_KNOWLEDGE');
  assert.equal(result.space_id, 'personal-space');
});
