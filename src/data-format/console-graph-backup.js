import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ApplicationError } from '../app/application-error.js';
import { exportGraphData, importGraphData, readGraphBackupManifest } from '../backup/graph-backup.js';
import { unfinishedImportError } from '../backup/unfinished-import.js';
import { runGraphDataCommand } from '../cli/graph-data-command.js';
import { localRuntimeControl } from '../cli/local-runtime-control.js';
import { revealPath } from '../desktop/reveal-path.js';
import { readLock } from '../native-runtime/neo4j-lifecycle-lock.js';
import { diskFree, diskSize } from '../native-runtime/recovered-dir.js';
import { resolveSetupPaths } from '../setup/paths.js';
import { claimDetachedJob, detachedJob } from '../system/detached-job.js';
import { RESTARTING_JOBS, refuseWhileRestarting, restartingJobError, runningJob } from '../system/restarting-jobs.js';
import { readRuntimeSettings } from '../system/runtime-settings.js';
import { readJsonFile, writeJsonFileAtomic } from '../storage/json-file.js';

// The data format page's 「先备份图谱」 and, when an undo is refused, its
// 「用这份备份恢复」 (rec#17 graph/23): the same `fuli graph export` and
// `fuli graph import` a terminal runs, for the graph step that waits. Both
// stop FULI (the graph is dumped and loaded offline), so like the console's
// update and whole-store restore a detached worker (system/detached-job.js)
// runs them, journals each step and starts FULI again whatever happened; the
// page follows until the console answers.
//
// A backup goes to the data directory's backups/graph/ beside the copies an
// import or a Neo4j upgrade keeps, named for the format version it was taken
// before and when: before-format-<version>-<time>. A restore takes only one of
// those, and the import keeps a copy of the graph as it is first.
//
// Before anything stops it refuses what the commands would refuse later: an
// unfinished import's marker or a held lifecycle lock (FULI could not start
// again on either), a disk that cannot hold the export, and another job that
// stops and starts FULI (system/restarting-jobs.js). A second backup asked
// for while one runs follows that one.
//
// Only a backup taken while the step waited is the one from before the
// confirmation (the console's port checks that it waits and keeps the step
// from being confirmed meanwhile: migration-operations.js). Once the export is
// whole the worker leaves a note in its folder (format-step.json:
// { formatVersion, beforeConfirmation: true }). Only a backup with that note
// for the version is listed and restored; the graph export's own manifest
// stays as it is.

const { journal: JOURNAL, running: RUNNING } = RESTARTING_JOBS.graph;
const WORKER = fileURLToPath(new URL('./console-graph-backup-worker.js', import.meta.url));
const NOTE = 'format-step.json';
const NAME = /^before-format-(\d{1,4})-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

