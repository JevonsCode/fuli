import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ExternalKnowledgeRegistry,
  ExternalKnowledgeService
} from '../src/external-knowledge/index.js';

test('a read-only binding syncs normalized source documents into one personal project', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-external-knowledge-'));
  const captures = [];
  const app = {
    listPersonalProjects: async () => [{ project_id: 'project-a' }],
    captureSessionKnowledge: async (input) => {
      captures.push(input);
      return { status: 'accepted', entity_ids: ['entity-1'] };
    }
  };
  const connector = {
    check: async () => ({ status: 'ready', capabilities: ['sync', 'retrieve'] }),
    retrieve: async () => ({ items: [] }),
    sync: async () => ({
      items: [{
        id: 'guide/getting-started',
        title: 'Getting started',
        content: 'Install the package and run the setup command.',
        url: 'https://docs.example.test/guide/getting-started',
        updatedAt: '2026-07-31T08:00:00.000Z'
      }],
      deleted: [],
      nextCursor: 'cursor-1',
      hasMore: false
    })
  };
  const service = new ExternalKnowledgeService({
    app,
    registry: new ExternalKnowledgeRegistry(join(directory, 'bindings.json')),
    connectors: { get: (type) => type === 'test' ? connector : null },
    now: () => new Date('2026-08-01T09:00:00.000Z'),
    createId: () => 'binding-1'
  });

  try {
    const binding = await service.createBinding({
      name: 'Product docs',
      connectorType: 'test',
      connectorConfig: { tokenEnv: 'DOCS_READ_TOKEN' },
      source: { root: 'guide' },
      target: {
        personalSpaceId: 'personal-space',
        personalProjectId: 'project-a'
      },
      mode: 'hybrid'
    });
    const result = await service.syncBinding(binding.id);

    assert.equal(binding.id, 'binding-1');
    assert.deepEqual(result, {
      bindingId: 'binding-1',
      status: 'ready',
      imported: 1,
      unchanged: 0,
      invalidated: 0,
      skippedCredentials: 0,
      nextCursor: 'cursor-1',
      hasMore: false
    });
    assert.equal(captures.length, 1);
    assert.equal(captures[0].targetKind, 'personal');
    assert.equal(captures[0].spaceId, 'personal-space');
    assert.equal(captures[0].personalProjectId, 'project-a');
    assert.equal(captures[0].sensitivity, 'restricted');
    assert.equal(captures[0].sourceApplication, 'other');
    assert.equal(captures[0].entities[0].epistemicStatus, 'observed');
    assert.equal(captures[0].entities[0].confirmationStatus, 'pending');
    assert.equal(captures[0].entities[0].confirmationBasis.proposedBy.kind, 'import');
    assert.equal(captures[0].entities[0].attributes.externalBindingId, 'binding-1');
    assert.equal(captures[0].entities[0].attributes.externalItemId, 'guide/getting-started');
    assert.equal((await service.listBindings())[0].sync.cursor, 'cursor-1');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('disconnecting a binding invalidates mirrored entities in the bound project as an agent operation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-external-knowledge-'));
  const revisions = [];
  const app = {
    listPersonalProjects: async () => [{ project_id: 'project-a' }],
    captureSessionKnowledge: async () => ({
      status: 'accepted',
      entity_ids: ['external-entity-1']
    }),
    reviseKnowledgeItem: async (input) => {
      revisions.push(input);
      return { status: 'invalidated' };
    }
  };
  const connector = {
    check: async () => ({ status: 'ready', capabilities: ['sync'] }),
    sync: async () => ({
      items: [{ id: 'doc-1', title: 'Guide', content: 'Read-only source.' }],
      deleted: [],
      nextCursor: null,
      hasMore: false
    })
  };
  const service = new ExternalKnowledgeService({
    app,
    registry: new ExternalKnowledgeRegistry(join(directory, 'bindings.json')),
    connectors: { get: () => connector },
    createId: () => 'binding-1'
  });

  try {
    await service.createBinding({
      name: 'Product docs',
      connectorType: 'test',
      connectorConfig: {},
      source: {},
      target: {
        personalSpaceId: 'personal-space',
        personalProjectId: 'project-a'
      },
      mode: 'mirror'
    });
    await service.syncBinding('binding-1');
    const result = await service.deleteBinding('binding-1');

    assert.equal(result.invalidated, 1);
    assert.deepEqual(revisions, [{
      personalSpaceId: 'personal-space',
      personalProjectId: 'project-a',
      itemKind: 'entity',
      itemId: 'external-entity-1',
      action: 'invalidate',
      reason: 'The read-only external source was changed, removed, or disconnected.',
      operationActor: 'agent'
    }]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('binding configuration rejects raw credentials and accepts environment variable references', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-external-knowledge-'));
  const service = new ExternalKnowledgeService({
    app: {
      listPersonalProjects: async () => [{ project_id: 'project-a' }]
    },
    registry: new ExternalKnowledgeRegistry(join(directory, 'bindings.json')),
    connectors: {
      get: () => ({
        check: async () => ({ status: 'ready' }),
        sync: async () => ({ items: [], deleted: [], nextCursor: null, hasMore: false })
      })
    }
  });
  const input = {
    name: 'Private docs',
    connectorType: 'test',
    source: { root: 'guide' },
    target: { personalSpaceId: 'personal-space', personalProjectId: 'project-a' },
    mode: 'mirror'
  };

  try {
    await assert.rejects(
      service.createBinding({
        ...input,
        connectorConfig: { accessToken: 'must-not-be-persisted' }
      }),
      /cannot contain credentials/i
    );
    await assert.rejects(
      service.createBinding({
        ...input,
        connectorConfig: { clientSecret: 'fixture-secret' }
      }),
      /cannot contain credentials/i
    );
    await assert.rejects(
      service.createBinding({
        ...input,
        connectorConfig: { headers: { Authorization: 'fixture-value' } }
      }),
      /cannot contain credentials/i
    );
    await assert.rejects(
      service.createBinding({
        ...input,
        connectorConfig: { endpoint: 'https://fixture-user:fixture-pass@example.test' }
      }),
      /cannot contain credentials/i
    );
    await assert.rejects(
      service.createBinding({
        ...input,
        connectorConfig: { note: 'api_key=fixture_value_that_is_long_enough' }
      }),
      /cannot contain credentials/i
    );
    const binding = await service.createBinding({
      ...input,
      connectorConfig: { accessTokenEnv: 'PRIVATE_DOCS_TOKEN' }
    });
    assert.equal(binding.connectorConfig.accessTokenEnv, 'PRIVATE_DOCS_TOKEN');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('synchronization enforces bounded page controls before calling a connector', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-external-knowledge-'));
  let syncCalls = 0;
  let oversized = false;
  const service = new ExternalKnowledgeService({
    app: {
      listPersonalProjects: async () => [{ project_id: 'project-a' }]
    },
    registry: new ExternalKnowledgeRegistry(join(directory, 'bindings.json')),
    connectors: {
      get: () => ({
        check: async () => ({ status: 'ready', capabilities: ['sync'] }),
        sync: async () => {
          syncCalls += 1;
          return {
            items: oversized
              ? Array.from({ length: 101 }, (_, index) => ({
                  id: `doc-${index}`,
                  title: `Doc ${index}`,
                  content: 'Fixture content.'
                }))
              : [],
            deleted: [],
            nextCursor: null,
            hasMore: false
          };
        }
      })
    },
    createId: () => 'binding-bounds'
  });

  try {
    await service.createBinding({
      name: 'Bounded fixture source',
      connectorType: 'test',
      connectorConfig: {},
      source: {},
      target: { personalSpaceId: 'personal-space', personalProjectId: 'project-a' },
      mode: 'mirror'
    });
    await assert.rejects(
      service.syncBinding('binding-bounds', { maxPages: 0, pageSize: 100 }),
      /maxPages must be a positive integer/i
    );
    await assert.rejects(
      service.syncBinding('binding-bounds', { maxPages: 100, pageSize: 101 }),
      /pageSize must be a positive integer/i
    );
    assert.equal(syncCalls, 0);
    oversized = true;
    await assert.rejects(
      service.syncBinding('binding-bounds', { maxPages: 1, pageSize: 100 }),
      /returned more than 100 items/i
    );
    assert.equal(syncCalls, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('binding mode must be supported by the capabilities negotiated with the source', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-external-knowledge-'));
  const service = new ExternalKnowledgeService({
    app: {
      listPersonalProjects: async () => [{ project_id: 'project-a' }]
    },
    registry: new ExternalKnowledgeRegistry(join(directory, 'bindings.json')),
    connectors: {
      get: () => ({
        check: async () => ({ status: 'ready', capabilities: ['retrieve'] }),
        sync: async () => ({ items: [], deleted: [], nextCursor: null, hasMore: false }),
        retrieve: async () => ({ items: [] })
      })
    }
  });

  try {
    await assert.rejects(
      service.createBinding({
        name: 'Unsupported mirror fixture',
        connectorType: 'test',
        connectorConfig: {},
        source: {},
        target: { personalSpaceId: 'personal-space', personalProjectId: 'project-a' },
        mode: 'mirror'
      }),
      /does not advertise synchronization/i
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('live retrieval omits connector documents that contain credential material', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-external-knowledge-'));
  const service = new ExternalKnowledgeService({
    app: {
      listPersonalProjects: async () => [{ project_id: 'project-a' }]
    },
    registry: new ExternalKnowledgeRegistry(join(directory, 'bindings.json')),
    connectors: {
      get: () => ({
        check: async () => ({ status: 'ready', capabilities: ['retrieve'] }),
        retrieve: async () => ({
          items: [{
            id: 'unsafe-doc',
            title: 'Unsafe fixture',
            content: 'access_token=fixture_value_that_is_long_enough'
          }]
        })
      })
    },
    createId: () => 'binding-unsafe'
  });

  try {
    await service.createBinding({
      name: 'Unsafe fixture source',
      connectorType: 'test',
      connectorConfig: {},
      source: {},
      target: { personalSpaceId: 'personal-space', personalProjectId: 'project-a' },
      mode: 'live'
    });
    const result = await service.retrieveBinding(
      'binding-unsafe',
      { query: 'unsafe', limit: 5 }
    );
    assert.deepEqual(result.items, []);
    assert.equal(result.skippedCredentials, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a credential-bearing update is skipped and invalidates its older safe mirror', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-external-knowledge-'));
  const revisions = [];
  let unsafe = false;
  const service = new ExternalKnowledgeService({
    app: {
      listPersonalProjects: async () => [{ project_id: 'project-a' }],
      captureSessionKnowledge: async () => ({
        status: 'accepted',
        entity_ids: ['safe-entity']
      }),
      reviseKnowledgeItem: async (input) => {
        revisions.push(input);
        return { status: 'invalidated' };
      }
    },
    registry: new ExternalKnowledgeRegistry(join(directory, 'bindings.json')),
    connectors: {
      get: () => ({
        check: async () => ({ status: 'ready', capabilities: ['sync'] }),
        sync: async () => ({
          items: [{
            id: 'doc-1',
            title: 'Rotating source',
            content: unsafe
              ? 'token=fixture_value_that_is_long_enough'
              : 'Safe public guidance.'
          }],
          deleted: [],
          nextCursor: null,
          hasMore: false
        })
      })
    },
    createId: () => 'binding-rotating'
  });

  try {
    await service.createBinding({
      name: 'Rotating fixture source',
      connectorType: 'test',
      connectorConfig: {},
      source: {},
      target: { personalSpaceId: 'personal-space', personalProjectId: 'project-a' },
      mode: 'mirror'
    });
    await service.syncBinding('binding-rotating');
    unsafe = true;
    const result = await service.syncBinding('binding-rotating');

    assert.equal(result.imported, 0);
    assert.equal(result.skippedCredentials, 1);
    assert.equal(result.invalidated, 1);
    assert.equal(revisions[0].itemId, 'safe-entity');
    assert.deepEqual(
      (await service.listBindings())[0].sync.items,
      {}
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('synchronization stores a bounded protected diagnostic instead of a leaked credential', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-external-knowledge-'));
  const service = new ExternalKnowledgeService({
    app: {
      listPersonalProjects: async () => [{ project_id: 'project-a' }]
    },
    registry: new ExternalKnowledgeRegistry(join(directory, 'bindings.json')),
    connectors: {
      get: () => ({
        check: async () => ({ status: 'ready', capabilities: ['sync'] }),
        sync: async () => {
          throw new Error('Bearer fixture_secret_value_that_must_be_hidden');
        }
      })
    },
    createId: () => 'binding-error'
  });

  try {
    await service.createBinding({
      name: 'Failure fixture source',
      connectorType: 'test',
      connectorConfig: {},
      source: {},
      target: { personalSpaceId: 'personal-space', personalProjectId: 'project-a' },
      mode: 'mirror'
    });
    await assert.rejects(service.syncBinding('binding-error'));
    const diagnostic = (await service.listBindings())[0].sync.error;
    assert.doesNotMatch(diagnostic, /fixture_secret/);
    assert.match(diagnostic, /protected diagnostic/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('one external connection binds to multiple projects with isolated state and retrieval scope', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-external-knowledge-'));
  const captures = [];
  const revisions = [];
  const app = {
    listPersonalProjects: async () => [
      { project_id: 'project-a' },
      { project_id: 'project-b' },
      { project_id: 'project-c' }
    ],
    captureSessionKnowledge: async (input) => {
      captures.push(input);
      return {
        status: 'accepted',
        entity_ids: [`entity-${input.personalProjectId}`]
      };
    },
    reviseKnowledgeItem: async (input) => {
      revisions.push(input);
      return { status: 'invalidated' };
    }
  };
  const connector = {
    check: async () => ({ status: 'ready', capabilities: ['sync', 'retrieve'] }),
    sync: async () => ({
      items: [{ id: 'doc-1', title: 'Guide', content: 'Shared source content.' }],
      deleted: [],
      nextCursor: null,
      hasMore: false
    }),
    retrieve: async ({ bindingId, query }) => ({
      items: [{ id: `${bindingId}:doc-1`, title: 'Guide', content: query }]
    })
  };
  const service = new ExternalKnowledgeService({
    app,
    registry: new ExternalKnowledgeRegistry(join(directory, 'bindings.json')),
    connectors: { get: () => connector },
    createId: () => 'binding-multi'
  });

  try {
    const created = await service.createBinding({
      name: 'Shared docs',
      connectorType: 'test',
      connectorConfig: {},
      source: {},
      targets: ['project-a', 'project-b'].map((personalProjectId) => ({
        personalSpaceId: 'personal-space',
        personalProjectId,
        mode: 'hybrid'
      }))
    });
    assert.equal(created.targets.length, 2);
    assert.equal(created.target.personalProjectId, 'project-a');
    assert.notEqual(created.targets[0].id, created.targets[1].id);

    const synced = await service.syncBinding(created.id);
    assert.equal(synced.imported, 2);
    assert.equal(synced.targets.length, 2);
    assert.deepEqual(
      captures.map(({ personalProjectId }) => personalProjectId),
      ['project-a', 'project-b']
    );
    assert.notEqual(captures[0].sessionId, captures[1].sessionId);
    assert.notEqual(captures[0].idempotencyKey, captures[1].idempotencyKey);

    await assert.rejects(
      service.retrieveBinding(created.id, { query: 'guide' }),
      /personalSpaceId and personalProjectId are required/i
    );
    const retrieved = await service.retrieveBinding(created.id, {
      personalSpaceId: 'personal-space',
      personalProjectId: 'project-b',
      query: 'guide'
    });
    assert.equal(retrieved.personalProjectId, 'project-b');

    const updated = await service.updateBindingTargets(created.id, {
      targets: [
        {
          personalSpaceId: 'personal-space',
          personalProjectId: 'project-b',
          mode: 'live'
        },
        {
          personalSpaceId: 'personal-space',
          personalProjectId: 'project-c',
          mode: 'hybrid'
        }
      ]
    });
    assert.deepEqual(
      updated.targets.map(({ personalProjectId, mode }) => [personalProjectId, mode]),
      [['project-b', 'live'], ['project-c', 'hybrid']]
    );
    assert.equal(new Set(updated.targets.map(({ id }) => id)).size, 2);
    assert.equal(updated.targets[0].sync.lastSyncedAt, null);
    assert.deepEqual(
      revisions.map(({ personalProjectId, itemId }) => [personalProjectId, itemId]),
      [
        ['project-a', 'entity-project-a'],
        ['project-b', 'entity-project-b']
      ]
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('project graph projection exposes connection nodes and per-project binding edges', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-external-knowledge-'));
  const service = new ExternalKnowledgeService({
    app: {
      listPersonalProjects: async () => [
        { project_id: 'project-a' },
        { project_id: 'project-b' }
      ]
    },
    registry: new ExternalKnowledgeRegistry(join(directory, 'bindings.json')),
    connectors: {
      get: () => ({
        check: async () => ({ status: 'ready', capabilities: ['retrieve'] }),
        retrieve: async () => ({ items: [] })
      })
    },
    createId: () => 'binding-graph'
  });

  try {
    await service.createBinding({
      name: 'LLM Wiki',
      connectorType: 'test',
      connectorConfig: {},
      source: {},
      targets: ['project-a', 'project-b'].map((personalProjectId) => ({
        personalSpaceId: 'personal-space',
        personalProjectId,
        mode: 'live'
      }))
    });
    const projectNode = {
      id: 'personal-project:personal-space:project-a',
      name: 'Project A',
      type: 'PersonalProject',
      group_id: 'personal-space',
      attributes: { projectId: 'project-a' }
    };
    const projection = service.projectGraphProjection({
      personalSpaceId: 'personal-space',
      personalProjectId: 'project-a',
      graph: { nodes: [projectNode], edges: [] }
    });

    assert.equal(projection.nodes.length, 1);
    assert.equal(projection.nodes[0].type, 'ExternalKnowledgeSource');
    assert.equal(projection.nodes[0].name, 'LLM Wiki');
    assert.deepEqual(projection.edges.map(({ source, target, type }) => ({ source, target, type })), [{
      source: projectNode.id,
      target: 'external-knowledge-source:binding-graph',
      type: 'USES_EXTERNAL_KNOWLEDGE'
    }]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
