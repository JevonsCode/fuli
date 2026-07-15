import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CandidateStatus, FactStatus, SpaceKind } from '../src/models.js';
import { FileStore } from '../src/store.js';

test('store returns only current facts by default and keeps timeline', () => {
  const store = new FileStore(':memory:');
  const project = store.createSpace('Project A', SpaceKind.PUBLIC);
  const episode = store.addEpisode(project.id, 'prd', 'test_url: https://old.example.com');

  const oldFact = store.addFact({
    spaceId: project.id,
    subject: 'Project A',
    predicate: 'has_test_url',
    object: 'https://old.example.com',
    sourceEpisodeId: episode.id,
    status: FactStatus.CONFIRMED
  });

  store.invalidateFact(oldFact.id, 'future-fact');

  assert.deepEqual(store.currentFacts(project.id), []);
  assert.equal(store.timeline(project.id, 'Project A').length, 1);
});

test('store can subscribe a personal space to a public space', () => {
  const store = new FileStore(':memory:');
  const personal = store.createSpace('Jevons', SpaceKind.PERSONAL);
  const project = store.createSpace('Project A', SpaceKind.PUBLIC);

  const subscription = store.subscribe(personal.id, project.id);

  assert.equal(subscription.mode, 'latest');
  assert.deepEqual(store.subscriptionsFor(personal.id), [subscription]);
});

test('store searches current facts across spaces', () => {
  const store = new FileStore(':memory:');
  const project = store.createSpace('Project A', SpaceKind.PUBLIC);
  const episode = store.addEpisode(project.id, 'prd', 'test_url: https://test.example.com');
  store.addFact({
    spaceId: project.id,
    subject: 'Project A',
    predicate: 'has_test_url',
    object: 'https://test.example.com',
    sourceEpisodeId: episode.id,
    status: FactStatus.CONFIRMED
  });

  const results = store.searchFacts([project.id], 'test_url');

  assert.equal(results.length, 1);
  assert.equal(results[0].object, 'https://test.example.com');
});

test('store updates candidate status', () => {
  const store = new FileStore(':memory:');
  const personal = store.createSpace('Jevons', SpaceKind.PERSONAL);
  const episode = store.addEpisode(personal.id, 'chat', '可能这个模块以后要拆出去');
  const candidate = store.addCandidate({
    personalSpaceId: personal.id,
    episodeId: episode.id,
    reason: 'needs human decision'
  });

  const updated = store.updateCandidateStatus(candidate.id, CandidateStatus.IGNORED);

  assert.equal(updated.status, CandidateStatus.IGNORED);
  assert.equal(store.pendingCandidates(personal.id).length, 0);
});

test('store lists each persisted domain record', () => {
  const store = new FileStore(':memory:');
  const personal = store.createSpace('Jevons', SpaceKind.PERSONAL);
  const project = store.createSpace('Project A', SpaceKind.PUBLIC);
  const subscription = store.subscribe(personal.id, project.id);
  const episode = store.addEpisode(project.id, 'prd', 'api_base: https://api.example.com');
  const fact = store.addFact({
    spaceId: project.id,
    subject: 'Project A',
    predicate: 'has_api_base',
    object: 'https://api.example.com',
    sourceEpisodeId: episode.id
  });
  const candidate = store.addCandidate({
    personalSpaceId: personal.id,
    targetSpaceId: project.id,
    episodeId: episode.id,
    reason: 'needs review'
  });

  assert.deepEqual(store.listSpaces(), [personal, project]);
  assert.deepEqual(store.listSubscriptions(), [subscription]);
  assert.deepEqual(store.listEpisodes(), [episode]);
  assert.deepEqual(store.listFacts(), [fact]);
  assert.deepEqual(store.listCandidates(), [candidate]);
});

