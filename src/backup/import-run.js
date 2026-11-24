import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { currentProcessIdentity, recordedProcessState } from '../native-runtime/process-identity.js';
import { acquireFileLock } from '../storage/file-lock.js';

// The desktop window's way out of an unfinished import (unfinished-import-plan.js)
// runs `fuli graph import` or `fuli graph abandon-import` in a controller the
// window started and no longer waits for once it takes too long. A runtime
// without a lifecycle lock has nothing else that keeps a second one from
// starting meanwhile on the same graphs, so the controller records that it
// runs one: data dir graph-import-running-<mode>.json, { pid, command,
// startedAt, kind, since }, the controller as `ps` shows it. While that
// process still runs, the way out is refused (import_running). The record
// goes when the run ends, failed or not; one whose process ended without
// removing it (killed) no longer counts. It is a runtime record, like a lock,
// not FULI data.

const recordPath = (paths, mode) => join(paths.dataDir, `graph-import-running-${mode}.json`);

// The run in progress for [mode] ({ pid, kind, since }), or null when there is
// none or its process has ended.
export async function runningImport(paths, mode, identity) {
  let record = null;
  try { record = JSON.parse(readFileSync(recordPath(paths, mode), 'utf8')); } catch { return null; }
  if (!Number.isInteger(record?.pid)) return null;
  if (await recordedProcessState(record, identity) === 'gone') return null;
  return { pid: record.pid, kind: record.kind ?? null, since: record.since ?? null };
}

// Records this process as running [kind] ('import' or 'abandon-import') for
// [mode]: { release } once recorded, or { running } when another run still
// goes on. Checking and recording happen under one short lock (its file,
// beside the record, holds no data and stays), so two controllers asked at
// the same moment never both go ahead.
export async function claimImportRun(paths, mode, kind, { identity, whoami = currentProcessIdentity, now = () => new Date() } = {}) {
  const path = recordPath(paths, mode);
  const unlock = acquireFileLock(`${path}.lock`, { waitMs: 5_000 });
  try {
    const running = await runningImport(paths, mode, identity);
    if (running) return { running };
    const me = await whoami();
    writeFileSync(path, `${JSON.stringify({ ...me, kind, since: now().toISOString() })}\n`, { mode: 0o600 });
    return { release: () => rmSync(path, { force: true }) };
  } finally {
    unlock();
  }
}
