import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { FileStore } from '../src/storage/file-store.js';
import {
  applyPreparedJsonSnapshot,
  importJsonSnapshot,
  prepareJsonSnapshot
} from '../src/storage/import-json.js';
import { SqliteStore } from '../src/storage/sqlite-store.js';

const storeFactories = [
  ['FileStore', () => new FileStore(':memory:')],
  ['SqliteStore', () => new SqliteStore(':memory:')]
];

test('legacy JSON can be prepared without a store and applied once later', () => {
  const source = createLegacyFixture();
  const prepared = prepareJsonSnapshot(source, 'legacy.json');
  const store = new FileStore(':memory:');

  assert.match(prepared.contentHash, /^[a-f0-9]{64}$/);
  assert.equal(prepared.sourcePath, 'legacy.json');
  assert.deepEqual(prepared.snapshot, source);
  assert.deepEqual(
    applyPreparedJsonSnapshot(store, prepared),
    { imported: true, contentHash: prepared.contentHash }
  );
});

for (const [name, createStore] of storeFactories) {
  test(`${name} imports legacy JSON without losing history and is idempotent`, (t) => {
    const store = createStore();
    t.after(() => store.close());
    const source = createLegacyFixture();

    const first = importJsonSnapshot(store, source, 'legacy.json');
    const second = importJsonSnapshot(store, reorderObjectKeys(source), 'legacy.json');

    assert.equal(first.imported, true);
    assert.equal(second.imported, false);
    assert.match(first.contentHash, /^[a-f0-9]{64}$/);
    assert.equal(first.contentHash, second.contentHash);
    assert.deepEqual(store.listSpaces(), source.spaces);
    assert.deepEqual(store.listSubscriptions(), source.subscriptions);
    assert.deepEqual(store.listEpisodes(), source.episodes);
    assert.deepEqual(store.listFacts({ includeHistorical: true }), source.facts);
    assert.deepEqual(store.listCandidates(), source.candidates);
    assert.deepEqual(store.exportSnapshot().outbox, source.outbox);
    assert.equal(store.exportSnapshot().imports.length, 1);
  });

  test(`${name} rejects a new hash for a nonempty destination unless replacement is explicit`, (t) => {
    const store = createStore();
    t.after(() => store.close());
    const original = createLegacyFixture();
    const replacement = createLegacyFixture();
    replacement.facts[0].object = 'replacement value';

    importJsonSnapshot(store, original, 'original.json');
    const before = store.exportSnapshot();

    assert.throws(
      () => importJsonSnapshot(store, replacement, 'replacement.json'),
      /Destination snapshot is not empty; pass replace: true to replace it/
    );
    assert.deepEqual(store.exportSnapshot(), before);

    assert.deepEqual(
      importJsonSnapshot(store, replacement, 'replacement.json', { replace: true }),
      { imported: true, contentHash: prepareJsonSnapshot(replacement).contentHash }
    );
    assert.equal(store.getFact('fact-old').object, 'replacement value');
  });

  test(`${name} validates legacy JSON before changing existing data`, (t) => {
    const store = createStore();
    t.after(() => store.close());
    const existing = store.createSpace('Existing', 'personal');
    const before = store.exportSnapshot();
    const malformed = createLegacyFixture();
    malformed.facts[0].sourceEpisodeId = 'missing-episode';

    assert.throws(
      () => importJsonSnapshot(store, malformed),
      /Fact fact-old references missing episode: missing-episode/
    );
    assert.deepEqual(store.exportSnapshot(), before);
    assert.equal(store.getSpace(existing.id).name, 'Existing');
  });
}

test('legacy imports with missing optional timestamps hash stably across repeated calls', () => {
  const store = new SqliteStore(':memory:');
  const source = createLegacyFixture();
  delete source.spaces[0].createdAt;
  delete source.subscriptions[0].createdAt;
  delete source.episodes[0].createdAt;
  delete source.facts[0].validAt;
  delete source.candidates[0].createdAt;

  const first = importJsonSnapshot(store, source);
  const second = importJsonSnapshot(store, source);

  assert.equal(first.imported, true);
  assert.equal(second.imported, false);
  assert.equal(first.contentHash, second.contentHash);
  store.close();
});

