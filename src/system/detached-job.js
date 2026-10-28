import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { isProcessAlive } from '../local-runtime/processes.js';
import { readJsonFile, writeJsonFileAtomic } from '../storage/json-file.js';

// A console operation that stops and starts FULI, so it cannot run in the
// console's own process (a whole-store restore, an update): the console
// journals it in one JSON file of the data directory and starts a detached
// worker (`node <worker> <dataDir> <id>`) that outlives it and journals each
// step. The page reads the outcome once the console answers again.

// A worker that is gone this long after the start without an outcome was interrupted.
const INTERRUPTED_AFTER_MS = 10_000;

export function detachedJob(path, { worker, running, spawnWorker = spawn, now = Date.now }) {
  function read() {
    const job = readJsonFile(path, null);
    if (!job) return null;
    const interrupted = running.has(job.status) && now() - job.startedAt > INTERRUPTED_AFTER_MS
      && !isProcessAlive(job.workerPid);
    return interrupted ? { ...job, status: 'failed', error: 'It was interrupted before it reported an outcome.' } : job;
  }
  return {
    read,
    // fields: the first status and what the worker needs; failure: the error if no worker starts.
    start(dataDir, fields, failure) {
      if (running.has(read()?.status)) throw new TypeError('This is already running. Please wait.');
      const job = { id: randomUUID(), ...fields, startedAt: now() };
      writeJsonFileAtomic(path, job);
      const fail = () => writeJsonFileAtomic(path, { ...job, status: 'failed', error: failure });
      try {
        const child = spawnWorker(process.execPath, [worker, dataDir, job.id],
          { detached: true, windowsHide: true, stdio: 'ignore' });
        child.once('error', fail);
        if (!Number.isInteger(child.pid)) fail();
        else {
          writeJsonFileAtomic(path, { ...job, workerPid: child.pid });
          child.unref();
        }
      } catch { fail(); }
      return read();
    },
    // Adds fields to the job with this ID once its worker is done; false when
    // the journal now holds another job.
    amend(id, fields) {
      const job = readJsonFile(path, null);
      if (job?.id !== id || running.has(job.status)) return false;
      writeJsonFileAtomic(path, { ...job, ...fields });
      return true;
    }
  };
}

// The worker waits this long before it stops the console, so the console's
// answer to the page that started it goes out first.
const ANSWER_GRACE_MS = 1000;
export const awaitConsoleAnswer = () => delay(ANSWER_GRACE_MS);

// The worker's side: the job it was started for, still at its first status,
// and a recorder for its steps; null when there is nothing to do.
export function claimDetachedJob(path, id, firstStatus) {
  const job = readJsonFile(path, null);
  if (job?.id !== id || job.status !== firstStatus) return null;
  return { job, record: (fields) => writeJsonFileAtomic(path, Object.assign(job, fields)) };
}
