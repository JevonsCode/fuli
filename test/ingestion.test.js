import test from 'node:test';
import assert from 'node:assert/strict';

import { SpaceKind } from '../src/models.js';
import { createApplication } from '../src/app/create-application.js';
import { decideCandidate } from '../src/candidates.js';
import { FileStore } from '../src/store.js';
import { IngestionService } from '../src/ingestion.js';
import { STORE_METHODS } from '../src/storage/store-port.js';

test('public PRD facts are written to target public space', () => {
  const store = new FileStore(':memory:');
  const personal = store.createSpace('Jevons', SpaceKind.PERSONAL);
  const project = store.createSpace('Project A', SpaceKind.PUBLIC);
  const service = new IngestionService(store);

  service.remember({
    personalSpaceId: personal.id,
    targetSpaceId: project.id,
    sourceKind: 'prd',
    body: 'test_url: https://test.example.com'
  });

  const projectFacts = store.currentFacts(project.id);
  assert.equal(projectFacts.length, 1);
  assert.equal(projectFacts[0].object, 'https://test.example.com');
  assert.equal(projectFacts[0].scope, 'public');
  const outbox = store.listPendingOutbox('9999-12-31T23:59:59.999Z');
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].payload.envelope.facts[0].id, projectFacts[0].id);
});

test('personal preference only writes facts to personal space', () => {
  const store = new FileStore(':memory:');
  const personal = store.createSpace('Jevons', SpaceKind.PERSONAL);
  const project = store.createSpace('Project A', SpaceKind.PUBLIC);
  const service = new IngestionService(store);

  service.remember({
    personalSpaceId: personal.id,
    targetSpaceId: project.id,
    sourceKind: 'agent',
    body: '我觉得这个项目里我更喜欢先写原型'
  });

  assert.equal(store.currentFacts(project.id).length, 0);
  assert.equal(store.currentFacts(personal.id).length, 0);
  assert.equal(store.listPendingOutbox('9999-12-31T23:59:59.999Z').length, 0);
});

test('explicit personal capture writes extracted facts to personal space without a candidate', () => {
  const store = new FileStore(':memory:');
  const personal = store.createSpace('Jevons', SpaceKind.PERSONAL);
  const project = store.createSpace('Project A', SpaceKind.PUBLIC);
  const service = new IngestionService(store);

  const result = service.remember({
    personalSpaceId: personal.id,
    targetSpaceId: project.id,
    sourceKind: 'personal',
    body: 'local_alias: pnpm dev'
  });

  const personalFacts = store.currentFacts(personal.id);
  assert.equal(result.route, 'personal');
  assert.equal(personalFacts.length, 1);
  assert.equal(personalFacts[0].predicate, 'has_local_alias');
  assert.equal(personalFacts[0].object, 'pnpm dev');
  assert.equal(store.currentFacts(project.id).length, 0);
  assert.equal(store.pendingCandidates(personal.id).length, 0);
});

test('uncertain note becomes a quiet candidate', () => {
  const store = new FileStore(':memory:');
  const personal = store.createSpace('Jevons', SpaceKind.PERSONAL);
  const project = store.createSpace('Project A', SpaceKind.PUBLIC);
  const service = new IngestionService(store);

  service.remember({
    personalSpaceId: personal.id,
    targetSpaceId: project.id,
    sourceKind: 'chat',
    body: '可能这个模块以后要拆出去'
  });

  const candidates = store.pendingCandidates(personal.id);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].targetSpaceId, project.id);
  assert.equal(store.listPendingOutbox('9999-12-31T23:59:59.999Z').length, 0);
});

