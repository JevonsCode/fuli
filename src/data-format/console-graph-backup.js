import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { ApplicationError } from '../app/application-error.js';
import { exportGraphData, importGraphData, readGraphBackupManifest } from '../backup/graph-backup.js';
import { unfinishedImportError } from '../backup/unfinished-import.js';
import { runGraphDataCommand } from '../cli/graph-data-command.js';
import { personalGraphFormat } from './graph-format-client.js';
import { waitingGraphVersion } from './migration-plan.js';
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
// confirmation. The console's port checks that it waits and keeps this
// console from confirming meanwhile (migration-operations.js); a terminal's
// `fuli migrate apply` it cannot hold back, so once FULI is back the worker
// reads the step again. Only if it still waits for the same version does it
// leave a note in the backup's folder (format-step.json: { formatVersion,
// beforeConfirmation: true }); otherwise the job says the backup is not one
// from before the confirmation (false), or that this could not be checked
// (null), and it stays among the old data. Only a backup with that note for
// the version is listed and restored; the graph export's own manifest stays
// as it is. A note may only be missing, never wrong.

const { journal: JOURNAL, running: RUNNING } = RESTARTING_JOBS.graph;
const WORKER = fileURLToPath(new URL('./console-graph-backup-worker.js', import.meta.url));
const NOTE = 'format-step.json';
const FOLLOWER = /^follower-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;
const NAME = /^before-format-(\d{1,4})-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

export function consoleGraphBackup(dataDir, { paths = resolveSetupPaths({ dataDir }), spawnWorker, now = Date.now,
  freeSpace = diskFree, platform = process.platform, reveal = revealPath } = {}) {
  const job = detachedJob(join(dataDir, JOURNAL), { worker: WORKER, running: RUNNING, spawnWorker, now });
  const mode = () => readRuntimeSettings(paths.runtimeSettingsPath).graphRuntimeMode;

  function status() {
    const current = job.read();
    return current && { id: current.id, action: current.action, status: current.status, step: current.step ?? null,
      version: current.version, backup: current.name ? described(current.name) : null, error: current.error ?? null,
      started: current.started ?? null, beforeConfirmation: current.beforeConfirmation ?? null };
  }

  // A backup this page took before [version] was confirmed, newest first, once its manifest reads.
  async function backups(version) {
    let names = [];
    try { names = readdirSync(paths.graphBackupDir); } catch { /* none yet */ }
    const own = names.filter(name => NAME.exec(name)?.[1] === String(version) && takenBefore(name, version)).sort().reverse();
    const readable = await Promise.all(own.map(name => readGraphBackupManifest(join(paths.graphBackupDir, name)).then(() => name, () => null)));
    return readable.filter(Boolean).map(described);
  }

  // A note that cannot be read leaves out only its own backup.
  function takenBefore(name, version) {
    try {
      const note = readJsonFile(join(paths.graphBackupDir, name, NOTE), null);
      return note?.formatVersion === version && note.beforeConfirmation === true;
    } catch {
      return false;
    }
  }

  function described(name) {
    const path = join(paths.graphBackupDir, name);
    const prefix = FOLLOWER.test(name) ? 'follower-' : `before-format-${NAME.exec(name)[1]}-`;
    const time = name.slice(prefix.length).replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, 'T$1:$2:$3.$4Z');
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
    async followerBackups() {
      let names;
      try { names = readdirSync(paths.graphBackupDir, { withFileTypes: true }); }
      catch (error) { if (error.code === 'ENOENT') return []; throw error; }
      const folders = names.filter(entry => entry.isDirectory() && FOLLOWER.test(entry.name));
      const found = await Promise.all(folders.map(async entry => {
        try { await readGraphBackupManifest(join(paths.graphBackupDir, entry.name)); return described(entry.name); }
        catch { return null; }
      }));
      return found.filter(Boolean).sort((a, b) => b.name.localeCompare(a.name));
    },
    // The page's view before it offers the button: the newest backup for this step, the room, and the last job.
    read: async version => ({ latest: (await backups(version))[0] ?? null, room: await room(), job: status() }),
    async startBackup({ version = null }) {
      refuseBlocked();
      const { bytes, freeBytes } = await room();
      if (bytes !== null && freeBytes !== null && freeBytes < bytes) {
        throw new ApplicationError('graph_backup_no_space', 'The disk cannot hold the graph export; nothing was stopped.', { status: 409 });
      }
      const prefix = version === null ? 'follower' : `before-format-${version}`;
      const name = `${prefix}-${new Date(now()).toISOString().replace(/[:.]/g, '-')}`;
      return begin({ action: 'backup', version, name }, 'The backup could not start. Nothing was changed.');
    },
    async startRestore({ version = null, name }) {
      if (version === null) {
        if (!FOLLOWER.test(name) || !(await this.followerBackups()).some(item => item.name === name)) {
          throw new ApplicationError('graph_backup_unknown', 'Choose a backup from this computer’s list.', { status: 409 });
        }
      } else await backupOf(version, name);
      refuseBlocked();
      return begin({ action: 'restore', version, name }, 'The restore could not start. Nothing was changed.');
    },
    reveal: async ({ version, name }) => reveal((await backupOf(version, name)).path)
  };
}

// The Provider may answer a while after FULI is back: the step is read again this often, this many times.
const CHECK_EVERY_MS = 5000;
const CHECKS = 12;

// The worker: the same command a terminal runs, its stop and start recorded
// as steps, then FULI started again if it is not running. An import that
// left a graph half written keeps FULI from starting (graph-data-command.js);
// the desktop window then offers the way back. A backup's outcome is
// recorded only once it is checked against the step (see above).
export async function runConsoleGraphBackup(paths, id, { graphData = runGraphDataCommand,
  control = localRuntimeControl(paths, process.env, () => {}),
  waitingVersion = () => waitingGraphVersion(personalGraphFormat(paths.dataDir)), pause = delay } = {}) {
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
  let outcome = { status: 'done' };
  try {
    if (job.action === 'backup') {
      await graphData('export', ['--output', folder, '--data-dir', paths.dataDir],
        { runtime, write: () => {}, exportData: step('exporting', exportGraphData) });
    } else {
      await graphData('import', ['--input', folder, '--data-dir', paths.dataDir, '--yes'],
        { runtime, fromFollowerConsole: true, write: () => {}, importData: step('restoring', importGraphData) });
    }
  } catch (error) {
    outcome = { status: 'failed', error: String(error?.message ?? error).split('\n')[0].slice(0, 600) };
  }
  const started = await control.consoleRunning().then(running => running || runtime.start().then(() => true))
    .catch(() => false);
  if (job.action === 'backup' && Number.isInteger(job.version) && outcome.status === 'done') {
    record({ step: 'checking' });
    const before = started ? await stillWaiting(job.version, waitingVersion, pause) : null;
    outcome.beforeConfirmation = before && noted(folder, job.version);
  }
  record({ ...outcome, started, step: null });
}

// true: the step still waits for this version; false: it no longer does; null: it could not be read.
async function stillWaiting(version, waitingVersion, pause) {
  for (let check = 1; check <= CHECKS; check += 1) {
    try { return await waitingVersion() === version; } catch { if (check < CHECKS) await pause(CHECK_EVERY_MS); }
  }
  return null;
}

// true once the note is written; null when it could not be.
function noted(folder, version) {
  try {
    writeJsonFileAtomic(join(folder, NOTE), { formatVersion: version, beforeConfirmation: true });
    return true;
  } catch {
    return null;
  }
}