export function consoleGraphBackup(dataDir, { paths = resolveSetupPaths({ dataDir }), spawnWorker, now = Date.now,
  freeSpace = diskFree, platform = process.platform, reveal = revealPath } = {}) {
  const job = detachedJob(join(dataDir, JOURNAL), { worker: WORKER, running: RUNNING, spawnWorker, now });
  const mode = () => readRuntimeSettings(paths.runtimeSettingsPath).graphRuntimeMode;

  function status() {
    const current = job.read();
    return current && { id: current.id, action: current.action, status: current.status, step: current.step ?? null,
      version: current.version, backup: current.name ? described(current.name) : null, error: current.error ?? null,
      started: current.started ?? null };
  }

  // A backup this page took before [version] was confirmed, newest first, once its manifest reads.
  async function backups(version) {
    let names = [];
    try { names = readdirSync(paths.graphBackupDir); } catch { /* none yet */ }
    const own = names.filter(name => NAME.exec(name)?.[1] === String(version) && takenBefore(name, version)).sort().reverse();
    const readable = await Promise.all(own.map(name => readGraphBackupManifest(join(paths.graphBackupDir, name)).then(() => name, () => null)));
    return readable.filter(Boolean).map(described);
  }

  function takenBefore(name, version) {
    const note = readJsonFile(join(paths.graphBackupDir, name, NOTE), null);
    return note?.formatVersion === version && note.beforeConfirmation === true;
  }

  function described(name) {
    const path = join(paths.graphBackupDir, name);
    const [, version] = NAME.exec(name);
    const time = name.slice(`before-format-${version}-`.length).replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, 'T$1:$2:$3.$4Z');
    return { name, path, createdAt: time, bytes: diskSize(path) };
  }

  // How big the export can get and how much room there is. Only the native
  // runtime's stores can be measured beforehand; a dump is never bigger than them.
  async function room() {
    const bytes = mode() === 'native'
      ? [paths.nativePersonalDir, paths.nativeWorkspaceDir].reduce((sum, dir) => sum + diskSize(join(dir, 'data')), 0) : null;
    let free = null;
    try { free = await freeSpace(paths.dataDir); } catch { /* unknown */ }
    return { bytes, freeBytes: free };
  }

  // What would keep FULI from starting again after it stopped: refused before it stops.
  function refuseBlocked() {
    const unfinished = unfinishedImportError(paths, mode());
    if (unfinished) throw new ApplicationError('graph_import_unfinished', unfinished.message, { status: 409 });
    if (mode() === 'native' && platform === 'darwin' && readLock(paths.nativeRuntimeDir)) {
      throw new ApplicationError('graph_lifecycle_locked', 'The graph database maintenance lock is held; nothing was stopped.', { status: 409 });
    }
  }

  // Synchronous from here to job.start, so a second start in this console sees the first.
  function begin(fields, failure) {
    const current = job.read();
    if (RUNNING.has(current?.status)) {
      if (fields.action === 'backup' && current.action === 'backup' && current.version === fields.version) return { ...status(), joined: true };
      throw restartingJobError(runningJob(dataDir, 'graph'), 'start this');
    }
    refuseWhileRestarting(dataDir, 'graph');
    job.start(dataDir, { status: 'running', ...fields }, failure);
    return status();
  }

  async function backupOf(version, name) {
    const found = (await backups(version)).find(backup => backup.name === name);
    if (!found) throw new ApplicationError('graph_backup_unknown', 'Choose one of the backups this page lists.', { status: 409 });
    return found;
  }

  return {
    status,
    // The page's view before it offers the button: the newest backup for this step, the room, and the last job.
    read: async version => ({ latest: (await backups(version))[0] ?? null, room: await room(), job: status() }),
    async startBackup({ version }) {
      refuseBlocked();
      const { bytes, freeBytes } = await room();
      if (bytes !== null && freeBytes !== null && freeBytes < bytes) {
        throw new ApplicationError('graph_backup_no_space', 'The disk cannot hold the graph export; nothing was stopped.', { status: 409 });
      }
      const name = `before-format-${version}-${new Date(now()).toISOString().replace(/[:.]/g, '-')}`;
      return begin({ action: 'backup', version, name }, 'The backup could not start. Nothing was changed.');
    },
    async startRestore({ version, name }) {
      await backupOf(version, name);
      refuseBlocked();
      return begin({ action: 'restore', version, name }, 'The restore could not start. Nothing was changed.');
    },
    reveal: async ({ version, name }) => reveal((await backupOf(version, name)).path)
  };
}

// The worker: the same command a terminal runs, its stop and start recorded
// as steps, then FULI started again if it is not running. An import that
// left a graph half written keeps FULI from starting (graph-data-command.js);
// the desktop window then offers the way back.
export async function runConsoleGraphBackup(paths, id, { graphData = runGraphDataCommand,
  control = localRuntimeControl(paths, process.env, () => {}) } = {}) {
  const claimed = claimDetachedJob(join(paths.dataDir, JOURNAL), id, 'running');
  if (!claimed) return;
  const { job, record } = claimed;
  const folder = join(paths.graphBackupDir, job.name);
  const runtime = {
    consoleRunning: () => control.consoleRunning(),
    stop: () => { record({ step: 'stopping' }); return control.stop(); },
    start: () => { record({ step: 'starting' }); return control.start(); }
  };
  const step = (name, operation) => options => { record({ step: name }); return operation(options); };
  try {
    if (job.action === 'backup') {
      await graphData('export', ['--output', folder, '--data-dir', paths.dataDir],
        { runtime, write: () => {}, exportData: step('exporting', exportGraphData) });
      writeJsonFileAtomic(join(folder, NOTE), { formatVersion: job.version, beforeConfirmation: true });
    } else {
      await graphData('import', ['--input', folder, '--data-dir', paths.dataDir, '--yes'],
        { runtime, write: () => {}, importData: step('restoring', importGraphData) });
    }
    record({ status: 'done' });
  } catch (error) {
    record({ status: 'failed', error: String(error?.message ?? error).split('\n')[0].slice(0, 600) });
  }
  const started = await control.consoleRunning().then(running => running || runtime.start().then(() => true))
    .catch(() => false);
  record({ started, step: null });
}
