import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { acquireTranscriptGuardLock, isTranscriptGuardBusy } from './transcript-guard-lock.js';

export const transcriptDigest = value => createHash('sha256').update(value).digest('hex');

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
    let value = null;
    try {
      if (!(await lstat(path)).isFile()) throw new Error('Invalid transcript guard');
      value = JSON.parse(await readFile(path, 'utf8'));
      if (value.version !== 1 || !['scan', 'ready', 'beginning', 'claim'].includes(value.phase)
        || !/^[a-f0-9]{64}$/.test(value.owner ?? '') || !/^[a-f0-9]{64}$/.test(value.prompt ?? '')
        || !Number.isSafeInteger(value.scanCursor) || value.scanCursor < 0
        || (value.boundary !== undefined && (!Number.isSafeInteger(value.boundary) || value.boundary < 0))) {
        throw new Error('Invalid transcript guard state');
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const guard = {
      get value() { return value; },
      async write(next) {
        const temporary = `${path}.${randomUUID()}`;
        try {
          const file = await open(temporary, 'wx', 0o600);
          try { await file.writeFile(JSON.stringify(next)); await file.sync(); }
          finally { await file.close(); }
          await rename(temporary, path);
          value = next;
        } finally { await rm(temporary, { force: true }); }
      },
      async clear() { await rm(path, { force: true }); value = null; }
    };
    return await operation(guard);
  } finally { await release(); }
}

// Only a busy guard lock is attributed to another Fuli hook; every other guard
// failure stays generic so local diagnostics are never echoed to the host.
export function transcriptGuardFailureMessage(error) {
  return isTranscriptGuardBusy(error)
    ? 'Another Fuli hook for this host session is still running, so this prompt was not linked to an Agent. Retry after it finishes; if it persists, start a new host session and resume the intended Agent.'
    : 'Fuli transcript handoff could not be completed safely. Retry task entry; no previous Agent context was supplied.';
}
