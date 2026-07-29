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
  workspaces: [{
    providerUrl: 'https://workspace.example',
    accessToken: 'workspace-token',
    principalId: 'person-remote'
  }]
};

test('federated search globally ranks personal and project results by score', async () => {
  const app = new FederatedGraphApplication(CONFIG, {
    fetchImpl: async (rawUrl) => {
      const url = new URL(rawUrl);
      if (url.pathname === '/v1/subscriptions') {
        return jsonResponse(200, [
          { project_id: 'project-1', provider_url: 'https://workspace.example' }
        ]);
      }
      if (url.pathname === '/v1/search' && url.origin === CONFIG.personal.providerUrl) {
        return jsonResponse(200, {
          facts: [{
            id: 'personal-fact',
            fact: '个人结果',
            space_id: 'personal-space',
            score: 0.2
          }],
          entities: [{
            id: 'personal-entity',
            name: '个人实体',
            space_id: 'personal-space',
            score: 0.3
          }]
        });
      }
      return jsonResponse(200, {
        facts: [{
          id: 'project-fact',
          fact: '项目结果',
          space_id: 'project-1',
          score: 0.9
        }],
        entities: [{
          id: 'project-entity',
          name: '项目实体',
          space_id: 'project-1',
          score: 0.8
        }]
      });
    }
  });

  const result = await app.searchKnowledge({
    personalSpaceId: 'personal-space',
    query: '结果',
    projectIds: ['project-1'],
    limit: 1
  });

  assert.deepEqual(result.facts.map(({ id }) => id), ['project-fact']);
  assert.deepEqual(result.entities.map(({ id }) => id), ['project-entity']);
});

test('federated search returns successful sources when one workspace is unavailable', async () => {
  const config = {
    ...CONFIG,
    workspaces: [
      ...CONFIG.workspaces,
      {
        providerUrl: 'https://unavailable.example',
        accessToken: 'unavailable-token',
        principalId: 'person-unavailable'
      }
    ]
  };
  const app = new FederatedGraphApplication(config, {
    fetchImpl: async (rawUrl) => {
      const url = new URL(rawUrl);
      if (url.pathname === '/v1/subscriptions') {
        return jsonResponse(200, [
          { project_id: 'project-1', provider_url: 'https://workspace.example' },
          { project_id: 'project-2', provider_url: 'https://unavailable.example' }
        ]);
      }
      if (url.origin === 'https://unavailable.example') {
        throw new Error('workspace connection refused');
      }
      if (url.pathname === '/v1/search' && url.origin === CONFIG.personal.providerUrl) {
        return jsonResponse(200, {
          facts: [{
            id: 'personal-fact',
            fact: '个人结果',
            space_id: 'personal-space',
            score: 0.4
          }]
        });
      }
      return jsonResponse(200, {
        facts: [{
          id: 'project-fact',
          fact: '项目结果',
          space_id: 'project-1',
          score: 0.9
        }]
      });
    }
  });

  const result = await app.searchKnowledge({
    personalSpaceId: 'personal-space',
    query: '结果',
    projectIds: ['project-1', 'project-2'],
    limit: 5
  });

  assert.equal(result.partial, true);
  assert.deepEqual(result.requestedProjectIds, ['project-1', 'project-2']);
  assert.deepEqual(result.searchedProjectIds, ['project-1']);
  assert.deepEqual(result.failedProjectIds, ['project-2']);
  assert.deepEqual(result.facts.map(({ id }) => id), ['project-fact', 'personal-fact']);
});

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}
