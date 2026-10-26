import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DataFormatError } from '../../packages/roundtable/src/storage/data-format-error.js';
import { localRuntimeControl } from '../cli/local-runtime-control.js';
import { isProcessAlive } from '../local-runtime/processes.js';
import { readJsonFile, writeJsonFileAtomic } from '../storage/json-file.js';
import { acquireMaintenance } from './maintenance-lock.js';
import { describeRestore, restoreStore } from './migration-operations.js';
import { localStoresWithEngines } from './migration-plan.js';

// A whole-store restore asked for in the console (rec#17 D-09 part 2), the
// same restore `fuli migrate restore` runs. The store must be unused, and the
// console holds the data directory's maintenance lock shared while it runs,
// so the console cannot restore in its own process. It journals the confirmed
// restore here and starts a detached worker that stops FULI, takes the lock
// exclusively, restores exactly what the person saw (the store's digest is
// checked again inside its lock; the store as it is is backed up first) and
// starts FULI again, as the settings page's restart does. The page reads the
// outcome from this journal once the console answers again. Local stores
// only: the graph is restored from a graph export, offline.

const JOURNAL = 'format-restore.json';
const CONSOLE_ACTOR = Object.freeze({ entrypoint: 'http' });
// A worker that is gone this long after the start without an outcome was interrupted.
const INTERRUPTED_AFTER_MS = 10_000;
const RUNNING = new Set(['stopping', 'restoring', 'starting']);

const journalPath = (dataDir) => join(dataDir, JOURNAL);
const save = (dataDir, job) => writeJsonFileAtomic(journalPath(dataDir), job);

export function consoleRestore(dataDir, { stores = () => localStoresWithEngines(dataDir), spawnWorker = spawn,
  now = Date.now } = {}) {
  function status() {
    const job = readJsonFile(journalPath(dataDir), null);
    if (!job) return null;
    const interrupted = RUNNING.has(job.status) && now() - job.startedAt > INTERRUPTED_AFTER_MS
      && !isProcessAlive(job.workerPid);
    return { id: job.id, label: job.label, backupRef: job.backupRef, status: interrupted ? 'failed' : job.status,
      safetyBackupRef: job.safetyBackupRef ?? null, started: job.started ?? null,
      error: interrupted ? 'The restore was interrupted before it reported an outcome.' : job.error ?? null };
  }
  function localLabel(label) {
    if (!stores().some((store) => store.label === label)) throw new TypeError('Choose one of the local stores listed');
    return label;
  }
  return {
    status,
    // The local stores with format backups to choose from, each oldest backup first.
    choices: () => stores().map(({ label, format, kind }) => ({ label, store: format.store, kind,
      backups: describeRestore({ dataDir, label }).backups })).filter((store) => store.backups.length),
    describe: (label, backupRef) => describeRestore({ dataDir, label: localLabel(label), backupRef }).impact,
    start({ label, backupRef, currentDigest }) {
      if (RUNNING.has(status()?.status)) throw new TypeError('A restore is already running. Please wait.');
      const { impact } = describeRestore({ dataDir, label: localLabel(label), backupRef });
      if (impact.currentDigest !== currentDigest) {
        throw new DataFormatError(impact.store, 'data_format_stale_preview', `FULI store "${impact.store}" changed `
          + 'after you saw what the restore discards. Nothing was changed; look at it again before restoring.');
      }
      const job = { id: randomUUID(), status: 'stopping', label, backupRef, impact, startedAt: now() };
      save(dataDir, job);
      const fail = () => save(dataDir, { ...job, status: 'failed', started: true,
        error: 'The restore could not start. Nothing was changed.' });
      try {
        const child = spawnWorker(process.execPath, [fileURLToPath(new URL('./console-restore-worker.js', import.meta.url)),
          dataDir, job.id], { detached: true, windowsHide: true, stdio: 'ignore' });
        child.once('error', fail);
        if (!Number.isInteger(child.pid)) fail();
        else {
          save(dataDir, { ...job, workerPid: child.pid });
          child.unref();
        }
      } catch { fail(); }
      return status();
    }
  };
}

// The worker: stop FULI, restore under the exclusive lock, start FULI again.
// Every step is journaled, and FULI is started again whatever happened.
export async function runConsoleRestore(paths, id, { control = localRuntimeControl(paths, process.env, () => {}),
  acquire = acquireMaintenance, restore = restoreStore } = {}) {
  const job = readJsonFile(journalPath(paths.dataDir), null);
  if (job?.id !== id || job.status !== 'stopping') return;
  const record = (fields) => save(paths.dataDir, Object.assign(job, fields));
  try {
    const stopped = await control.stop();
    if (stopped.status === 'partial') throw new Error('FULI could not be stopped safely. Nothing was changed.');
    record({ status: 'restoring' });
    const release = acquire(paths.dataDir);
    try {
      if (await control.consoleRunning()) throw new Error('FULI is still running. Nothing was changed.');
      const result = restore({ dataDir: paths.dataDir, label: job.label, backupRef: job.backupRef,
        expected: job.impact, actor: CONSOLE_ACTOR });
      record({ safetyBackupRef: result.safetyBackupRef });
    } finally { release(); }
  } catch (error) {
    record({ error: error?.message ?? String(error) });
  }
  record({ status: 'starting' });
  const started = await control.start().then(() => true, () => false);
  record({ status: job.safetyBackupRef ? 'restored' : 'failed', started });
}
