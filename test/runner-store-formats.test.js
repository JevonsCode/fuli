import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { openFormattedDatabase, sqliteFormat } from '../packages/roundtable/src/storage/database-format.js';
import { RUNNER_HOST_FORMAT, RunnerHostStore } from '../src/runner/host-store.js';
import { RUNNER_FORMAT, RunnerStore } from '../src/runner/runner-store.js';

// Both runner stores exactly as 0.29.0-beta.1 declared them (version 1, from
// bb663e3e): every beta.1 host made runner/host.sqlite at console start, and a
// paired runner has runner/runner.sqlite. An upgrade keeps their records.
const BETA1_HOST = sqliteFormat({ store: 'runner-host', schema: `
    CREATE TABLE IF NOT EXISTS runners(
      fingerprint TEXT PRIMARY KEY, name TEXT NOT NULL, paired_at TEXT NOT NULL,
      last_seen_at TEXT, last_address TEXT, revoked_at TEXT);
    CREATE TABLE IF NOT EXISTS invitations(
      code_hash TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
      used_by TEXT);
    CREATE TABLE IF NOT EXISTS replays(
      id TEXT PRIMARY KEY, runner TEXT NOT NULL, tool TEXT NOT NULL, at TEXT NOT NULL, result TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS replays_at ON replays(at);` });
const BETA1_RUNNER = sqliteFormat({ store: 'runner', schema: `
    CREATE TABLE IF NOT EXISTS host(
      id INTEGER PRIMARY KEY CHECK(id = 1), name TEXT NOT NULL, fingerprint TEXT NOT NULL, cert_pem TEXT NOT NULL,
      port INTEGER NOT NULL, addresses TEXT NOT NULL, last_address TEXT, paired_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS answers(
      key TEXT PRIMARY KEY, tool TEXT NOT NULL, at TEXT NOT NULL, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS offline_tasks(
      token TEXT PRIMARY KEY, project_path TEXT, source_application TEXT NOT NULL, started_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS outbox(
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, tool TEXT NOT NULL, input TEXT NOT NULL,
      source_application TEXT NOT NULL, session_id TEXT, offline_project_path TEXT, queued_at TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('queued', 'delivered', 'failed')), attempts INTEGER NOT NULL DEFAULT 0,
      claimed_until TEXT, last_error TEXT, settled_at TEXT);` });

