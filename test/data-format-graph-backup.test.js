import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { markUnfinishedImport } from '../src/backup/unfinished-import.js';
import { runGraphDataCommand } from '../src/cli/graph-data-command.js';
import { consoleGraphBackup, runConsoleGraphBackup } from '../src/data-format/console-graph-backup.js';
import { acquireNeo4jLifecycleLock } from '../src/native-runtime/neo4j-lifecycle-lock.js';
import { resolveSetupPaths } from '../src/setup/paths.js';
import { DEFAULT_RUNTIME_SETTINGS, writeRuntimeSettings } from '../src/system/runtime-settings.js';

// The data format page's 「先备份图谱」 and its restore: a detached worker runs
// the same `fuli graph export` / `fuli graph import` a terminal runs, records
// each step, and starts FULI again whatever happened. Synthetic data
// directories; neo4j-admin is a fake adapter and FULI's stop and start are recorded.

const NOW = Date.parse('2026-11-24T08:00:00.000Z');
const NAME = 'before-format-23-2026-11-24T08-00-00-000Z';

function dataDir(t, mode = 'native') {
  const root = mkdtempSync(join(tmpdir(), 'fuli-graph-backup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = resolveSetupPaths({ dataDir: root });
  writeRuntimeSettings(paths.runtimeSettingsPath, { ...DEFAULT_RUNTIME_SETTINGS, graphRuntimeMode: mode });
  for (const dir of [paths.nativePersonalDir, paths.nativeWorkspaceDir]) {
    mkdirSync(join(dir, 'data', 'databases', 'neo4j'), { recursive: true });
    writeFileSync(join(dir, 'data', 'databases', 'neo4j', 'store'), 'x'.repeat(1000));
  }
  return { root, paths };
}

function fakeWorker(spawned) {
  return (command, args) => {
    spawned.push(args);
    return { pid: 4242, once() {}, unref() {} };
  };
}

const port = (root, options = {}) => consoleGraphBackup(root, { now: () => NOW, freeSpace: async () => 10_000_000, platform: 'linux', ...options });

test('a backup goes to backups/graph as before-format-<version>-<time>, after the room for it is checked, and never on a graph FULI could not start again', async (t) => {
  const { root, paths } = dataDir(t);
  const spawned = [];
  const backup = port(root, { spawnWorker: fakeWorker(spawned) });
  const view = await backup.read(23);
  assert.deepEqual([view.latest, view.room, view.job], [null, { bytes: 2000, freeBytes: 10_000_000 }, null], 'the native stores are measured beforehand');

  // Too little room: refused before anything stops.
  await assert.rejects(port(root, { spawnWorker: fakeWorker(spawned), freeSpace: async () => 1500 }).startBackup({ version: 23 }),
    error => error.code === 'graph_backup_no_space' && error.status === 409);
  // A container's volume cannot be measured: the room is said as unknown, and it goes on.
  assert.equal((await port(dataDir(t, 'container').root).read(23)).room.bytes, null);

  const started = await backup.startBackup({ version: 23 });
  assert.deepEqual([started.action, started.status, started.backup.name], ['backup', 'running', NAME]);
  assert.equal(started.backup.path, join(paths.graphBackupDir, NAME));
  assert.equal(spawned.length, 1);
  assert.match(spawned[0][0], /console-graph-backup-worker\.js$/);

  // An unfinished import's marker, or a held lifecycle lock on macOS: FULI could not start again, so nothing stops.
  const marked = dataDir(t);
  markUnfinishedImport(marked.paths, 'native', { restorePoint: { path: null }, graphStates: { personal: 'writing' }, inputDir: null });
  await assert.rejects(port(marked.root).startBackup({ version: 23 }), error => error.code === 'graph_import_unfinished' && error.status === 409);
  const locked = dataDir(t);
  await acquireNeo4jLifecycleLock(locked.paths.nativeRuntimeDir, { operation: 'update', identify: async () => ({ pid: 1, command: 'node', startedAt: 'x' }) });
  await assert.rejects(port(locked.root, { platform: 'darwin' }).startBackup({ version: 23 }), error => error.code === 'graph_lifecycle_locked');
});

// The real `fuli graph export`, with neo4j-admin faked and FULI's stop and start recorded.
function exportCommand(dump) {
  return (action, args, dependencies) => runGraphDataCommand(action, args, { ...dependencies,
    readSettings: () => ({ graphRuntimeMode: 'native' }),
    createAdapter: async () => ({ instances: ['personal', 'workspace'], async stop() { return { resume: false }; }, async start() {}, dump }) });
}

function control(log, { stopped = 'stopped' } = {}) {
  let running = true;
  return {
    consoleRunning: async () => running,
    stop: async () => { log.push('stop'); running = stopped !== 'stopped'; return { status: stopped }; },
    start: async () => { log.push('start'); running = true; }
  };
}

test('the worker exports with FULI stopped, records each step, starts FULI again, and the page then sees the backup', async (t) => {
  const { root, paths } = dataDir(t);
  const backup = port(root, { spawnWorker: fakeWorker([]) });
  const { id } = await backup.startBackup({ version: 23 });
  const log = [];
  const steps = [];
  const journal = join(root, 'format-graph-backup.json');
  await runConsoleGraphBackup(paths, id, { control: control(log), graphData: exportCommand(async (graph, to) => {
    steps.push(JSON.parse(readFileSync(journal, 'utf8')).step);
    writeFileSync(to, `dump:${graph}`);
  }) });
  assert.deepEqual(steps, ['exporting', 'exporting']);
  assert.deepEqual(log, ['stop', 'start']);
  const done = backup.status();
  assert.deepEqual([done.status, done.started, done.error], ['done', true, null]);
  assert.ok(existsSync(join(paths.graphBackupDir, NAME, 'manifest.json')));
  const view = await backup.read(23);
  assert.deepEqual([view.latest.name, view.latest.createdAt], [NAME, '2026-11-24T08:00:00.000Z']);
  assert.ok(view.latest.bytes > 0);
  assert.equal((await backup.read(22)).latest, null, 'a backup belongs to the step it was taken for');
});

test('a failed export says why on one line and FULI starts again, also when it could not be stopped cleanly', async (t) => {
  const { root, paths } = dataDir(t);
  const backup = port(root, { spawnWorker: fakeWorker([]) });
  const { id } = await backup.startBackup({ version: 23 });
  const log = [];
  await runConsoleGraphBackup(paths, id, { control: control(log), graphData: exportCommand(async () => {
    throw new Error('No space left on device\nneo4j-admin output');
  }) });
  const failed = backup.status();
  assert.deepEqual([failed.status, failed.error, failed.started], ['failed', 'No space left on device', true]);
  assert.deepEqual(log, ['stop', 'start']);
  assert.equal((await backup.read(23)).latest, null, 'a half-written export is never listed');

  // The stop could not be confirmed: the export never ran, and FULI is started again all the same.
  const again = await backup.startBackup({ version: 23 });
  const partial = [];
  await runConsoleGraphBackup(paths, again.id, { control: control(partial, { stopped: 'partial' }), graphData: exportCommand(async () => assert.fail('nothing is dumped')) });
  assert.deepEqual([backup.status().status, partial], ['failed', ['stop']], 'FULI still ran, so it is not started twice');
});

test('a restore takes only a backup this page lists, runs the same import, and a backup folder is shown on request', async (t) => {
  const { root, paths } = dataDir(t);
  const folder = join(paths.graphBackupDir, NAME);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'manifest.json'), JSON.stringify({ format: 'fuli-neo4j-backup', version: 1, createdAt: '2026-11-24T08:00:00.000Z',
    sourceMode: 'native', instances: [{ id: 'personal', file: 'personal.dump', sha256: 'a'.repeat(64) }] }));
  const revealed = [];
  const backup = port(root, { spawnWorker: fakeWorker([]), reveal: async path => { revealed.push(path); return { revealed: true }; } });
  await assert.rejects(backup.startRestore({ version: 23, name: 'before-import-2026-11-24T08-00-00-000Z-a' }), error => error.code === 'graph_backup_unknown');
  await assert.rejects(backup.startRestore({ version: 23, name: '../elsewhere' }), error => error.code === 'graph_backup_unknown');
  await backup.reveal({ version: 23, name: NAME });
  assert.deepEqual(revealed, [folder]);

  const { id, action } = await backup.startRestore({ version: 23, name: NAME });
  assert.equal(action, 'restore');
  const run = [];
  await runConsoleGraphBackup(paths, id, { control: control([]), graphData: async (command, args, dependencies) => {
    run.push([command, args]);
    assert.equal(typeof dependencies.importData, 'function', 'the import step is recorded as it starts');
    await dependencies.runtime.stop();
    await dependencies.runtime.start();
  } });
  assert.deepEqual(run, [['import', ['--input', folder, '--data-dir', root, '--yes']]]);
  assert.equal(backup.status().status, 'done');
});
