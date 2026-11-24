import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { markUnfinishedImport } from '../src/backup/unfinished-import.js';
import { runGraphDataCommand } from '../src/cli/graph-data-command.js';
import { consoleGraphBackup, runConsoleGraphBackup } from '../src/data-format/console-graph-backup.js';
import { consoleRestore } from '../src/data-format/console-restore.js';
import { dataFormatMigrations } from '../src/data-format/migration-operations.js';
import { consoleUpdate } from '../src/system/console-update.js';
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
  await runConsoleGraphBackup(paths, id, { control: control(log), waitingVersion: async () => {
    steps.push(JSON.parse(readFileSync(journal, 'utf8')).step);
    return 23;
  }, graphData: exportCommand(async (graph, to) => {
    steps.push(JSON.parse(readFileSync(journal, 'utf8')).step);
    writeFileSync(to, `dump:${graph}`);
  }) });
  assert.deepEqual(steps, ['exporting', 'exporting', 'checking'], 'the step is read again once FULI is back');
  assert.deepEqual(log, ['stop', 'start']);
  const done = backup.status();
  assert.deepEqual([done.status, done.started, done.error, done.beforeConfirmation], ['done', true, null, true]);
  assert.ok(existsSync(join(paths.graphBackupDir, NAME, 'manifest.json')));
  assert.deepEqual(JSON.parse(readFileSync(join(paths.graphBackupDir, NAME, 'format-step.json'), 'utf8')),
    { formatVersion: 23, beforeConfirmation: true }, 'the backup says which waiting step it was taken before; the manifest is untouched');
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
  // A folder whose note is not JSON leaves out only itself.
  const broken = join(paths.graphBackupDir, 'before-format-23-2026-11-25T08-00-00-000Z');
  mkdirSync(broken, { recursive: true });
  writeFileSync(join(broken, 'manifest.json'), readFileSync(join(folder, 'manifest.json')));
  writeFileSync(join(broken, 'format-step.json'), '{ not json');
  // Without the note the worker leaves once a backup taken while the step waited is whole, it is not offered.
  await assert.rejects(port(root).startRestore({ version: 23, name: NAME }), error => error.code === 'graph_backup_unknown');
  assert.equal((await port(root).read(23)).latest, null);
  writeFileSync(join(folder, 'format-step.json'), JSON.stringify({ formatVersion: 22, beforeConfirmation: true }));
  assert.equal((await port(root).read(23)).latest, null, 'a note for another version does not count');
  writeFileSync(join(folder, 'format-step.json'), JSON.stringify({ formatVersion: 23, beforeConfirmation: true }));
  assert.equal((await port(root).read(23)).latest.name, NAME, 'the newer folder with a broken note is left out, the rest is listed');
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

// The console's port: the graph step as previewed, and FULI's stop and start never reached.
const waitingGraph = (toVersion) => ({ preview: async () => ({ undoable: [], plan: toVersion === null ? null
  : { store: 'graph', kind: 'neo4j', action: 'apply', digest: 'd'.repeat(64), step: { id: `graph/${toVersion}-x`, toVersion } } }) });

test('a backup starts only while the graph step waits for that version, and nothing confirms or undoes while it runs', async (t) => {
  const { root } = dataDir(t);
  const spawned = [];
  const graphBackup = port(root, { spawnWorker: fakeWorker(spawned) });
  let graph = waitingGraph(23);
  const migrations = () => dataFormatMigrations(root, { graph: { preview: () => graph.preview() }, graphBackup });

  // Confirmed in another window, or a page left open on another version: refused, nothing stopped.
  graph = waitingGraph(null);
  await assert.rejects(migrations().graphBackup.startBackup({ version: 23 }),
    error => error.code === 'graph_backup_confirmed' && error.status === 409 && /no longer waits/.test(error.message));
  graph = waitingGraph(24);
  await assert.rejects(migrations().graphBackup.startBackup({ version: 23 }), error => error.code === 'graph_backup_confirmed');
  // The graph's state cannot be read: said as that, not as confirmed.
  graph = { preview: async () => { throw new Error('Provider down'); } };
  await assert.rejects(migrations().graphBackup.startBackup({ version: 23 }), error => error.code === 'graph_format_unreadable' && error.status === 409);
  graph = { preview: async () => ({ plan: { store: 'graph', kind: 'neo4j', action: 'blocked', steps: [] }, undoable: [] }) };
  await assert.rejects(migrations().graphBackup.startBackup({ version: 23 }), error => error.code === 'graph_format_unreadable');
  assert.equal(spawned.length, 0);

  graph = waitingGraph(23);
  const port_ = migrations();
  const started = await port_.graphBackup.startBackup({ version: 23 });
  assert.equal(started.status, 'running');
  // Within the worker's grace second, or from another window: the confirmation and the undo wait for it.
  await assert.rejects(port_.apply({ digest: 'd'.repeat(64), actor: { entrypoint: 'http' } }),
    error => error.code === 'graph_backup_running' && error.status === 409 && /confirm or undo once it is done/.test(error.message));
  await assert.rejects(port_.rollback({ label: 'graph (personal)', migrationId: 'graph/23-x', actor: { entrypoint: 'http' } }),
    error => error.code === 'graph_backup_running');
});