test('store gets episodes and facts by id', () => {
  const store = new FileStore(':memory:');
  const project = store.createSpace('Project A', SpaceKind.PUBLIC);
  const episode = store.addEpisode(project.id, 'prd', 'region: eu-west-1');
  const fact = store.addFact({
    spaceId: project.id,
    subject: 'Project A',
    predicate: 'has_region',
    object: 'eu-west-1',
    sourceEpisodeId: episode.id
  });

  assert.deepEqual(store.getEpisode(episode.id), episode);
  assert.deepEqual(store.getFact(fact.id), fact);
  assert.notEqual(store.getEpisode(episode.id), episode);
  assert.notEqual(store.getFact(fact.id), fact);
  assert.equal(store.getEpisode('missing'), null);
  assert.equal(store.getFact('missing'), null);
});

test('store updates an existing fact', () => {
  const store = new FileStore(':memory:');
  const project = store.createSpace('Project A', SpaceKind.PUBLIC);
  const episode = store.addEpisode(project.id, 'prd', 'runtime: node');
  const fact = store.addFact({
    spaceId: project.id,
    subject: 'Project A',
    predicate: 'has_runtime',
    object: 'node',
    sourceEpisodeId: episode.id,
    status: FactStatus.OBSERVED
  });

  const updated = store.updateFact(fact.id, {
    object: 'node-24',
    status: FactStatus.CONFIRMED
  });

  assert.notEqual(updated, fact);
  assert.equal(store.getFact(fact.id).object, 'node-24');
  assert.equal(store.getFact(fact.id).status, FactStatus.CONFIRMED);
  assert.throws(() => store.updateFact('missing', { status: FactStatus.REJECTED }), /Fact not found/);
});

test('store lists historical facts only when requested', () => {
  const store = new FileStore(':memory:');
  const project = store.createSpace('Project A', SpaceKind.PUBLIC);
  const episode = store.addEpisode(project.id, 'prd', 'runtime: node');
  const fact = store.addFact({
    spaceId: project.id,
    subject: 'Project A',
    predicate: 'has_runtime',
    object: 'node',
    sourceEpisodeId: episode.id
  });
  store.invalidateFact(fact.id);

  assert.deepEqual(store.listFacts(), []);
  assert.deepEqual(store.listFacts({ includeHistorical: true }), [{
    ...fact,
    invalidAt: store.getFact(fact.id).invalidAt
  }]);
});

test('store transaction rolls back writes when the callback fails', () => {
  const store = new FileStore(':memory:');
  const project = store.createSpace('Project A', SpaceKind.PUBLIC);
  const failure = new Error('stop transaction');

  assert.throws(
    () => store.transaction((transactionStore) => {
      assert.equal(transactionStore, store);
      transactionStore.createSpace('Transient', SpaceKind.PUBLIC);
      throw failure;
    }),
    failure
  );

  assert.deepEqual(store.listSpaces(), [project]);
});

test('store exports a deep-cloned snapshot', () => {
  const store = new FileStore(':memory:');
  const project = store.createSpace('Project A', SpaceKind.PUBLIC);

  const snapshot = store.exportSnapshot();
  snapshot.spaces[0].name = 'Changed outside the store';
  snapshot.spaces.push({ id: 'external' });

  assert.equal(store.getSpace(project.id).name, 'Project A');
  assert.equal(store.listSpaces().length, 1);
});

test('store imports a cloned legacy snapshot', () => {
  const snapshot = {
    spaces: [{
      id: 'project-1',
      name: 'Project A',
      kind: SpaceKind.PUBLIC,
      description: null,
      createdAt: '2026-07-10T00:00:00.000Z'
    }],
    subscriptions: [],
    episodes: [],
    facts: [],
    candidates: []
  };
  const store = new FileStore(':memory:');

  store.importSnapshot(snapshot);
  snapshot.spaces[0].name = 'Changed outside the store';

  assert.equal(store.getSpace('project-1').name, 'Project A');
  assert.deepEqual(store.exportSnapshot().outbox, []);
  assert.deepEqual(store.exportSnapshot().imports, []);
});

