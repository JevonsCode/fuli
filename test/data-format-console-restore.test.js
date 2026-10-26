import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { runMigrateCommand } from '../src/cli/migrate-command.js';
import { consoleRestore, runConsoleRestore } from '../src/data-format/console-restore.js';
import { acquireMaintenance, holdDataDirectory } from '../src/data-format/maintenance-lock.js';
import { readFormatOperations } from '../src/data-format/operations-log.js';

// The console's whole-store restore: the person confirms what a backup
// discards, and a detached worker stops FULI, restores under the exclusive
// maintenance lock and starts FULI again. Synthetic stores only.

const STORE = 'task-schedules.sqlite';
const noGraph = { preview: async () => ({ plan: null, undoable: [] }),
  prune: async () => { throw Object.assign(new Error('no graph here'), { code: 'ENOENT' }); } };

async function dataDirWithBackup(t) {
  const root = mkdtempSync(join(tmpdir(), 'fuli-console-restore-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const database = new DatabaseSync(join(root, STORE));
  database.exec(`CREATE TABLE task_schedules(id TEXT PRIMARY KEY, space TEXT NOT NULL, project TEXT NOT NULL,
      revision INTEGER NOT NULL, enabled INTEGER NOT NULL, body TEXT NOT NULL, next_run_at TEXT NOT NULL,
      paused_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE task_schedule_runs(schedule TEXT NOT NULL, slot TEXT NOT NULL, task_id TEXT, status TEXT NOT NULL,
      created_at TEXT NOT NULL, PRIMARY KEY(schedule, slot));
    INSERT INTO task_schedule_runs VALUES('s1', 'synthetic-slot', NULL, 'claimed', '2026-01-01T00:00:00Z');`);
  database.close();
  const run = (args) => runMigrateCommand([...args, '--data-dir', root], { env: {}, interactive: true, graph: noGraph,
    write: () => {}, confirm: async () => true });
  const { plan } = await run(['preview', '--json']);
  const applied = await run(['apply', '--digest', plan.digest]);
  return { root, backupRef: applied.results.find((result) => result.label === STORE).backupRef };
}

function fakeWorker(spawned) {
  return (command, args, options) => {
    spawned.push({ command, args, options });
    return { pid: 4242, once() {}, unref() {} };
  };
}

test('the console lists backups, says what one discards and starts a detached restore of exactly that', async (t) => {
  const { root, backupRef } = await dataDirWithBackup(t);
  const spawned = [];
  const restore = consoleRestore(root, { spawnWorker: fakeWorker(spawned) });

  const choice = restore.choices().find((store) => store.label === STORE);
  assert.ok(choice.backups.some((backup) => backup.ref === backupRef));
  const impact = restore.describe(STORE, backupRef);
  assert.equal(impact.backupRef, backupRef);
  assert.ok(impact.tables.length);

  assert.throws(() => restore.start({ label: STORE, backupRef, currentDigest: 'not-what-was-shown' }),
    (error) => error.code === 'data_format_stale_preview' && error.status === 409);
  assert.deepEqual(spawned, []);
  assert.throws(() => restore.describe('graph (personal)', 'x'), (error) => error instanceof TypeError
    && !/fuli [a-z]/.test(error.message));

  const started = restore.start({ label: STORE, backupRef, currentDigest: impact.currentDigest });
  assert.equal(started.status, 'stopping');
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].command, process.execPath);
  assert.match(spawned[0].args[0], /console-restore-worker\.js$/);
  assert.deepEqual(spawned[0].args.slice(1), [root, started.id]);
  assert.equal(spawned[0].options.detached, true);
  assert.throws(() => restore.start({ label: STORE, backupRef, currentDigest: impact.currentDigest }),
    /already running/);
});

test('the worker stops FULI, restores under the exclusive lock and starts FULI again', async (t) => {
  const { root, backupRef } = await dataDirWithBackup(t);
  const restore = consoleRestore(root, { spawnWorker: fakeWorker([]) });
  const { id } = restore.start({ label: STORE, backupRef, currentDigest: restore.describe(STORE, backupRef).currentDigest });
  const events = [];
  const control = { stop: async () => { events.push('stop'); return { status: 'stopped' }; },
    consoleRunning: async () => { events.push('running?'); return false; },
    start: async () => { events.push('start'); } };
  const acquire = (dataDir) => {
    events.push('acquire');
    const release = acquireMaintenance(dataDir);
    // A console cannot start meanwhile: the lock is held exclusively.
    assert.throws(() => holdDataDirectory(dataDir), (error) => error.code === 'data_format_maintenance'
      && !/fuli [a-z]/.test(error.message));
    return () => { release(); events.push('released'); };
  };
  await runConsoleRestore({ dataDir: root }, id, { control, acquire });

  assert.deepEqual(events, ['stop', 'acquire', 'running?', 'released', 'start']);
  const status = restore.status();
  assert.equal(status.status, 'restored');
  assert.equal(status.started, true);
  assert.match(status.safetyBackupRef, /^format-backups\//);
  assert.equal(readFormatOperations(root).at(-1).kind, 'restored');
  assert.equal(readFormatOperations(root).at(-1).entrypoint, 'http');
});

test('a FULI that cannot be stopped safely is not restored, and FULI is started again', async (t) => {
  const { root, backupRef } = await dataDirWithBackup(t);
  const before = readFileSync(join(root, STORE));
  const restore = consoleRestore(root, { spawnWorker: fakeWorker([]) });
  const { id } = restore.start({ label: STORE, backupRef, currentDigest: restore.describe(STORE, backupRef).currentDigest });
  const events = [];
  await runConsoleRestore({ dataDir: root }, id, {
    control: { stop: async () => ({ status: 'partial' }), consoleRunning: async () => true,
      start: async () => { events.push('start'); } },
    acquire: () => assert.fail('no lock without a stopped FULI'),
    restore: () => assert.fail('nothing is restored') });
  assert.deepEqual(events, ['start']);
  const status = restore.status();
  assert.equal(status.status, 'failed');
  assert.match(status.error, /could not be stopped safely/);
  assert.deepEqual(readFileSync(join(root, STORE)), before);
});

test('a restore whose worker vanished without an outcome reads as interrupted', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fuli-console-restore-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'format-restore.json'), JSON.stringify({ id: 'synthetic', status: 'restoring',
    label: STORE, backupRef: 'format-backups/x', startedAt: 0, workerPid: 2 ** 31 - 2 }));
  const status = consoleRestore(root, { now: () => 60_000 }).status();
  assert.equal(status.status, 'failed');
  assert.match(status.error, /interrupted/);
});