test('syncing a candidate without a target is rejected without changing its status', () => {
  const store = new FileStore(':memory:');
  const personal = store.createSpace('Jevons', SpaceKind.PERSONAL);
  const service = new IngestionService(store);

  service.remember({
    personalSpaceId: personal.id,
    targetSpaceId: null,
    sourceKind: 'git',
    body: '可能这个模块以后要拆出去'
  });
  const candidate = store.pendingCandidates(personal.id)[0];

  assert.throws(
    () => decideCandidate(store, candidate.id, 'sync'),
    /requires a target space/
  );
  assert.equal(store.getCandidate(candidate.id).status, 'pending');
});

test('public ingestion rolls back episode, facts, invalidation, and outbox when enqueue fails', () => {
  const store = new FileStore(':memory:');
  const personal = store.createSpace('Jevons', SpaceKind.PERSONAL);
  const project = store.createSpace('Project A', SpaceKind.PUBLIC);
  new IngestionService(store).remember({
    personalSpaceId: personal.id,
    targetSpaceId: project.id,
    sourceKind: 'prd',
    body: 'runtime: node-22'
  });
  const before = store.exportSnapshot();
  const failingStore = overrideStore(store, {
    enqueueOutbox() {
      throw new Error('outbox write failed');
    }
  });

  assert.throws(() => new IngestionService(failingStore).remember({
    personalSpaceId: personal.id,
    targetSpaceId: project.id,
    sourceKind: 'prd',
    body: 'runtime: node-24'
  }), /outbox write failed/);
  assert.deepEqual(store.exportSnapshot(), before);
});

test('replacement invalidates old public fact and keeps timeline', () => {
  const store = new FileStore(':memory:');
  const personal = store.createSpace('Jevons', SpaceKind.PERSONAL);
  const project = store.createSpace('Project A', SpaceKind.PUBLIC);
  const service = new IngestionService(store);

  service.remember({
    personalSpaceId: personal.id,
    targetSpaceId: project.id,
    sourceKind: 'prd',
    body: 'test_url: https://old.example.com'
  });
  service.remember({
    personalSpaceId: personal.id,
    targetSpaceId: project.id,
    sourceKind: 'prd',
    body: '替代: https://old.example.com => https://new.example.com'
  });

  const current = store.currentFacts(project.id);
  assert.deepEqual(
    current.map((fact) => fact.object),
    ['https://new.example.com']
  );
  assert.deepEqual(
    current.map((fact) => fact.predicate),
    ['has_test_url']
  );
  assert.equal(store.timeline(project.id, 'Project A').length, 2);
});

test('duplicate current facts are not written again', () => {
  const store = new FileStore(':memory:');
  const personal = store.createSpace('Jevons', SpaceKind.PERSONAL);
  const project = store.createSpace('Project A', SpaceKind.PUBLIC);
  const service = new IngestionService(store);

  const first = service.remember({
    personalSpaceId: personal.id,
    targetSpaceId: project.id,
    sourceKind: 'prd',
    body: 'test_url: https://stable.example.com'
  });
  const duplicate = service.remember({
    personalSpaceId: personal.id,
    targetSpaceId: project.id,
    sourceKind: 'prd',
    body: 'test_url: https://stable.example.com'
  });

  assert.equal(store.currentFacts(project.id).length, 1);
  assert.equal(store.data.episodes.length, 4);
  assert.notEqual(first.publication, null);
  assert.equal(duplicate.publication, null);
  assert.equal(store.listPendingOutbox('9999-12-31T23:59:59.999Z').length, 1);
});

test('new value for the same project parameter supersedes the old current fact', () => {
  const store = new FileStore(':memory:');
  const personal = store.createSpace('Jevons', SpaceKind.PERSONAL);
  const project = store.createSpace('Project A', SpaceKind.PUBLIC);
  const service = new IngestionService(store);

  service.remember({
    personalSpaceId: personal.id,
    targetSpaceId: project.id,
    sourceKind: 'prd',
    body: 'test_url: https://old.example.com'
  });
  service.remember({
    personalSpaceId: personal.id,
    targetSpaceId: project.id,
    sourceKind: 'prd',
    body: 'test_url: https://new.example.com'
  });

  const current = store.currentFacts(project.id);
  const timeline = store.timeline(project.id, 'Project A');

  assert.deepEqual(
    current.map((fact) => fact.object),
    ['https://new.example.com']
  );
  assert.equal(timeline.length, 2);
  assert.equal(timeline[0].object, 'https://old.example.com');
  assert.equal(timeline[0].replacedByFactId, current[0].id);
});

