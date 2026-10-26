import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { mkdir, readFile, lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { writeTextFileAtomic } from '../storage/json-file.js';
import { acquireTranscriptGuardLock, isTranscriptGuardBusy } from './transcript-guard-lock.js';

export const transcriptDigest = value => createHash('sha256').update(value).digest('hex');
export const TRANSCRIPT_GUARD_TTL_MS = 60_000;
export const TRANSCRIPT_SCAN_PAGE_LIMIT = 64;
// Transcript pages one hook reads; the rest waits for the next hook.
export const TRANSCRIPT_PAGES_PER_HOOK = 8;

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
        || (value.nextOwner !== undefined && !/^[a-f0-9]{64}$/.test(value.nextOwner))
        || (value.entryEnd !== undefined && (!Number.isSafeInteger(value.entryEnd) || value.entryEnd < 0))
        || (enteredHandoff(value) && value.phase !== 'claim' && (value.entryEnd < value.scanCursor
          || (value.boundary !== undefined && value.entryEnd < value.boundary)))
        || (value.phase === 'fallback' && (!/^[a-f0-9]{64}$/.test(value.nextOwner ?? '')
          || !Number.isSafeInteger(value.recoveryFrom) || value.recoveryFrom < 0
          || !Number.isSafeInteger(value.boundary) || value.boundary < value.recoveryFrom))) {
        throw new Error('Invalid transcript guard state');
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const guard = {
      get value() { return value; },
      // Legacy guards have no bounded lifetime. Do not resume their scan;
      // the entry path may quarantine a verified EOF without importing it.
      // A handoff whose prompt already entered its task is bounded without
      // the lifetime: its owner and native bytes are fixed, and the entered
      // task's turn usually outlasts it (rec#16).
      get expired() { return Boolean(value && (!Number.isSafeInteger(value.createdAt) || Date.now() < value.createdAt
        || (!enteredHandoff(value) && Date.now() - value.createdAt >= TRANSCRIPT_GUARD_TTL_MS))); },
      async write(next) {
        if (!active) throw new Error('Transcript guard is no longer owned');
        next = { ...next, createdAt: next.createdAt ?? value?.createdAt ?? Date.now(), updatedAt: Date.now() };
        // Do not yield between the ownership check and this canonical-path
        // mutation: capture expiry can release the lock while an async write
        // is still in flight and overwrite the next holder's guard. The
        // synchronous write and its flush complete before control returns.
        writeTextFileAtomic(path, JSON.stringify(next), { durable: true });
        value = next;
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

// A handoff whose prompt already entered its task (nextOwner, that task's
// token digest): the entry recorded its claim ('claim'), or its capture window
// expired before the old task's tail was flushed and its hook kept entryEnd,
// the native EOF measured after task entry returned and before the hook
// returned (not a snapshot from when the capture started), so that a later
// hook finishes the handoff as the entry would have (rec#16).
export function enteredHandoff(value) {
  return value?.phase === 'claim' || (['scan', 'ready'].includes(value?.phase)
    && Number.isSafeInteger(value.entryEnd) && typeof value.nextOwner === 'string');
}

// Only a busy guard lock is attributed to another Fuli hook; every other guard
// failure stays generic so local diagnostics are never echoed to the host.
export function transcriptGuardFailureMessage(error) {
  return isTranscriptGuardBusy(error)
    ? 'Another Fuli hook for this host session is still running; transcript import was skipped. Preferences and current task context are available.'
    : 'Fuli transcript handoff could not be completed safely; native history was not imported. Preferences and current task context are available.';
}
