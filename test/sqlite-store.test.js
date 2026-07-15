import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { CandidateStatus, SpaceKind } from '../src/models.js';
import { configureDatabase, runMigrations } from '../src/storage/migrate.js';
import { SqliteStore } from '../src/storage/sqlite-store.js';
import { runStoreContract } from './store-contract.js';

const ORIGINAL_001_CHECKSUM = 'ab393d736d8ff18fde75478002b2b4b3b4d7e906974cd724058e31436fba0ea9';
const STORAGE_INTEGRITY_CHECKSUM = checksumForMigration('002-storage-integrity.sql');

runStoreContract('SqliteStore', () => new SqliteStore(':memory:'));

test('default SqliteStore creates its database parent in a clean child-process CWD', (t) => {
  const dir = temporaryDirectory('fuli-default-db-');
  const originalCwd = process.cwd();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const moduleUrl = new URL('../src/storage/sqlite-store.js', import.meta.url).href;
  const child = spawnSync(process.execPath, [
    '--input-type=module',
    '--eval',
    `import { SqliteStore } from ${JSON.stringify(moduleUrl)};
     const store = new SqliteStore();
     store.close();`
  ], {
    cwd: dir,
    encoding: 'utf8'
  });

  assert.equal(child.status, 0, child.stderr);
  assert.equal(existsSync(join(dir, '.fuli', 'context.db')), true);
  assert.equal(process.cwd(), originalCwd);
});

