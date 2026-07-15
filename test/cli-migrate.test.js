import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { migrateLegacyJson } from '../src/cli/migrate-command.js';
import { SqliteStore } from '../src/storage/sqlite-store.js';

const NODE = process.execPath;
const CLI = resolve('src/cli.js');

test('CLI migrates a legacy JSON snapshot into SQLite and reruns as a no-op', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fuli-cli-migrate-'));
  const sourcePath = join(dir, 'context.json');
  const destinationPath = join(dir, 'context.db');
  writeFileSync(sourcePath, JSON.stringify(legacySnapshot()), 'utf8');

  const first = JSON.parse(execFileSync(NODE, [CLI, 'migrate', '--from', sourcePath, '--to', destinationPath], {
    encoding: 'utf8'
  }));
  const second = JSON.parse(execFileSync(NODE, [CLI, 'migrate', '--from', sourcePath, '--to', destinationPath], {
    encoding: 'utf8'
  }));

  assert.deepEqual(first.imported, true);
  assert.match(first.contentHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(second, { imported: false, contentHash: first.contentHash });
  assert.equal(readFileSync(destinationPath).subarray(0, 16).toString('utf8'), 'SQLite format 3\u0000');
  assert.deepEqual(readdirSync(dir).sort(), ['context.db', 'context.json']);
});

test('CLI migrate rejects a new hash by default and replaces only with --replace', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fuli-cli-migrate-replace-'));
  const sourcePath = join(dir, 'context.json');
  const destinationPath = join(dir, 'context.db');
  const original = legacySnapshot();
  writeFileSync(sourcePath, JSON.stringify(original), 'utf8');
  execFileSync(NODE, [CLI, 'migrate', '--from', sourcePath, '--to', destinationPath], {
    encoding: 'utf8'
  });

  const replacement = legacySnapshot();
  replacement.facts[0].object = 'replacement value';
  writeFileSync(sourcePath, JSON.stringify(replacement), 'utf8');
  const rejected = runCliFailure('migrate', '--from', sourcePath, '--to', destinationPath);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /Destination snapshot is not empty; pass replace: true to replace it/);

  const replaced = JSON.parse(execFileSync(
    NODE,
    [CLI, 'migrate', '--from', sourcePath, '--to', destinationPath, '--replace'],
    { encoding: 'utf8' }
  ));
  assert.equal(replaced.imported, true);
});

test('CLI migrate reports missing flags, malformed JSON, and invalid references', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fuli-cli-migrate-errors-'));
  const sourcePath = join(dir, 'context.json');
  const destinationPath = join(dir, 'context.db');
  writeFileSync(sourcePath, '{not json', 'utf8');

  const missingFlags = runCliFailure('migrate');
  const malformed = runCliFailure('migrate', '--from', sourcePath, '--to', destinationPath);
  assert.equal(existsSync(destinationPath), false);
  writeFileSync(sourcePath, JSON.stringify({
    ...legacySnapshot(),
    facts: [{ ...legacySnapshot().facts[0], sourceEpisodeId: 'missing-episode' }]
  }), 'utf8');
  const invalidReference = runCliFailure('migrate', '--from', sourcePath, '--to', destinationPath);

  assert.match(missingFlags.stderr, /migrate requires --from and --to/);
  assert.match(malformed.stderr, /Invalid JSON in .*context\.json/);
  assert.match(invalidReference.stderr, /references missing episode: missing-episode/);
});

test('CLI migrate validates references before creating the SQLite destination', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fuli-cli-migrate-reference-'));
  const sourcePath = join(dir, 'context.json');
  const destinationParent = join(dir, 'missing', 'destination');
  const destinationPath = join(destinationParent, 'context.db');
  writeFileSync(sourcePath, JSON.stringify({
    ...legacySnapshot(),
    facts: [{ ...legacySnapshot().facts[0], sourceEpisodeId: 'missing-episode' }]
  }), 'utf8');

  const result = runCliFailure(
    'migrate', '--from', sourcePath, '--to', destinationPath
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /references missing episode: missing-episode/);
  assert.equal(existsSync(destinationPath), false);
  assert.equal(existsSync(destinationParent), false);
});

test('CLI migrate validates duplicate space names before creating the destination parent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fuli-cli-migrate-names-'));
  const sourcePath = join(dir, 'context.json');
  const destinationParent = join(dir, 'missing', 'destination');
  const destinationPath = join(destinationParent, 'context.db');
  const snapshot = legacySnapshot();
  snapshot.spaces.push({ ...snapshot.spaces[0], id: 'personal-2' });
  writeFileSync(sourcePath, JSON.stringify(snapshot), 'utf8');

  const result = runCliFailure('migrate', '--from', sourcePath, '--to', destinationPath);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Duplicate space name: Jevons/);
  assert.equal(existsSync(destinationPath), false);
  assert.equal(existsSync(destinationParent), false);
});

