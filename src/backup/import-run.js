import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { processState } from '../local-runtime/processes.js';
import { currentProcessIdentity, PROCESS_IDENTITY, recordedProcessState } from '../native-runtime/process-identity.js';
import { inspectWindowsNativeProcess } from '../native-runtime/windows-processes.js';
import { acquireFileLock } from '../storage/file-lock.js';

// The desktop window's way out of an unfinished import (unfinished-import-plan.js)
// runs `fuli graph import` or `fuli graph abandon-import` in a controller the
// window started and no longer waits for once it takes too long. Nothing else
// keeps a second one from starting meanwhile on the same graphs, so the
// controller records that it runs one: data dir graph-import-running-<mode>.json,
// { pid, command, startedAt, kind, since }, the controller as the system
// shows it (`ps` on macOS and Linux, its process table on Windows). While that
// process still runs, the way out and a start are refused (import_running).
// The record goes when the run ends, failed or not; one whose process ended
// without removing it (killed, the computer shut down) no longer counts, nor
// does one whose PID is now another program. It is a runtime record, like a
// lock, not FULI data.

// The longest a run is taken to go on when its process cannot be told apart
// from another with its PID: past it, the record no longer counts. The window
// waits as long in an import step (desktop-controller.js reports it as the
// step's maxSeconds).
export const IMPORT_RUN_LONGEST_MS = 24 * 60 * 60 * 1000;

const recordPath = (paths, mode) => join(paths.dataDir, `graph-import-running-${mode}.json`);

// How a process is told apart from another with its PID on Windows, where
// there is no `ps`: its command line and creation time from the process table
// (windows-processes.js), read once per check; one that cannot be read is
// null, never an error.
export function windowsProcessIdentity(read = pid => inspectWindowsNativeProcess(pid, { timeoutMs: 10_000 })) {
  const seen = new Map();
  const row = pid => {
    if (!seen.has(pid)) seen.set(pid, Promise.resolve().then(() => read(pid)).catch(() => null));
    return seen.get(pid);
  };
  return {
    state: processState,
    startTime: async pid => (await row(pid))?.createdFileTime ?? null,
    matches: async (pid, command) => (await row(pid))?.commandLine === command,
    whoami: async () => ({ pid: process.pid, command: (await row(process.pid))?.commandLine ?? null,
      startedAt: (await row(process.pid))?.createdFileTime ?? null })
  };
}

function systemIdentity(platform) {
  if (platform !== 'win32') return { ...PROCESS_IDENTITY, whoami: currentProcessIdentity };
  return windowsProcessIdentity();
}

// The run in progress for [mode] ({ pid, kind, since }), or null when there is
// none, its process has ended, or it is past IMPORT_RUN_LONGEST_MS and its
// process cannot be checked against the record.
export async function runningImport(paths, mode, { identity = systemIdentity(process.platform), now = Date.now } = {}) {
  let record = null;
  try { record = JSON.parse(readFileSync(recordPath(paths, mode), 'utf8')); } catch { return null; }
  if (!Number.isInteger(record?.pid)) return null;
  if (await recordedProcessState(record, identity) === 'gone') return null;
  const since = Date.parse(record.since ?? '');
  if (!(now() - since <= IMPORT_RUN_LONGEST_MS)) {
    const checkable = typeof record.startedAt === 'string' && typeof record.command === 'string'
      && await identity.startTime(record.pid) !== null;
    if (!checkable) return null;
  }
  return { pid: record.pid, kind: record.kind ?? null, since: record.since ?? null };
}

// The refusal's facts while [running] goes on (a run whose record could not be
// read in time names no process).
export function importRunningFacts(mode, running) {
  return { reason: 'import_running', mode, pid: running?.pid ?? null, runKind: running?.kind ?? null, runSince: running?.since ?? null };
}

// Records this process as running [kind] ('import' or 'abandon-import') for
// [mode]: { release } once recorded, or { running } when another run still
// goes on. Checking and recording happen under one short lock (its file,
// beside the record, holds no data and stays), so two controllers asked at
// the same moment never both go ahead; one that cannot get that lock in time
// counts as another run going on.
export async function claimImportRun(paths, mode, kind, { identity = systemIdentity(process.platform), now = () => new Date() } = {}) {
  const path = recordPath(paths, mode);
  let unlock;
  try { unlock = acquireFileLock(`${path}.lock`, { waitMs: 5_000 }); }
  catch (error) {
    if (error?.code === 'file_lock_busy') return { running: { pid: null, kind: null, since: null } };
    throw error;
  }
  try {
    const running = await runningImport(paths, mode, { identity, now: () => now().getTime() });
    if (running) return { running };
    const me = await identity.whoami();
    writeFileSync(path, `${JSON.stringify({ ...me, kind, since: now().toISOString() })}\n`, { mode: 0o600 });
    return { release: () => rmSync(path, { force: true }) };
  } finally {
    unlock();
  }
}