function directory(t) {
  const path = mkdtempSync(join(tmpdir(), 'fuli-runner-formats-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

// A store beta.1 made, with its records, closed as beta.1 left it.
function beta1Store(path, format, records) {
  const database = openFormattedDatabase(path, format);
  try { database.exec(records); } finally { database.close(); }
}

test('upgrading a runner removes only cached host diagnostics and never returns or stores them again', (t) => {
  const path = join(directory(t), 'runner.sqlite');
  const old = openFormattedDatabase(path, BETA1_RUNNER);
  const insert = 'INSERT INTO answers(key, tool, at, body) VALUES(?, ?, ?, ?)';
  const at = new Date().toISOString();
  old.prepare(insert).run('sensitive', 'read_diagnostic_events', at, '{"total":3}');
  old.prepare(insert).run('ordinary', 'search_current_project_knowledge', at, '{"total":1}');
  old.close();
  const upgraded = new RunnerStore(path);
  try {
    assert.equal(upgraded.answer('sensitive'), null);
    assert.deepEqual(upgraded.answer('ordinary')?.body, { total: 1 });
    upgraded.rememberAnswer('new', 'read_diagnostic_events', { total: 5 });
    assert.equal(upgraded.db.prepare('SELECT count(*) AS n FROM answers').get().n, 1);
    upgraded.db.prepare(insert).run('concurrent-old-client', 'read_diagnostic_events', at, '{"total":2}');
    assert.equal(upgraded.answer('concurrent-old-client'), null);
  } finally {
    upgraded.close();
  }
});

// Layout of the CREATE text does not matter, its content does (data-format-inventory.test.js).
const statement = (sql) => String(sql ?? '').replace(/\s+/g, ' ').replace(/\s*([(),])\s*/g, '$1').trim();

// The schema SQLite holds, without the ledger the engine owns, as the inventory test compares it.
function schema(path) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return database.prepare(`SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'
      AND tbl_name <> 'fuli_format_ledger' ORDER BY type, name`).all()
      .map((row) => [row.type, row.name, statement(row.sql)]);
  } finally { database.close(); }
}

function freshSchema(t, Store) {
  const path = join(directory(t), 'fresh.sqlite');
  const store = new Store(path);
  void store.db;
  store.close();
  return schema(path);
}

function version(path) {
  const database = new DatabaseSync(path, { readOnly: true });
  try { return database.prepare('PRAGMA user_version').get().user_version; } finally { database.close(); }
}

test('a beta.1 host store reaches the current version with its runners and invitations; beta.1 replays are not kept', (t) => {
  const path = join(directory(t), 'host.sqlite');
  beta1Store(path, BETA1_HOST, `
    INSERT INTO runners VALUES('${'a'.repeat(64)}', 'Office laptop', '2026-11-17T10:00:00.000Z', '2026-11-17T11:00:00.000Z', '192.168.1.30', NULL);
    INSERT INTO runners VALUES('${'b'.repeat(64)}', 'Old laptop', '2026-11-16T10:00:00.000Z', NULL, NULL, '2026-11-17T09:00:00.000Z');
    INSERT INTO invitations VALUES('synthetic-hash', 'Office laptop', '2026-11-17T09:55:00.000Z', '2026-11-17T10:05:00.000Z', '${'a'.repeat(64)}');
    INSERT INTO replays VALUES('entry-1', '${'a'.repeat(64)}', 'checkpoint_task_knowledge', '2026-11-17T10:30:00.000Z', '{"result":{}}');`);
  assert.equal(version(path), 1);

  const store = new RunnerHostStore(path, { now: () => Date.parse('2026-11-18T00:00:00Z') });
  t.after(() => store.close());
  assert.deepEqual(store.runners().map(({ fingerprint, name, deviceName, lastAddress, revokedAt }) =>
    [fingerprint.slice(0, 1), name, deviceName, lastAddress, revokedAt]), [
    ['b', 'Old laptop', null, null, '2026-11-17T09:00:00.000Z'],
    ['a', 'Office laptop', null, '192.168.1.30', null]]);
  assert.equal(store.isPaired('a'.repeat(64)), true);
  assert.equal(store.db.prepare('SELECT used_by FROM invitations').get().used_by, 'a'.repeat(64));
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM replays').get().count, 0);
  assert.equal(store.claimReplay({ runner: 'a'.repeat(64), id: 'entry-1', tool: 'checkpoint_task_knowledge' }).state, 'claimed');
  store.close();
  assert.equal(version(path), RUNNER_HOST_FORMAT.version);
  assert.deepEqual(schema(path), freshSchema(t, RunnerHostStore), 'the upgraded store has exactly a fresh store schema');
});

test('a beta.1 runner store reaches the current version with its pairing, answers and outbox', (t) => {
  const path = join(directory(t), 'runner.sqlite');
  beta1Store(path, BETA1_RUNNER, `
    INSERT INTO host VALUES(1, 'Host A', '${'f'.repeat(64)}', 'synthetic-pem', 2730, '["192.168.1.20"]', '192.168.1.20', '2026-11-17T10:00:00.000Z');
    INSERT INTO answers VALUES('read:search:1', 'search_knowledge_graph', '2026-11-17T10:10:00.000Z', '{"content":[]}');
    INSERT INTO outbox(id, tool, input, source_application, queued_at, state)
      VALUES('queued-1', 'checkpoint_task_knowledge', '{}', 'codex', '2026-11-17T10:20:00.000Z', 'queued');`);
  assert.equal(version(path), 1);

  const store = new RunnerStore(path, { now: () => Date.parse('2026-11-18T00:00:00Z') });
  t.after(() => store.close());
  const host = store.host();
  assert.deepEqual([host.name, host.fingerprint, host.addresses, host.revokedAt], ['Host A', 'f'.repeat(64), ['192.168.1.20'], null]);
  assert.equal(store.answer('read:search:1').at, '2026-11-17T10:10:00.000Z');
  assert.equal(store.claimNext().id, 'queued-1');
  store.close();
  assert.equal(version(path), RUNNER_FORMAT.version);
  assert.deepEqual(schema(path), freshSchema(t, RunnerStore), 'the upgraded store has exactly a fresh store schema');
});

test('the schema comparison above sees a store that differs from a fresh one', (t) => {
  const path = join(directory(t), 'different.sqlite');
  const store = new RunnerHostStore(path);
  void store.db;
  store.close();
  assert.deepEqual(schema(path), freshSchema(t, RunnerHostStore));
  const database = new DatabaseSync(path);
  try { database.exec('ALTER TABLE runners ADD COLUMN synthetic_extra TEXT'); } finally { database.close(); }
  assert.notDeepEqual(schema(path), freshSchema(t, RunnerHostStore));
  // Layout alone is not a difference.
  assert.equal(statement('CREATE TABLE a( x TEXT ,\n y TEXT )'), statement('CREATE TABLE a(x TEXT,y TEXT)'));
});