test('explicit personal ingestion uses one source episode and preserves repeated fact history', () => {
  const store = new FileStore(':memory:');
  const app = createApplication({ store });
  const { personal, space } = app.bootstrap();

  for (const body of [
    ['editor: vscode', 'shell: powershell'].join('\n'),
    ['editor: vscode', 'shell: powershell'].join('\n')
  ]) {
    app.remember({
      personalSpaceId: personal.id,
      targetSpaceId: space.id,
      sourceKind: 'personal',
      body
    });
  }

  const history = store.listFacts({ includeHistorical: true });
  assert.equal(store.listEpisodes().length, 2);
  assert.equal(history.length, 4);
  assert.equal(store.currentFacts(personal.id).length, 2);
  assert.equal(new Set(history.map((fact) => fact.sourceEpisodeId)).size, 2);
  assert.deepEqual([...new Set(history.map((fact) => fact.status))], ['confirmed']);
});

test('application ingestion rejects credentials before writing personal, candidate, or public records', () => {
  const cases = [
    { sourceKind: 'personal', body: 'api_key: sk-proj-abcdefghijklmnopqrstuvwxyz123456' },
    { sourceKind: 'chat', body: 'maybe use glpat-abcdefghijklmnopqrst later' },
    { sourceKind: 'prd', body: 'deploy_token: npm_abcdefghijklmnopqrstuvwxyz1234567890' }
  ];

  for (const input of cases) {
    const store = new FileStore(':memory:');
    const app = createApplication({ store });
    const { personal, space } = app.bootstrap();
    const before = store.exportSnapshot();

    assert.throws(() => app.remember({
      personalSpaceId: personal.id,
      targetSpaceId: space.id,
      ...input
    }), /sensitive content/i);
    assert.deepEqual(store.exportSnapshot(), before);
  }
});

test('remember rolls back episodes when a later fact write fails', () => {
  const store = new FileStore(':memory:');
  const personal = store.createSpace('Jevons', SpaceKind.PERSONAL);
  const project = store.createSpace('Project A', SpaceKind.PUBLIC);
  const before = store.exportSnapshot();
  const failingStore = overrideStore(store, {
    addFact() {
      throw new Error('fact write failed');
    }
  });

  assert.throws(
    () => new IngestionService(failingStore).remember({
      personalSpaceId: personal.id,
      targetSpaceId: project.id,
      sourceKind: 'prd',
      body: 'runtime: node-24'
    }),
    /fact write failed/
  );
  assert.deepEqual(store.exportSnapshot(), before);
});

test('remember rolls back its episode when candidate creation fails', () => {
  const store = new FileStore(':memory:');
  const personal = store.createSpace('Jevons', SpaceKind.PERSONAL);
  const project = store.createSpace('Project A', SpaceKind.PUBLIC);
  const before = store.exportSnapshot();
  const failingStore = overrideStore(store, {
    addCandidate() {
      throw new Error('candidate write failed');
    }
  });

  assert.throws(
    () => new IngestionService(failingStore).remember({
      personalSpaceId: personal.id,
      targetSpaceId: project.id,
      sourceKind: 'chat',
      body: 'maybe split this module later'
    }),
    /candidate write failed/
  );
  assert.deepEqual(store.exportSnapshot(), before);
});

