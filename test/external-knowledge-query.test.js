import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ConnectedKnowledgeSearch,
  KnowledgeConflictPolicyStore
} from '../src/external-knowledge/index.js';

test('conflict policy keys cannot collide with object prototype properties', () => {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-connected-search-'));
  try {
    const policies = new KnowledgeConflictPolicyStore(join(directory, 'policies.json'));
    policies.set('__proto__', 'agent_decide');
    assert.equal(policies.get('__proto__').mode, 'agent_decide');
    assert.equal(policies.get('constructor').mode, 'ask_human');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('connected search keeps public, personal, and live external results separate with a project policy', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-connected-search-'));
  const graphCalls = [];
  const app = {
    searchKnowledge: async (input) => {
      graphCalls.push(input);
      return {
        facts: [{ id: 'public-fact', fact: 'Public release is Friday.' }],
        entities: [{ id: 'personal-item', name: 'Release plan' }]
      };
    },
    listPersonalProjects: async () => [{ project_id: 'project-a' }]
  };
  const externalKnowledge = {
    listBindings: async () => [
      {
        id: 'binding-a',
        name: 'Notion handbook',
        connectorType: 'notion',
        mode: 'hybrid',
        status: 'ready',
        target: { personalSpaceId: 'personal-1', personalProjectId: 'project-a' }
      },
      {
        id: 'binding-b',
        name: 'Other project',
        connectorType: 'mcp',
        mode: 'live',
        status: 'ready',
        target: { personalSpaceId: 'personal-1', personalProjectId: 'project-b' }
      },
      {
        id: 'binding-c',
        name: 'Protected failure',
        connectorType: 'custom',
        mode: 'live',
        status: 'ready',
        target: { personalSpaceId: 'personal-1', personalProjectId: 'project-a' }
      },
      {
        id: 'binding-d',
        name: 'Feishu playbook',
        connectorType: 'feishu',
        mode: 'live',
        status: 'ready',
        target: { personalSpaceId: 'personal-1', personalProjectId: 'project-a' }
      }
    ],
    retrieveBinding: async (id, input) => {
      if (id === 'binding-c') {
        throw new Error('Bearer fixture_secret_value_that_must_be_hidden');
      }
      return {
        bindingId: id,
        query: input.query,
        items: [{ id: `${id}-external`, title: 'Release plan', content: 'Release is Monday.' }],
        skippedCredentials: 1
      };
    }
  };
  const policies = new KnowledgeConflictPolicyStore(join(directory, 'policies.json'));
  const search = new ConnectedKnowledgeSearch({ app, externalKnowledge, policies });

  try {
    const result = await search.query({
      personalSpaceId: 'personal-1',
      personalProjectId: 'project-a',
      projectIds: ['public-project'],
      query: 'release',
      limit: 10,
      includePending: true
    });

    assert.deepEqual(graphCalls[0].projectIds, ['public-project']);
    assert.equal(graphCalls[0].agentToolName, 'search_connected_knowledge');
    assert.equal(result.graph.entities[0].id, 'personal-item');
    assert.deepEqual(
      result.external.map(({ binding }) => binding.id),
      ['binding-a', 'binding-d']
    );
    assert.equal(result.external[0].skippedCredentials, 1);
    assert.equal(result.sourceErrors.length, 1);
    assert.doesNotMatch(result.sourceErrors[0].error, /fixture_secret/);
    assert.match(result.sourceErrors[0].error, /protected diagnostic/i);
    assert.equal(result.conflictPolicy.mode, 'ask_human');
    assert.match(result.conflictGuidance, /surface.*conflict.*user/i);

    await search.updateConflictPolicy({
      personalSpaceId: 'personal-1',
      personalProjectId: 'project-a',
      mode: 'agent_decide'
    });
    const updated = await search.getConflictPolicy({ personalProjectId: 'project-a' });
    assert.equal(updated.mode, 'agent_decide');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an explicitly selected public project still requires conflict assessment without live bindings', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-connected-search-'));
  const search = new ConnectedKnowledgeSearch({
    app: {
      searchKnowledge: async () => ({
        facts: [{ id: 'public-fact', fact: 'A public project answer.' }],
        entities: []
      }),
      listPersonalProjects: async () => [{ project_id: 'project-a' }]
    },
    externalKnowledge: {
      listBindings: async () => []
    },
    policies: new KnowledgeConflictPolicyStore(join(directory, 'policies.json'))
  });

  try {
    const result = await search.query({
      personalSpaceId: 'personal-1',
      personalProjectId: 'project-a',
      projectIds: ['public-project'],
      query: 'answer'
    });
    assert.equal(result.conflictAssessmentRequired, true);
    assert.equal(result.sourceScopes.publicSpaceStatus, 'beta');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('connected search selects the matching target from a multi-project binding', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-connected-search-'));
  const retrievals = [];
  const search = new ConnectedKnowledgeSearch({
    app: {
      searchKnowledge: async () => ({ facts: [], entities: [] }),
      listPersonalProjects: async () => [{ project_id: 'project-b' }]
    },
    externalKnowledge: {
      listBindings: async () => [{
        id: 'binding-multi',
        name: 'Shared wiki',
        connectorType: 'retrieval_api',
        mode: 'live',
        status: 'ready',
        targets: [
          {
            id: 'target-a',
            personalSpaceId: 'personal-1',
            personalProjectId: 'project-a',
            mode: 'live',
            status: 'ready'
          },
          {
            id: 'target-b',
            personalSpaceId: 'personal-1',
            personalProjectId: 'project-b',
            mode: 'live',
            status: 'ready'
          }
        ]
      }],
      retrieveBinding: async (id, input) => {
        retrievals.push([id, input]);
        return { items: [{ id: 'doc', title: 'Doc', content: 'Bound content' }] };
      }
    },
    policies: new KnowledgeConflictPolicyStore(join(directory, 'policies.json'))
  });

  try {
    const result = await search.query({
      personalSpaceId: 'personal-1',
      personalProjectId: 'project-b',
      query: 'bound content'
    });
    assert.deepEqual(retrievals, [[
      'binding-multi',
      {
        query: 'bound content',
        limit: 12,
        personalSpaceId: 'personal-1',
        personalProjectId: 'project-b'
      }
    ]]);
    assert.equal(result.external[0].binding.targetId, 'target-b');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