test('store advances an outbox row through retry and sent states', () => {
  const store = new FileStore(':memory:');
  const row = store.enqueueOutbox({
    id: 'outbox-1',
    kind: 'publication',
    aggregateId: 'project-1',
    payload: { contentHash: 'abc123' },
    createdAt: '2026-07-10T00:00:00.000Z'
  });

  assert.deepEqual(row, {
    id: 'outbox-1',
    kind: 'publication',
    aggregateId: 'project-1',
    payload: { contentHash: 'abc123' },
    status: 'pending',
    attempts: 0,
    nextAttemptAt: null,
    createdAt: '2026-07-10T00:00:00.000Z',
    sentAt: null,
    lastError: null
  });
  assert.deepEqual(store.listPendingOutbox('2026-07-10T00:01:00.000Z'), [row]);

  const failed = store.markOutboxFailed(
    row.id,
    'offline',
    '2026-07-10T00:05:00.000Z'
  );
  assert.equal(failed.status, 'pending');
  assert.equal(failed.attempts, 1);
  assert.equal(failed.lastError, 'offline');
  assert.deepEqual(store.listPendingOutbox('2026-07-10T00:04:59.000Z'), []);
  assert.deepEqual(store.listPendingOutbox('2026-07-10T00:05:00.000Z'), [failed]);

  const sent = store.markOutboxSent(row.id, '2026-07-10T00:06:00.000Z');
  assert.equal(sent.status, 'sent');
  assert.equal(sent.sentAt, '2026-07-10T00:06:00.000Z');
  assert.equal(sent.lastError, null);
  assert.deepEqual(store.listPendingOutbox('2026-07-10T00:07:00.000Z'), []);
});

test('store tracks completed imports by content hash', () => {
  const store = new FileStore(':memory:');
  const record = {
    contentHash: 'content-sha-256',
    sourcePath: 'legacy.json',
    importedAt: '2026-07-10T00:00:00.000Z'
  };

  assert.equal(store.hasImport(record.contentHash), false);
  assert.deepEqual(store.recordImport(record), record);
  assert.equal(store.hasImport(record.contentHash), true);
  assert.deepEqual(store.exportSnapshot().imports, [record]);
});

test('store close is an idempotent no-op', () => {
  const store = new FileStore(':memory:');

  assert.doesNotThrow(() => {
    store.close();
    store.close();
  });
});

test('store isolates returned single rows from internal records', () => {
  const store = new FileStore(':memory:');
  const created = store.createSpace('Project A', SpaceKind.PUBLIC);

  created.name = 'Changed after create';
  const loaded = store.getSpace(created.id);
  assert.equal(loaded.name, 'Project A');

  loaded.name = 'Changed after get';
  assert.equal(store.findSpaceByName('Project A').name, 'Project A');
});

test('store isolates returned lists and their rows from internal collections', () => {
  const store = new FileStore(':memory:');
  const project = store.createSpace('Project A', SpaceKind.PUBLIC);
  const spaces = store.listSpaces();

  spaces[0].name = 'Changed through list row';
  spaces.push({ id: 'external' });

  assert.deepEqual(store.listSpaces(), [project]);
});

test('store isolates nested outbox payloads across public boundaries', () => {
  const store = new FileStore(':memory:');
  const enqueued = store.enqueueOutbox({
    id: 'outbox-isolation',
    kind: 'publication',
    aggregateId: 'project-1',
    payload: { envelope: { version: 1 } }
  });

  enqueued.payload.envelope.version = 2;
  const pending = store.listPendingOutbox();
  assert.equal(pending[0].payload.envelope.version, 1);

  pending[0].payload.envelope.version = 3;
  assert.equal(store.listPendingOutbox()[0].payload.envelope.version, 1);
});

