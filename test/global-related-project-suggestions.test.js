import assert from 'node:assert/strict';
import test from 'node:test';

import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';

test('all-local search exposes active RELATED_TO follow-up for the exact matched project', async () => {
  const app = new FederatedGraphApplication({
    version: 1,
    personal: {
      providerUrl: 'http://127.0.0.1:8787',
      accessToken: 'synthetic-token',
      principalId: 'synthetic-principal',
      spaceId: 'personal-space'
    },
    workspaces: []
  }, { fetchImpl: async () => { throw new Error('unexpected HTTP'); } });
  app.personal.listPersonalProjects = async () => [
    { project_id: 'related-c' },
    { project_id: 'travel-d' }
  ];
  app.personal.search = async () => ({
    facts: [{
      id: 'fact-c',
      source_entity: 'C',
      target_entity: 'marker',
      relationship: 'HAS_MARKER',
      fact: 'global query matched C',
      defined_project_id: 'related-c',
      scope_distance: 0
    }],
    entities: []
  });
  app.personal.graph = async () => ({
    nodes: [{
      id: 'personal-project:c',
      name: 'C',
      type: 'PersonalProject',
      attributes: { projectId: 'related-c' }
    }, {
      id: 'personal-project:d',
      name: 'D',
      type: 'PersonalProject',
      attributes: { projectId: 'travel-d' }
    }],
    edges: [{
      id: 'personal-project-relation:c-d',
      source: 'personal-project:c',
      target: 'personal-project:d',
      type: 'RELATED_TO',
      fact: 'C 与 D 显式关联。',
      attributes: {
        status: 'active',
        confirmationAuthority: 'human_review'
      }
    }]
  });

  const result = await app.searchKnowledge({
    personalSpaceId: 'personal-space',
    personalProjectScope: 'all_local_confirmed',
    query: 'global query'
  });

  assert.equal(result.relatedProjectSuggestionsStatus, 'available');
  assert.deepEqual(result.relatedProjectSuggestions, [{
    personal_project_id: 'travel-d',
    project_name: 'D',
    relation_id: 'personal-project-relation:c-d',
    relation_type: 'RELATED_TO',
    relation_status: 'active',
    direction: 'outgoing',
    reason: 'C 与 D 显式关联。',
    requires_human_confirmation: true,
    expansion_mode: 'one_time_read_only',
    confirmed_search: {
      tool: 'search_knowledge_graph',
      personal_project_scope: 'bounded',
      context_personal_project_ids: ['travel-d']
    },
    triggered_by_project_id: 'related-c',
    triggered_by_result_ids: ['fact-c']
  }]);
  assert.match(result.relatedProjectGuidance, /travel-d/);
});

test('optional global relation lookup failure does not suppress search results', async () => {
  const app = new FederatedGraphApplication({
    version: 1,
    personal: {
      providerUrl: 'http://127.0.0.1:8787',
      accessToken: 'synthetic-token',
      principalId: 'synthetic-principal',
      spaceId: 'personal-space'
    },
    workspaces: []
  }, { fetchImpl: async () => { throw new Error('unexpected HTTP'); } });
  app.personal.search = async () => ({
    facts: [{ id: 'global', fact: 'global preference', defined_project_id: null }],
    entities: []
  });
  app.personal.graph = async () => { throw new Error('graph unavailable'); };

  const result = await app.searchKnowledge({
    personalSpaceId: 'personal-space',
    query: 'global preference'
  });

  assert.equal(result.facts[0].id, 'global');
  assert.equal(result.relatedProjectSuggestionsStatus, 'not_applicable');
  assert.deepEqual(result.relatedProjectSuggestions, []);
});
