import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createServer } from 'node:net';

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
  // A loopback mutex is released by the OS even if the process is killed.
  // Port collisions fail closed and request a retry; no transcript is served.
  const lock = createServer(socket => socket.destroy());
  const lockKey = transcriptDigest(`${directory}\0${key}`);
  const port = 49152 + (parseInt(lockKey.slice(0, 8), 16) % 16384);
  await new Promise((resolve, reject) => {
    lock.once('error', reject);
    lock.listen({ host: '127.0.0.1', port, exclusive: true }, resolve);
  });
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
  } finally { await new Promise(resolve => lock.close(resolve)); }
}