test('prepare canonical-clones and deep-freezes prepared data', () => {
  const source = createLegacyFixture();
  const prepared = prepareJsonSnapshot(source, 'legacy.json');

  assert.notEqual(prepared.snapshot, source);
  assert.equal(Object.isFrozen(prepared), true);
  assert.equal(Object.isFrozen(prepared.snapshot), true);
  assert.equal(Object.isFrozen(prepared.snapshot.facts), true);
  assert.equal(Object.isFrozen(prepared.snapshot.episodes[0].metadata), true);
  assert.throws(() => { prepared.snapshot.facts.reverse(); }, TypeError);
  assert.equal(source.facts[0].object, 'https://old.example.com');
});

test('apply rejects forged prepared content before changing the destination', () => {
  const store = new FileStore(':memory:');
  const prepared = prepareJsonSnapshot(createLegacyFixture(), 'legacy.json');
  const forged = {
    ...prepared,
    snapshot: JSON.parse(JSON.stringify(prepared.snapshot)),
    contentHash: '0'.repeat(64)
  };
  forged.snapshot.facts[0].object = 'forged value';

  assert.throws(
    () => applyPreparedJsonSnapshot(store, forged),
    /Prepared snapshot content hash does not match/
  );
  assert.deepEqual(store.exportSnapshot(), {
    spaces: [], subscriptions: [], episodes: [], facts: [], candidates: [], outbox: [], imports: []
  });
  store.close();
});

test('reordered legacy records produce a different content hash', () => {
  const source = createLegacyFixture();
  const reordered = createLegacyFixture();
  reordered.facts.reverse();

  assert.notEqual(
    prepareJsonSnapshot(source).contentHash,
    prepareJsonSnapshot(reordered).contentHash
  );
});

for (const [name, createStore] of storeFactories) {
  test(`${name} rolls back the snapshot when recording its import fails`, (t) => {
    const store = createStore();
    t.after(() => store.close());
    store.createSpace('Existing', 'personal');
    const before = store.exportSnapshot();
    store.recordImport = () => { throw new Error('forced import record failure'); };

    assert.throws(
      () => importJsonSnapshot(store, createLegacyFixture(), '<memory>', { replace: true }),
      /forced import record failure/
    );
    assert.deepEqual(store.exportSnapshot(), before);
  });
}

test('legacy JSON rejects duplicate ids, malformed optional collections, and invalid references', () => {
  const store = new FileStore(':memory:');
  const cases = [
    [
      'duplicate space id',
      (snapshot) => { snapshot.spaces.push({ ...snapshot.spaces[0], name: 'Duplicate' }); },
      /Duplicate space id: personal-1/
    ],
    [
      'duplicate subscription',
      (snapshot) => { snapshot.subscriptions.push({ ...snapshot.subscriptions[0] }); },
      /Duplicate subscription: personal-1 -> project-1/
    ],
    [
      'invalid space kind',
      (snapshot) => { snapshot.spaces[0].kind = 'unknown'; },
      /Invalid space kind: unknown/
    ],
    [
      'non-array outbox',
      (snapshot) => { snapshot.outbox = {}; },
      /Snapshot outbox must be an array/
    ],
    [
      'non-array imports',
      (snapshot) => { snapshot.imports = {}; },
      /Snapshot imports must be an array/
    ],
    [
      'candidate target space',
      (snapshot) => { snapshot.candidates[0].targetSpaceId = 'missing-space'; },
      /Candidate candidate-1 references missing target space: missing-space/
    ],
    [
      'fact replacement',
      (snapshot) => { snapshot.facts[0].replacedByFactId = 'missing-fact'; },
      /Fact fact-old references missing replacement fact: missing-fact/
    ]
  ];

  for (const [name, arrange, expected] of cases) {
    const snapshot = createLegacyFixture();
    arrange(snapshot);
    assert.throws(() => importJsonSnapshot(store, snapshot), expected, name);
  }
});

