import { createHash, randomUUID } from 'node:crypto';
import { renameSync, rmSync } from 'node:fs';
import { mkdir, open, readFile, rm, lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { acquireTranscriptGuardLock, isTranscriptGuardBusy } from './transcript-guard-lock.js';

export const transcriptDigest = value => createHash('sha256').update(value).digest('hex');
export const TRANSCRIPT_GUARD_TTL_MS = 60_000;
export const TRANSCRIPT_SCAN_PAGE_LIMIT = 64;

// Only opaque hashes and byte offsets are stored locally. The per-session lock
// covers scan, begin, and claim; a second hook must retry rather than race it.
export async function withTranscriptGuard(runtimeConfigPath, input, source, enabled, operation) {
  if (!enabled || !input?.transcript_path || !input?.session_id) return operation(null);
  const directory = join(dirname(runtimeConfigPath), 'transcript-guards');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory()) throw new Error('Transcript guard directory is unavailable');
  const key = transcriptDigest(`${runtimeConfigPath}\0${source}\0${input.session_id}`);
  const path = join(directory, `${key}.json`);
  // The OS releases the lock even if the process is killed. Contention fails
  // closed and requests a retry; no transcript is served.
  const release = await acquireTranscriptGuardLock(
    join(dirname(runtimeConfigPath), 'transcript-guard-locks'), transcriptDigest(`${directory}\0${key}`));
  try {
    let active = true;
    let value = null;
    try {
      if (!(await lstat(path)).isFile()) throw new Error('Invalid transcript guard');
      value = JSON.parse(await readFile(path, 'utf8'));
      if (value.version !== 1 || !['scan', 'ready', 'beginning', 'claim', 'fallback'].includes(value.phase)
        || !/^[a-f0-9]{64}$/.test(value.owner ?? '') || !/^[a-f0-9]{64}$/.test(value.prompt ?? '')
        || !Number.isSafeInteger(value.scanCursor) || value.scanCursor < 0
        || (value.createdAt !== undefined && (!Number.isSafeInteger(value.createdAt) || value.createdAt < 0))
        || (value.scanPages !== undefined && (!Number.isSafeInteger(value.scanPages) || value.scanPages < 0))
        || (value.boundary !== undefined && (!Number.isSafeInteger(value.boundary) || value.boundary < 0))
        || (value.phase === 'fallback' && (!/^[a-f0-9]{64}$/.test(value.nextOwner ?? '')
          || !Number.isSafeInteger(value.recoveryFrom) || value.recoveryFrom < 0
          || !Number.isSafeInteger(value.boundary) || value.boundary < value.recoveryFrom))) {
        throw new Error('Invalid transcript guard state');
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const guard = {
      invalidate() { active = false; },
      get value() { return value; },
      // Legacy guards have no bounded lifetime. Do not resume their scan;
      // the entry path may quarantine a verified EOF without importing it.
      get expired() { return Boolean(value && (!Number.isSafeInteger(value.createdAt)
        || Date.now() < value.createdAt || Date.now() - value.createdAt >= TRANSCRIPT_GUARD_TTL_MS)); },
      async write(next) {
        if (!active) throw new Error('Transcript guard is no longer owned');
        next = { ...next, createdAt: next.createdAt ?? value?.createdAt ?? Date.now(), updatedAt: Date.now() };
        const temporary = `${path}.${randomUUID()}`;
        try {
          const file = await open(temporary, 'wx', 0o600);
          try { await file.writeFile(JSON.stringify(next)); await file.sync(); }
          finally { await file.close(); }
          if (!active) throw new Error('Transcript guard is no longer owned');
          // Do not yield between the ownership check and this canonical-path
          // mutation: capture expiry can release the lock while async rename
          // is still in flight and overwrite the next holder's guard.
          renameSync(temporary, path);
          value = next;
        } finally { await rm(temporary, { force: true }); }
      },
      async clear() {
        if (!active) throw new Error('Transcript guard is no longer owned');
        // The same no-yield boundary protects removal after capture expiry.
        rmSync(path, { force: true }); value = null;
      }
    };
    try { return await operation(guard); }
    finally { active = false; }
  } finally { await release(); }
}

// Only a busy guard lock is attributed to another Fuli hook; every other guard
// failure stays generic so local diagnostics are never echoed to the host.
export function transcriptGuardFailureMessage(error) {
  return isTranscriptGuardBusy(error)
    ? 'Another Fuli hook for this host session is still running; transcript import was skipped. Preferences and current task context are available.'
    : 'Fuli transcript handoff could not be completed safely; native history was not imported. Preferences and current task context are available.';
}