test('a confirmation under way refuses a graph backup or restore that would start beside it', async (t) => {
  const { root } = dataDir(t);
  const spawned = [];
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let previews = 0;
  // The first preview is the apply's own: it holds the apply open while the backup is asked for.
  const graph = { preview: async () => { previews += 1; if (previews === 1) await held; return waitingGraph(23).preview(); } };
  const port_ = dataFormatMigrations(root, { graph, graphBackup: port(root, { spawnWorker: fakeWorker(spawned) }) });
  const applying = port_.apply({ digest: 'e'.repeat(64), actor: { entrypoint: 'http' } }).catch(error => error);
  await assert.rejects(port_.graphBackup.startBackup({ version: 23 }),
    error => error.code === 'graph_format_changing' && /being confirmed or undone; look again once it is done/.test(error.message));
  await assert.rejects(port_.graphBackup.startRestore({ version: 23, name: NAME }), error => error.code === 'graph_format_changing');
  release();
  await applying;
  assert.equal(spawned.length, 0);
});

test('a second backup asked for while one runs follows it; a restore, a store restore or an update waits for it, and it for them', async (t) => {
  const { root } = dataDir(t);
  const spawned = [];
  const backup = port(root, { spawnWorker: fakeWorker(spawned) });
  const first = await backup.startBackup({ version: 23 });
  const second = await backup.startBackup({ version: 23 });
  assert.deepEqual([second.id, second.joined, spawned.length], [first.id, true, 1], 'the later tab follows the same job');
  const journal = join(root, 'format-graph-backup.json');
  const running = JSON.parse(readFileSync(journal, 'utf8'));
  writeFileSync(journal, JSON.stringify({ ...running, workerPid: process.pid }));

  // The jobs that already stopped and started FULI wait for the graph's.
  await assert.rejects(Promise.resolve().then(() => consoleRestore(root, { stores: () => [] }).start({ label: 'x', backupRef: 'y', currentDigest: null })),
    error => error.code === 'graph_backup_running' && error.status === 409 && /The graph is being backed up/.test(error.message));
  assert.throws(() => consoleUpdate(root, { platform: 'linux' }).start(), error => error.code === 'graph_backup_running');

  // And the graph's waits for them, naming the one that runs.
  rmSync(journal);
  const pid = { workerPid: process.pid, startedAt: NOW, id: 'other' };
  writeFileSync(join(root, 'format-restore.json'), JSON.stringify({ ...pid, status: 'restoring' }));
  await assert.rejects(backup.startBackup({ version: 23 }), error => error.code === 'format_restore_running' && /A store is being restored/.test(error.message));
  rmSync(join(root, 'format-restore.json'));
  writeFileSync(join(root, 'console-update.json'), JSON.stringify({ ...pid, status: 'updating' }));
  await assert.rejects(backup.startBackup({ version: 23 }), error => error.code === 'update_running' && /FULI is being updated/.test(error.message));
  assert.equal(spawned.length, 1);
});

test('a backup whose step was confirmed meanwhile, or could not be checked, is kept but never offered as the one from before', async (t) => {
  const run = async (options) => {
    const { root, paths } = dataDir(t);
    const backup = port(root, { spawnWorker: fakeWorker([]) });
    const { id } = await backup.startBackup({ version: 23 });
    await runConsoleGraphBackup(paths, id, { control: control([]), graphData: exportCommand(async (graph, to) => writeFileSync(to, `dump:${graph}`)),
      ...options });
    return { backup, folder: join(paths.graphBackupDir, NAME) };
  };
  // `fuli migrate apply` in a terminal while the graph was exported: the step no longer waits.
  const confirmed = await run({ waitingVersion: async () => null });
  assert.deepEqual([confirmed.backup.status().status, confirmed.backup.status().beforeConfirmation], ['done', false]);
  assert.ok(existsSync(join(confirmed.folder, 'manifest.json')), 'the backup itself is kept among the old data');
  assert.equal(existsSync(join(confirmed.folder, 'format-step.json')), false);
  assert.equal((await confirmed.backup.read(23)).latest, null);

  // The Provider never answered: asked again a while, then said as unchecked.
  const pauses = [];
  const unread = await run({ waitingVersion: async () => { throw new Error('Provider down'); }, pause: async ms => { pauses.push(ms); } });
  assert.deepEqual([unread.backup.status().beforeConfirmation, pauses.length, existsSync(join(unread.folder, 'format-step.json'))], [null, 11, false]);

  // FULI did not start again: nothing is checked, nothing is noted.
  const checks = [];
  const down = await run({ waitingVersion: async () => { checks.push(1); return 23; },
    control: { consoleRunning: async () => false, stop: async () => ({ status: 'stopped' }), start: async () => { throw new Error('refused'); } } });
  assert.deepEqual([down.backup.status().started, down.backup.status().beforeConfirmation, checks.length], [false, null, 0]);
});

test('a job journal that cannot be read holds no other job back, and the diagnostics log says so', async (t) => {
  const { root } = dataDir(t);
  writeFileSync(join(root, 'console-update.json'), '{ not json');
  const started = await port(root, { spawnWorker: fakeWorker([]) }).startBackup({ version: 23 });
  assert.equal(started.status, 'running');
  assert.match(readFileSync(join(root, 'diagnostics', 'events.jsonl'), 'utf8'), /job_journal_unreadable/);
});