test('two SQLite connections race safely on a pre-migrated destination', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'fuli-import-race-'));
  const databasePath = join(dir, 'context.db');
  const source = createLegacyFixture();
  const setup = new SqliteStore(databasePath);
  setup.close();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const results = await Promise.all([
    runImportChild(databasePath, source),
    runImportChild(databasePath, source)
  ]);

  assert.deepEqual(results.map((result) => result.imported).sort(), [false, true]);
  const store = new SqliteStore(databasePath);
  try {
    assert.equal(store.exportSnapshot().imports.length, 1);
    assert.deepEqual(store.listSpaces(), source.spaces);
  } finally {
    store.close();
  }
});

function createLegacyFixture() {
  return {
    spaces: [
      {
        id: 'personal-1',
        name: 'Jevons',
        kind: 'personal',
        description: null,
        createdAt: '2026-01-01T00:00:00.000Z'
      },
      {
        id: 'project-1',
        name: 'Project A',
        kind: 'public',
        description: 'A test project',
        createdAt: '2026-01-01T00:01:00.000Z'
      }
    ],
    subscriptions: [
      {
        personalSpaceId: 'personal-1',
        spaceId: 'project-1',
        mode: 'latest',
        createdAt: '2026-01-01T00:02:00.000Z'
      }
    ],
    episodes: [
      {
        id: 'episode-1',
        spaceId: 'project-1',
        sourceKind: 'prd',
        body: 'test_url changed',
        sourceUri: 'file:///project/prd.md',
        metadata: { version: 2 },
        createdAt: '2026-01-01T00:03:00.000Z'
      }
    ],
    facts: [
      {
        id: 'fact-old',
        spaceId: 'project-1',
        subject: 'Project A',
        predicate: 'test_url',
        object: 'https://old.example.com',
        sourceEpisodeId: 'episode-1',
        status: 'deprecated',
        confidence: 0.7,
        sensitivity: 'private',
        scope: 'public',
        validAt: '2026-01-01T00:04:00.000Z',
        invalidAt: '2026-01-01T00:05:00.000Z',
        replacedByFactId: 'fact-new'
      },
      {
        id: 'fact-new',
        spaceId: 'project-1',
        subject: 'Project A',
        predicate: 'test_url',
        object: 'https://new.example.com',
        sourceEpisodeId: 'episode-1',
        status: 'confirmed',
        confidence: 1,
        sensitivity: 'normal',
        scope: 'public',
        validAt: '2026-01-01T00:05:00.000Z',
        invalidAt: null,
        replacedByFactId: null
      }
    ],
    candidates: [
      {
        id: 'candidate-1',
        personalSpaceId: 'personal-1',
        targetSpaceId: 'project-1',
        episodeId: 'episode-1',
        reason: 'Needs a decision',
        status: 'pending',
        createdAt: '2026-01-01T00:06:00.000Z',
        decidedAt: null
      }
    ],
    outbox: [
      {
        id: 'outbox-1',
        kind: 'publication',
        aggregateId: 'project-1',
        payload: { episodeId: 'episode-1' },
        status: 'pending',
        attempts: 0,
        nextAttemptAt: null,
        createdAt: '2026-01-01T00:07:00.000Z',
        sentAt: null,
        lastError: null
      }
    ]
  };
}

function reorderObjectKeys(value) {
  if (Array.isArray(value)) return value.map(reorderObjectKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).reverse().map((key) => [key, reorderObjectKeys(value[key])]));
  }
  return value;
}

function runImportChild(databasePath, source) {
  const importModule = new URL('../src/storage/import-json.js', import.meta.url).href;
  const storeModule = new URL('../src/storage/sqlite-store.js', import.meta.url).href;
  const sourceLiteral = JSON.stringify(source);
  const script = `
    import { applyPreparedJsonSnapshot, prepareJsonSnapshot } from ${JSON.stringify(importModule)};
    import { SqliteStore } from ${JSON.stringify(storeModule)};
    const store = new SqliteStore(process.env.FULI_RACE_DB);
    try {
      const prepared = prepareJsonSnapshot(${sourceLiteral}, 'race.json');
      process.stdout.write(JSON.stringify(applyPreparedJsonSnapshot(store, prepared)));
    } finally {
      store.close();
    }
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
      env: { ...process.env, FULI_RACE_DB: databasePath },
      encoding: 'utf8'
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => {
      if (status !== 0) {
        reject(new Error(`race child failed (${status}): ${stderr}`));
        return;
      }
      resolve(JSON.parse(stdout));
    });
  });
}