test('confirmed publishing rolls back new facts and replacement invalidation on failure', () => {
  const store = new FileStore(':memory:');
  const project = store.createSpace('Project A', SpaceKind.PUBLIC);
  const service = new IngestionService(store);
  service.publishConfirmed({
    targetSpaceId: project.id,
    sourceKind: 'prd',
    body: 'runtime: node-22'
  });
  assert.equal(store.listPendingOutbox('9999-12-31T23:59:59.999Z').length, 1);
  const before = store.exportSnapshot();
  const failingStore = overrideStore(store, {
    invalidateFact(...args) {
      store.invalidateFact(...args);
      throw new Error('invalidation failed');
    }
  });

  assert.throws(
    () => new IngestionService(failingStore).publishConfirmed({
      targetSpaceId: project.id,
      sourceKind: 'prd',
      body: '替代: node-22 => node-24'
    }),
    /invalidation failed/
  );
  assert.deepEqual(store.exportSnapshot(), before);
});

test('syncing a candidate publishes exactly one durable envelope', () => {
  const store = new FileStore(':memory:');
  const personal = store.createSpace('Jevons', SpaceKind.PERSONAL);
  const project = store.createSpace('Project A', SpaceKind.PUBLIC);
  const candidate = new IngestionService(store).remember({
    personalSpaceId: personal.id,
    targetSpaceId: project.id,
    sourceKind: 'chat',
    body: 'runtime: node-24'
  }).candidate;

  assert.equal(store.listPendingOutbox('9999-12-31T23:59:59.999Z').length, 0);
  decideCandidate(store, candidate.id, 'sync');
  const outbox = store.listPendingOutbox('9999-12-31T23:59:59.999Z');
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].payload.envelope.facts.length, 1);
});

test('all standalone public publication entry points use immediate parent transactions', () => {
  const store = new FileStore(':memory:');
  const personal = store.createSpace('Jevons', SpaceKind.PERSONAL);
  const project = store.createSpace('Project A', SpaceKind.PUBLIC);
  const modes = [];
  let wrapped;
  wrapped = overrideStore(store, {
    transaction(fn, options) {
      modes.push(options?.mode);
      return store.transaction(() => fn(wrapped), options);
    }
  });
  const service = new IngestionService(wrapped);

  service.publishConfirmed({
    targetSpaceId: project.id,
    sourceKind: 'prd',
    body: 'runtime: node-24'
  });
  const episode = store.addEpisode(project.id, 'prd', 'url: https://example.test');
  service.confirmEpisode({ spaceId: project.id, episode });
  const candidate = service.remember({
    personalSpaceId: personal.id,
    targetSpaceId: project.id,
    sourceKind: 'chat',
    body: 'port: 8080'
  }).candidate;
  assert.deepEqual(modes, ['immediate', 'immediate', 'immediate']);
  modes.length = 0;
  decideCandidate(wrapped, candidate.id, 'sync', { ingestion: service });

  assert.deepEqual(modes, ['immediate']);
});

test('candidate decision rolls back publication when its status update fails', () => {
  const store = new FileStore(':memory:');
  const personal = store.createSpace('Jevons', SpaceKind.PERSONAL);
  const project = store.createSpace('Project A', SpaceKind.PUBLIC);
  const candidate = new IngestionService(store).remember({
    personalSpaceId: personal.id,
    targetSpaceId: project.id,
    sourceKind: 'chat',
    body: 'runtime: node-24'
  }).candidate;
  const before = store.exportSnapshot();
  const failingStore = overrideStore(store, {
    updateCandidateStatus(...args) {
      store.updateCandidateStatus(...args);
      throw new Error('status write failed');
    }
  });

  assert.throws(
    () => decideCandidate(failingStore, candidate.id, 'sync'),
    /status write failed/
  );
  assert.deepEqual(store.exportSnapshot(), before);
});

function overrideStore(store, overrides) {
  return Object.fromEntries(
    STORE_METHODS.map((method) => [
      method,
      overrides[method] ?? ((...args) => store[method](...args))
    ])
  );
}