test('SqliteStore migrates and persists every record type across reopen', (t) => {
  const dir = temporaryDirectory('fuli-sqlite-');
  const databasePath = join(dir, 'context.db');
  const first = new SqliteStore(databasePath);
  let second;
  t.after(() => {
    first.close();
    second?.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const personal = first.createSpace('Personal', SpaceKind.PERSONAL);
  const project = first.createSpace('Project A', SpaceKind.PUBLIC);
  first.subscribe(personal.id, project.id, 'preview');
  const episode = first.addEpisode(
    project.id,
    'prd',
    'runtime: node',
    'file://prd.md',
    { parser: 'fixture' }
  );
  first.addFact({
    spaceId: project.id,
    subject: 'Project A',
    predicate: 'has_runtime',
    object: 'node',
    sourceEpisodeId: episode.id,
    confidence: 0.8,
    sensitivity: 'private',
    scope: 'public'
  });
  const candidate = first.addCandidate({
    personalSpaceId: personal.id,
    targetSpaceId: project.id,
    episodeId: episode.id,
    reason: 'needs review'
  });
  first.updateCandidateStatus(candidate.id, CandidateStatus.PERSONAL_ONLY);
  first.markOutboxFailed(first.enqueueOutbox({
    kind: 'publication',
    aggregateId: project.id,
    payload: { nested: { value: 1 } }
  }).id, 'offline', '2026-07-10T00:05:00.000Z');
  first.recordImport({
    contentHash: 'persisted-hash',
    sourcePath: 'legacy.json',
    importedAt: '2026-07-10T00:00:00.000Z'
  });
  const expected = first.exportSnapshot();
  assert.deepEqual(first.schemaVersions(), [1, 2]);
  first.close();

  second = new SqliteStore(databasePath);

  assert.deepEqual(second.schemaVersions(), [1, 2]);
  assert.deepEqual(second.exportSnapshot(), expected);
});

test('001 migration remains byte-for-byte immutable', () => {
  const bytes = readFileSync(new URL('../src/storage/migrations/001-initial.sql', import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), ORIGINAL_001_CHECKSUM);
});

test('SqliteStore upgrades a populated v1 database without losing data', (t) => {
  const dir = temporaryDirectory('fuli-v1-upgrade-');
  const databasePath = join(dir, 'context.db');
  const appliedAt = '2026-07-10T00:00:00.000Z';
  let first;
  let raw;
  let reopened;
  t.after(() => {
    first?.close();
    if (raw?.open) raw.close();
    reopened?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const initialBytes = readFileSync(
    new URL('../src/storage/migrations/001-initial.sql', import.meta.url)
  );
  assert.equal(createHash('sha256').update(initialBytes).digest('hex'), ORIGINAL_001_CHECKSUM);
  const legacy = new Database(databasePath);
  legacy.pragma('foreign_keys = ON');
  legacy.exec(initialBytes.toString('utf8'));
  legacy.prepare(`
    INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)
  `).run(appliedAt);
  legacy.exec(`
    INSERT INTO spaces (id, name, kind, description, created_at) VALUES
      ('personal-1', 'Personal', 'personal', NULL, '${appliedAt}'),
      ('project-1', 'Project A', 'public', 'Legacy project', '${appliedAt}');
    INSERT INTO subscriptions (personal_space_id, space_id, mode, created_at)
      VALUES ('personal-1', 'project-1', 'preview', '${appliedAt}');
    INSERT INTO episodes (
      id, space_id, source_kind, body, source_uri, metadata_json, created_at
    ) VALUES (
      'episode-1', 'project-1', 'prd', 'runtime: node', 'file://legacy.md',
      '{"source":"legacy"}', '${appliedAt}'
    );
    INSERT INTO facts (
      id, space_id, subject, predicate, object, source_episode_id, status,
      confidence, sensitivity, scope, valid_at, invalid_at, replaced_by_fact_id
    ) VALUES (
      'fact-new', 'project-1', 'Project A', 'has_runtime', 'node-24', 'episode-1',
      'confirmed', 0.8, 'private', 'public', '2026-07-10T00:01:00.000Z', NULL, NULL
    );
    INSERT INTO facts (
      id, space_id, subject, predicate, object, source_episode_id, status,
      confidence, sensitivity, scope, valid_at, invalid_at, replaced_by_fact_id
    ) VALUES (
      'fact-old', 'project-1', 'Project A', 'has_runtime', 'node-22', 'episode-1',
      'deprecated', 1.0, 'normal', 'public', '${appliedAt}',
      '2026-07-10T00:01:00.000Z', 'fact-new'
    );
    INSERT INTO candidates (
      id, personal_space_id, target_space_id, episode_id, reason,
      status, created_at, decided_at
    ) VALUES (
      'candidate-1', 'personal-1', 'project-1', 'episode-1', 'legacy review',
      'ignored', '${appliedAt}', '2026-07-10T00:02:00.000Z'
    );
    INSERT INTO outbox (
      id, kind, aggregate_id, payload_json, status, attempts,
      next_attempt_at, created_at, sent_at, last_error
    ) VALUES (
      'outbox-1', 'publication', 'project-1', '{"legacy":true}', 'pending', 2,
      '2026-07-10T00:03:00.000Z', '${appliedAt}', NULL, 'offline'
    );
    INSERT INTO imports (content_hash, source_path, imported_at)
      VALUES ('legacy-hash', 'legacy.json', '${appliedAt}');
  `);
  legacy.close();

  first = new SqliteStore(databasePath);
  assert.deepEqual(first.schemaVersions(), [1, 2]);
  const upgradedSnapshot = first.exportSnapshot();
  assert.deepEqual(upgradedSnapshot, {
    spaces: [
      {
        id: 'personal-1',
        name: 'Personal',
        kind: SpaceKind.PERSONAL,
        description: null,
        createdAt: appliedAt
      },
      {
        id: 'project-1',
        name: 'Project A',
        kind: SpaceKind.PUBLIC,
        description: 'Legacy project',
        createdAt: appliedAt
      }
    ],
    subscriptions: [{
      personalSpaceId: 'personal-1',
      spaceId: 'project-1',
      mode: 'preview',
      createdAt: appliedAt
    }],
    episodes: [{
      id: 'episode-1',
      spaceId: 'project-1',
      sourceKind: 'prd',
      body: 'runtime: node',
      sourceUri: 'file://legacy.md',
      metadata: { source: 'legacy' },
      createdAt: appliedAt
    }],
    facts: [
      {
        id: 'fact-new',
        spaceId: 'project-1',
        subject: 'Project A',
        predicate: 'has_runtime',
        object: 'node-24',
        sourceEpisodeId: 'episode-1',
        status: 'confirmed',
        confidence: 0.8,
        sensitivity: 'private',
        scope: 'public',
        validAt: '2026-07-10T00:01:00.000Z',
        invalidAt: null,
        replacedByFactId: null
      },
      {
        id: 'fact-old',
        spaceId: 'project-1',
        subject: 'Project A',
        predicate: 'has_runtime',
        object: 'node-22',
        sourceEpisodeId: 'episode-1',
        status: 'deprecated',
        confidence: 1,
        sensitivity: 'normal',
        scope: 'public',
        validAt: appliedAt,
        invalidAt: '2026-07-10T00:01:00.000Z',
        replacedByFactId: 'fact-new'
      }
    ],
    candidates: [{
      id: 'candidate-1',
      personalSpaceId: 'personal-1',
      targetSpaceId: 'project-1',
      episodeId: 'episode-1',
      reason: 'legacy review',
      status: CandidateStatus.IGNORED,
      createdAt: appliedAt,
      decidedAt: '2026-07-10T00:02:00.000Z'
    }],
    outbox: [{
      id: 'outbox-1',
      kind: 'publication',
      aggregateId: 'project-1',
      payload: { legacy: true },
      status: 'pending',
      attempts: 2,
      nextAttemptAt: '2026-07-10T00:03:00.000Z',
      createdAt: appliedAt,
      sentAt: null,
      lastError: 'offline'
    }],
    imports: [{
      contentHash: 'legacy-hash',
      sourcePath: 'legacy.json',
      importedAt: appliedAt
    }]
  });
  first.close();

  raw = new Database(databasePath);
  raw.pragma('foreign_keys = ON');
  const migrationRows = raw.prepare(`
    SELECT version, checksum, applied_at AS appliedAt
    FROM schema_migrations ORDER BY version
  `).all();
  assert.deepEqual(
    migrationRows.map((row) => row.checksum),
    [ORIGINAL_001_CHECKSUM, STORAGE_INTEGRITY_CHECKSUM]
  );
  assert.equal(migrationRows[0].appliedAt, appliedAt);
  assert.deepEqual(
    raw.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name IN (
        'facts_current_idx', 'facts_source_idx', 'outbox_pending_idx'
      ) ORDER BY name
    `).pluck().all(),
    ['facts_current_idx', 'facts_source_idx', 'outbox_pending_idx']
  );
  assert.throws(
    () => raw.prepare("UPDATE facts SET confidence = 2 WHERE id = 'fact-new'").run(),
    /CHECK constraint failed/i
  );
  assert.throws(
    () => raw.prepare("UPDATE candidates SET status = 'approved' WHERE id = 'candidate-1'").run(),
    /CHECK constraint failed/i
  );
  assert.throws(
    () => raw.prepare("UPDATE outbox SET attempts = -1 WHERE id = 'outbox-1'").run(),
    /CHECK constraint failed/i
  );
  raw.close();

  reopened = new SqliteStore(databasePath);
  assert.deepEqual(reopened.schemaVersions(), [1, 2]);
  assert.deepEqual(reopened.exportSnapshot(), upgradedSnapshot);
});

test('database configuration enables safety pragmas and WAL only for files', (t) => {
  const dir = temporaryDirectory('fuli-sqlite-config-');
  const fileDatabase = new Database(join(dir, 'configured.db'));
  const memoryDatabase = new Database(':memory:');
  t.after(() => {
    fileDatabase.close();
    memoryDatabase.close();
    rmSync(dir, { recursive: true, force: true });
  });

  configureDatabase(fileDatabase, join(dir, 'configured.db'));
  configureDatabase(memoryDatabase, ':memory:');

  assert.equal(fileDatabase.pragma('foreign_keys', { simple: true }), 1);
  assert.equal(fileDatabase.pragma('busy_timeout', { simple: true }), 5000);
  assert.equal(fileDatabase.pragma('journal_mode', { simple: true }), 'wal');
  assert.equal(memoryDatabase.pragma('foreign_keys', { simple: true }), 1);
  assert.equal(memoryDatabase.pragma('busy_timeout', { simple: true }), 5000);
  assert.notEqual(memoryDatabase.pragma('journal_mode', { simple: true }), 'wal');
});

test('SQLite CHECK constraints reject invalid persisted record values', (t) => {
  const database = new Database(':memory:');
  t.after(() => database.close());
  configureDatabase(database, ':memory:');
  runMigrations(database);
  database.exec(`
    INSERT INTO spaces (id, name, kind, description, created_at)
    VALUES
      ('personal-1', 'Personal', 'personal', NULL, '2026-07-10T00:00:00.000Z'),
      ('project-1', 'Project A', 'public', NULL, '2026-07-10T00:00:00.000Z');
    INSERT INTO episodes (
      id, space_id, source_kind, body, source_uri, metadata_json, created_at
    ) VALUES (
      'episode-1', 'project-1', 'prd', 'runtime: node', NULL, '{}',
      '2026-07-10T00:00:00.000Z'
    );
  `);
  const insertFact = database.prepare(`
    INSERT INTO facts (
      id, space_id, subject, predicate, object, source_episode_id, status,
      confidence, sensitivity, scope, valid_at
    ) VALUES (?, 'project-1', 'Project A', 'has_runtime', 'node', 'episode-1',
      ?, ?, ?, ?, '2026-07-10T00:00:00.000Z')
  `);
  const insertCandidate = database.prepare(`
    INSERT INTO candidates (
      id, personal_space_id, target_space_id, episode_id, reason, status, created_at
    ) VALUES (
      ?, 'personal-1', 'project-1', 'episode-1', 'review', ?,
      '2026-07-10T00:00:00.000Z'
    )
  `);
  const insertOutbox = database.prepare(`
    INSERT INTO outbox (
      id, kind, aggregate_id, payload_json, status, attempts, created_at
    ) VALUES (?, 'publication', 'project-1', '{}', ?, ?, '2026-07-10T00:00:00.000Z')
  `);

  assert.throws(() => insertFact.run('fact-status', 'invented', 1, 'normal', 'personal'), /CHECK constraint failed/i);
  assert.throws(() => insertFact.run('fact-low', 'confirmed', -0.1, 'normal', 'personal'), /CHECK constraint failed/i);
  assert.throws(() => insertFact.run('fact-high', 'confirmed', 1.1, 'normal', 'personal'), /CHECK constraint failed/i);
  assert.throws(() => insertFact.run('fact-sensitivity', 'confirmed', 1, 'secret', 'personal'), /CHECK constraint failed/i);
  assert.throws(() => insertFact.run('fact-scope', 'confirmed', 1, 'normal', 'team'), /CHECK constraint failed/i);
  assert.throws(() => insertCandidate.run('candidate-status', 'approved'), /CHECK constraint failed/i);
  assert.throws(() => insertOutbox.run('outbox-status', 'failed', 0), /CHECK constraint failed/i);
  assert.throws(() => insertOutbox.run('outbox-negative', 'pending', -1), /CHECK constraint failed/i);
  assert.throws(() => insertOutbox.run('outbox-fraction', 'pending', 1.5), /CHECK constraint failed/i);

  assert.equal(database.prepare('SELECT count(*) FROM facts').pluck().get(), 0);
  assert.equal(database.prepare('SELECT count(*) FROM candidates').pluck().get(), 0);
  assert.equal(database.prepare('SELECT count(*) FROM outbox').pluck().get(), 0);
});

test('ordered migrations commit SQL and version records atomically and never reapply', (t) => {
  const dir = temporaryDirectory('fuli-migrations-#-');
  const database = new Database(':memory:');
  t.after(() => {
    database.close();
    rmSync(dir, { recursive: true, force: true });
  });
  writeFileSync(join(dir, '001-first.sql'), `
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      checksum TEXT NOT NULL DEFAULT '',
      applied_at TEXT NOT NULL
    );
    CREATE TABLE migration_probe (value TEXT PRIMARY KEY);
    INSERT INTO migration_probe (value) VALUES ('first');
  `);
  writeFileSync(join(dir, '002-second.sql'), `
    INSERT INTO migration_probe (value) VALUES ('rolled-back');
    SELECT definitely_not_a_column;
  `);

  assert.throws(
    () => runMigrations(database, { migrationsDirectory: dir }),
    /definitely_not_a_column|no such column/i
  );
  assert.deepEqual(
    database.prepare('SELECT value FROM migration_probe ORDER BY value').pluck().all(),
    ['first']
  );
  assert.deepEqual(
    database.prepare('SELECT version FROM schema_migrations ORDER BY version').pluck().all(),
    [1]
  );

  writeFileSync(join(dir, '002-second.sql'), `
    INSERT INTO migration_probe (value) VALUES ('second');
  `);
  runMigrations(database, { migrationsDirectory: dir });
  runMigrations(database, { migrationsDirectory: dir });

  assert.deepEqual(
    database.prepare('SELECT value FROM migration_probe ORDER BY value').pluck().all(),
    ['first', 'second']
  );
  assert.deepEqual(
    database.prepare('SELECT version FROM schema_migrations ORDER BY version').pluck().all(),
    [1, 2]
  );
  assert.deepEqual(
    database.prepare(`
      SELECT length(checksum) FROM schema_migrations ORDER BY version
    `).pluck().all(),
    [64, 64]
  );
});

test('migrations reject edits to previously applied SQL', (t) => {
  const dir = temporaryDirectory('fuli-migration-checksum-');
  const database = new Database(':memory:');
  t.after(() => {
    database.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const migrationPath = join(dir, '001-initial.sql');
  writeFileSync(migrationPath, `
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      checksum TEXT NOT NULL DEFAULT '',
      applied_at TEXT NOT NULL
    );
    CREATE TABLE immutable_probe (value TEXT PRIMARY KEY);
  `);
  runMigrations(database, { migrationsDirectory: dir });

  writeFileSync(migrationPath, `
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      checksum TEXT NOT NULL DEFAULT '',
      applied_at TEXT NOT NULL
    );
    CREATE TABLE immutable_probe (value TEXT PRIMARY KEY);
    -- edited after application
  `);

  assert.throws(
    () => runMigrations(database, { migrationsDirectory: dir }),
    /Migration checksum mismatch for version 1/
  );
});

test('migrations reject applied versions missing from the directory', (t) => {
  const dir = temporaryDirectory('fuli-migration-missing-');
  const database = new Database(':memory:');
  t.after(() => {
    database.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const migrationPath = join(dir, '001-initial.sql');
  writeFileSync(migrationPath, `
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      checksum TEXT NOT NULL DEFAULT '',
      applied_at TEXT NOT NULL
    );
    CREATE TABLE missing_probe (value TEXT PRIMARY KEY);
  `);
  runMigrations(database, { migrationsDirectory: dir });
  rmSync(migrationPath);

  assert.throws(
    () => runMigrations(database, { migrationsDirectory: dir }),
    /Applied migration version 1 is missing from the migration directory/
  );
});

test('src/store.js retains the SqliteStore compatibility export', async () => {
  const compatibility = await import('../src/store.js');
  assert.equal(compatibility.SqliteStore, SqliteStore);
});

function temporaryDirectory(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function checksumForMigration(name) {
  const bytes = readFileSync(new URL(`../src/storage/migrations/${name}`, import.meta.url));
  return createHash('sha256').update(bytes).digest('hex');
}