test('disk-backed transaction buffers writes and replaces the file once on commit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fuli-file-store-'));
  const filePath = join(dir, 'context.json');
  let replacements = 0;
  const store = new FileStore(filePath, {
    jsonFileIo: {
      renameSync(from, to) {
        replacements += 1;
        renameSync(from, to);
      }
    }
  });

  try {
    store.createSpace('Before', SpaceKind.PUBLIC);
    const before = readFileSync(filePath, 'utf8');
    replacements = 0;

    const result = store.transaction((transactionStore) => {
      transactionStore.createSpace('First', SpaceKind.PUBLIC);
      transactionStore.createSpace('Second', SpaceKind.PUBLIC);
      assert.equal(readFileSync(filePath, 'utf8'), before);
      return 'committed';
    });

    assert.equal(result, 'committed');
    assert.equal(replacements, 1);
    assert.deepEqual(
      JSON.parse(readFileSync(filePath, 'utf8')).spaces.map((space) => space.name),
      ['Before', 'First', 'Second']
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('disk-backed transaction leaves the file untouched when its callback fails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fuli-file-store-'));
  const filePath = join(dir, 'context.json');
  const store = new FileStore(filePath);

  try {
    const beforeSpace = store.createSpace('Before', SpaceKind.PUBLIC);
    const before = readFileSync(filePath, 'utf8');

    assert.throws(() => store.transaction((transactionStore) => {
      transactionStore.createSpace('Transient', SpaceKind.PUBLIC);
      assert.equal(readFileSync(filePath, 'utf8'), before);
      throw new Error('callback failed');
    }), /callback failed/);

    assert.equal(readFileSync(filePath, 'utf8'), before);
    assert.deepEqual(store.listSpaces(), [beforeSpace]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('disk-backed transaction rejects thenables and rolls back synchronously', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fuli-file-store-'));
  const filePath = join(dir, 'context.json');
  const store = new FileStore(filePath);

  try {
    const beforeSpace = store.createSpace('Before', SpaceKind.PUBLIC);
    const before = readFileSync(filePath, 'utf8');

    assert.throws(
      () => store.transaction(async (transactionStore) => {
        transactionStore.createSpace('Async', SpaceKind.PUBLIC);
      }),
      /transaction callback must be synchronous/i
    );

    assert.equal(readFileSync(filePath, 'utf8'), before);
    assert.deepEqual(store.listSpaces(), [beforeSpace]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('disk-backed transaction rejects a thenable returned by a synchronous callback', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fuli-file-store-'));
  const filePath = join(dir, 'context.json');
  const store = new FileStore(filePath);

  try {
    const beforeSpace = store.createSpace('Before', SpaceKind.PUBLIC);
    const before = readFileSync(filePath, 'utf8');

    assert.throws(
      () => store.transaction((transactionStore) => {
        transactionStore.createSpace('Thenable', SpaceKind.PUBLIC);
        return { then() {} };
      }),
      /transaction callback must be synchronous/i
    );

    assert.equal(readFileSync(filePath, 'utf8'), before);
    assert.deepEqual(store.listSpaces(), [beforeSpace]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('disk-backed transaction restores memory when atomic commit fails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fuli-file-store-'));
  const filePath = join(dir, 'context.json');
  const initialStore = new FileStore(filePath);

  try {
    const beforeSpace = initialStore.createSpace('Before', SpaceKind.PUBLIC);
    const before = readFileSync(filePath, 'utf8');
    const store = new FileStore(filePath, {
      jsonFileIo: {
        renameSync() {
          throw new Error('commit rename failed');
        }
      }
    });

    assert.throws(() => store.transaction((transactionStore) => {
      transactionStore.createSpace('Transient', SpaceKind.PUBLIC);
    }), /commit rename failed/);

    assert.equal(readFileSync(filePath, 'utf8'), before);
    assert.deepEqual(store.listSpaces(), [beforeSpace]);
    assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith('.tmp')), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('disk-backed transaction rejects nesting without corrupting outer rollback state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fuli-file-store-'));
  const filePath = join(dir, 'context.json');
  const store = new FileStore(filePath);

  try {
    const beforeSpace = store.createSpace('Before', SpaceKind.PUBLIC);
    const before = readFileSync(filePath, 'utf8');
    const outerFailure = new Error('outer failed');
    let innerCalled = false;

    assert.throws(() => store.transaction((outerStore) => {
      outerStore.createSpace('Outer before nesting', SpaceKind.PUBLIC);
      assert.throws(
        () => outerStore.transaction(() => {
          innerCalled = true;
        }),
        (error) => {
          assert.equal(error instanceof TypeError, true);
          assert.match(error.message, /Nested FileStore transactions are not supported/);
          return true;
        }
      );
      outerStore.createSpace('Outer after nesting', SpaceKind.PUBLIC);
      assert.equal(readFileSync(filePath, 'utf8'), before);
      throw outerFailure;
    }), outerFailure);

    assert.equal(innerCalled, false);
    assert.equal(readFileSync(filePath, 'utf8'), before);
    assert.deepEqual(store.listSpaces(), [beforeSpace]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('standalone disk mutation restores memory when atomic rename fails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fuli-file-store-'));
  const filePath = join(dir, 'context.json');
  const initialStore = new FileStore(filePath);

  try {
    const beforeSpace = initialStore.createSpace('Before', SpaceKind.PUBLIC);
    let replacements = 0;
    const store = new FileStore(filePath, {
      jsonFileIo: {
        renameSync(from, to) {
          replacements += 1;
          if (replacements === 1) throw new Error('standalone rename failed');
          renameSync(from, to);
        }
      }
    });

    assert.throws(
      () => store.createSpace('Failed', SpaceKind.PUBLIC),
      /standalone rename failed/
    );
    assert.deepEqual(store.listSpaces(), [beforeSpace]);
    assert.deepEqual(
      JSON.parse(readFileSync(filePath, 'utf8')).spaces.map((space) => space.name),
      ['Before']
    );

    const laterSpace = store.createSpace('Later', SpaceKind.PUBLIC);
    assert.deepEqual(store.listSpaces(), [beforeSpace, laterSpace]);
    assert.deepEqual(
      JSON.parse(readFileSync(filePath, 'utf8')).spaces.map((space) => space.name),
      ['Before', 'Later']
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('legacy snapshot imports retain hashes across an A-B-A sequence', () => {
  const store = new FileStore(':memory:');
  const snapshotA = legacySnapshot('space-a', 'Project A');
  const snapshotB = legacySnapshot('space-b', 'Project B');

  assert.equal(importOnce(store, snapshotA, 'hash-a'), true);
  assert.equal(importOnce(store, snapshotB, 'hash-b'), true);
  assert.equal(importOnce(store, snapshotA, 'hash-a'), false);

  assert.equal(store.hasImport('hash-a'), true);
  assert.equal(store.hasImport('hash-b'), true);
  assert.deepEqual(store.listSpaces(), snapshotB.spaces);
});

test('legacy snapshot import preserves pending outbox rows when outbox is omitted', () => {
  const store = new FileStore(':memory:');
  const pending = store.enqueueOutbox({
    id: 'outbox-before-import',
    kind: 'publication',
    aggregateId: 'project-1',
    payload: { contentHash: 'abc123' }
  });

  store.importSnapshot(legacySnapshot('space-a', 'Project A'));

  assert.deepEqual(store.listPendingOutbox(), [pending]);
});

test('snapshot import restores explicit outbox and import bookkeeping', () => {
  const store = new FileStore(':memory:');
  store.enqueueOutbox({
    id: 'old-outbox',
    kind: 'publication',
    aggregateId: 'project-old',
    payload: { contentHash: 'old' }
  });
  store.recordImport({
    contentHash: 'old-hash',
    sourcePath: 'old.json',
    importedAt: '2026-07-10T00:00:00.000Z'
  });
  const explicitOutbox = [{
    id: 'restored-outbox',
    kind: 'publication',
    aggregateId: 'project-restored',
    payload: { contentHash: 'restored' },
    status: 'pending',
    attempts: 0,
    nextAttemptAt: null,
    createdAt: '2026-07-10T00:00:00.000Z',
    sentAt: null,
    lastError: null
  }];
  const explicitImports = [{
    contentHash: 'restored-hash',
    sourcePath: 'restored.json',
    importedAt: '2026-07-10T00:00:00.000Z'
  }];

  store.importSnapshot({
    ...legacySnapshot('space-restored', 'Restored'),
    outbox: explicitOutbox,
    imports: explicitImports
  });

  assert.deepEqual(store.exportSnapshot().outbox, explicitOutbox);
  assert.deepEqual(store.exportSnapshot().imports, explicitImports);
  assert.equal(store.hasImport('old-hash'), false);
});

test('store rejects a duplicate caller-supplied fact id before mutation', () => {
  const store = new FileStore(':memory:');
  const fact = {
    id: 'fact-duplicate',
    spaceId: 'space-1',
    subject: 'Project A',
    predicate: 'has_runtime',
    object: 'node',
    sourceEpisodeId: 'episode-1'
  };
  store.addFact(fact);
  const before = store.exportSnapshot();

  assert.throws(
    () => store.addFact({ ...fact, object: 'python' }),
    /Duplicate fact id: fact-duplicate/
  );
  assert.deepEqual(store.exportSnapshot(), before);
});

test('store rejects a duplicate caller-supplied candidate id before mutation', () => {
  const store = new FileStore(':memory:');
  const candidate = {
    id: 'candidate-duplicate',
    personalSpaceId: 'personal-1',
    episodeId: 'episode-1',
    reason: 'needs review'
  };
  store.addCandidate(candidate);
  const before = store.exportSnapshot();

  assert.throws(
    () => store.addCandidate({ ...candidate, reason: 'different reason' }),
    /Duplicate candidate id: candidate-duplicate/
  );
  assert.deepEqual(store.exportSnapshot(), before);
});

test('store rejects a duplicate caller-supplied outbox id before mutation', () => {
  const store = new FileStore(':memory:');
  const entry = {
    id: 'outbox-duplicate',
    kind: 'publication',
    aggregateId: 'project-1',
    payload: { contentHash: 'first' }
  };
  store.enqueueOutbox(entry);
  const before = store.exportSnapshot();

  assert.throws(
    () => store.enqueueOutbox({ ...entry, payload: { contentHash: 'second' } }),
    /Duplicate outbox id: outbox-duplicate/
  );
  assert.deepEqual(store.exportSnapshot(), before);
});

test('store rejects a duplicate import content hash before mutation', () => {
  const store = new FileStore(':memory:');
  const record = {
    contentHash: 'hash-duplicate',
    sourcePath: 'first.json',
    importedAt: '2026-07-10T00:00:00.000Z'
  };
  store.recordImport(record);
  const before = store.exportSnapshot();

  assert.throws(
    () => store.recordImport({ ...record, sourcePath: 'second.json' }),
    /Duplicate import content hash: hash-duplicate/
  );
  assert.deepEqual(store.exportSnapshot(), before);
});

function legacySnapshot(id, name) {
  return {
    spaces: [{
      id,
      name,
      kind: SpaceKind.PUBLIC,
      description: null,
      createdAt: '2026-07-10T00:00:00.000Z'
    }],
    subscriptions: [],
    episodes: [],
    facts: [],
    candidates: []
  };
}

function importOnce(store, snapshot, contentHash) {
  if (store.hasImport(contentHash)) return false;
  store.transaction(() => {
    store.importSnapshot(snapshot);
    store.recordImport({
      contentHash,
      sourcePath: `${contentHash}.json`,
      importedAt: '2026-07-10T00:00:00.000Z'
    });
  });
  return true;
}
