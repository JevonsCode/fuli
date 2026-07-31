import assert from 'node:assert/strict';
import test from 'node:test';

import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';

test('parent candidate discovery reads direct children without injecting or writing', async () => {
  const requests = [];
  const summaries = {
    'hotel-b': 'COMMON-RETRY-314: recoverable queries use 2 attempts with 140ms jitter.',
    'flight-c': 'COMMON-RETRY-314: recoverable failure uses 2 attempts and 140ms jitter.',
    'travel-d': 'COMMON-RETRY-314: retry recoverable quotes twice with 140ms jitter.'
  };
  const app = new FederatedGraphApplication({
    personal: {
      providerUrl: 'http://personal.invalid',
      accessToken: 'test-access',
      principalId: 'principal-1',
      spaceId: 'personal-1'
    },
    workspaces: []
  }, {
    fetchImpl: async (url, options = {}) => {
      const parsed = new URL(url);
      const body = options.body ? JSON.parse(options.body) : null;
      requests.push({ path: parsed.pathname, method: options.method ?? 'GET', body });
      if (parsed.pathname === '/v1/spaces/personal-1/graph') {
        return response({
          space_id: 'personal-1',
          truncated: false,
          nodes: [
            projectNode('node-a', 'platform-a'),
            projectNode('node-b', 'hotel-b'),
            projectNode('node-c', 'flight-c'),
            projectNode('node-d', 'travel-d')
          ],
          edges: [
            projectRelation('b-a', 'node-b', 'node-a', 'PART_OF'),
            projectRelation('c-a', 'node-c', 'node-a', 'PART_OF'),
            projectRelation('d-a', 'node-d', 'node-a', 'PART_OF')
          ]
        });
      }
      if (parsed.pathname === '/v1/search') {
        const projectId = body.active_personal_project_id;
        return response({
          facts: [],
          entities: [{
            id: `item-${projectId}`,
            space_id: 'personal-1',
            group_id: 'personal-group',
            name: `${projectId} retry rule`,
            type: 'ProjectKnowledge',
            summary: summaries[projectId],
            confirmation_status: 'confirmed',
            defined_project_id: projectId,
            key: `${projectId}.retry`
          }]
        });
      }
      throw new Error(`Unexpected request: ${parsed.pathname}`);
    }
  });

  const result = await app.discoverCommonKnowledgeCandidates({
    personalSpaceId: 'personal-1',
    parentProjectId: 'platform-a',
    query: 'COMMON-RETRY-314 retry attempts jitter',
    minChildProjects: 3,
    similarityThreshold: 0.45,
    limitPerProject: 8
  });

  assert.equal(result.status, 'candidates_found');
  assert.deepEqual(result.child_project_ids, [
    'flight-c', 'hotel-b', 'travel-d'
  ]);
  assert.equal(result.candidates.length, 1);
  assert.deepEqual(
    result.candidates[0].items.map(({ defined_project_id: id }) => id).sort(),
    ['flight-c', 'hotel-b', 'travel-d']
  );
  assert.equal(result.candidates[0].requires_human_confirmation, true);
  assert.equal(result.candidates[0].promotion_performed, false);
  assert.equal(
    requests.filter(({ path }) => path === '/v1/search').every(({ body }) =>
      body.inherit_project_knowledge === false
      && body.include_personal_global === false
    ),
    true
  );
  assert.equal(
    requests.every(({ path }) =>
      path === '/v1/spaces/personal-1/graph' || path === '/v1/search'
    ),
    true
  );
});

function projectNode(id, projectId) {
  return {
    id,
    name: projectId,
    type: 'PersonalProject',
    group_id: 'personal-group',
    summary: '',
    attributes: { projectId }
  };
}

function projectRelation(id, source, target, type) {
  return {
    id,
    source,
    target,
    type,
    fact: `${source} ${type} ${target}`,
    valid_at: null,
    invalid_at: null
  };
}

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}