test('CLI migrate cleans a newly-created destination after an unexpected apply failure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fuli-cli-migrate-cleanup-'));
  const sourcePath = join(dir, 'context.json');
  const destinationParent = join(dir, 'missing', 'destination');
  const destinationPath = join(destinationParent, 'context.db');
  let storePath;
  writeFileSync(sourcePath, JSON.stringify(legacySnapshot()), 'utf8');

  assert.throws(
    () => migrateLegacyJson(['--from', sourcePath, '--to', destinationPath], {
      createStore(path) {
        storePath = path;
        const store = new SqliteStore(path);
        store.importSnapshot = () => { throw new Error('forced apply failure'); };
        return store;
      }
    }),
    /forced apply failure/
  );
  assert.notEqual(storePath, destinationPath);
  assertNoSqliteArtifacts(storePath);
  assert.equal(existsSync(destinationPath), false);
  assert.equal(existsSync(destinationParent), false);
  assert.equal(existsSync(`${destinationPath}-wal`), false);
  assert.equal(existsSync(`${destinationPath}-shm`), false);
  rmSync(dir, { recursive: true, force: true });
});

test('CLI migrate never removes a destination created concurrently before failure cleanup', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fuli-cli-migrate-failure-race-'));
  const sourcePath = join(dir, 'context.json');
  const destinationPath = join(dir, 'context.db');
  const concurrentContent = Buffer.from('owned by another actor');
  let storePath;
  writeFileSync(sourcePath, JSON.stringify(legacySnapshot()), 'utf8');

  assert.throws(
    () => migrateLegacyJson(['--from', sourcePath, '--to', destinationPath], {
      createStore(path) {
        storePath = path;
        writeFileSync(destinationPath, concurrentContent, { flag: 'wx' });
        throw new Error('forced store creation failure');
      }
    }),
    /forced store creation failure/
  );

  assert.notEqual(storePath, destinationPath);
  assert.deepEqual(readFileSync(destinationPath), concurrentContent);
  assertNoSqliteArtifacts(storePath);
});

test('CLI migrate refuses to publish over a destination created concurrently after store close', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fuli-cli-migrate-publish-race-'));
  const sourcePath = join(dir, 'context.json');
  const destinationPath = join(dir, 'context.db');
  const concurrentContent = Buffer.from('concurrent destination');
  let storePath;
  writeFileSync(sourcePath, JSON.stringify(legacySnapshot()), 'utf8');

  assert.throws(
    () => migrateLegacyJson(['--from', sourcePath, '--to', destinationPath], {
      createStore(path) {
        storePath = path;
        const store = new SqliteStore(path);
        const close = store.close.bind(store);
        store.close = () => {
          close();
          writeFileSync(destinationPath, concurrentContent);
        };
        return store;
      }
    }),
    /Migration destination appeared while the import was running/
  );

  assert.notEqual(storePath, destinationPath);
  assert.deepEqual(readFileSync(destinationPath), concurrentContent);
  assertNoSqliteArtifacts(storePath);
});

test('CLI migrate preserves a pre-existing destination after an unexpected apply failure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fuli-cli-migrate-preserve-'));
  const sourcePath = join(dir, 'context.json');
  const destinationPath = join(dir, 'context.db');
  writeFileSync(sourcePath, JSON.stringify(legacySnapshot()), 'utf8');
  const original = new SqliteStore(destinationPath);
  original.close();
  const before = readFileSync(destinationPath);
  let storePath;

  assert.throws(
    () => migrateLegacyJson(['--from', sourcePath, '--to', destinationPath], {
      createStore(path) {
        storePath = path;
        const store = new SqliteStore(path);
        store.importSnapshot = () => { throw new Error('forced apply failure'); };
        return store;
      }
    }),
    /forced apply failure/
  );
  assert.equal(storePath, destinationPath);
  assert.deepEqual(readFileSync(destinationPath), before);
});

function runCliFailure(...args) {
  return spawnSync(NODE, [CLI, ...args], { encoding: 'utf8' });
}

function assertNoSqliteArtifacts(databasePath) {
  assert.equal(existsSync(databasePath), false);
  assert.equal(existsSync(`${databasePath}-wal`), false);
  assert.equal(existsSync(`${databasePath}-shm`), false);
}

function legacySnapshot() {
  return {
    spaces: [{ id: 'personal-1', name: 'Jevons', kind: 'personal', description: null, createdAt: '2026-01-01T00:00:00.000Z' }],
    subscriptions: [],
    episodes: [{ id: 'episode-1', spaceId: 'personal-1', sourceKind: 'chat', body: 'hello', sourceUri: null, metadata: {}, createdAt: '2026-01-01T00:01:00.000Z' }],
    facts: [{ id: 'fact-1', spaceId: 'personal-1', subject: 'Jevons', predicate: 'prefers', object: 'small modules', sourceEpisodeId: 'episode-1', status: 'confirmed', confidence: 1, sensitivity: 'normal', scope: 'personal', validAt: '2026-01-01T00:02:00.000Z', invalidAt: null, replacedByFactId: null }],
    candidates: []
  };
}
