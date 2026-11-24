import { createWriteStream } from 'node:fs';
import { rename, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// The longest a native asset download may run; the lifecycle lock's manual release waits several of these.
export const NATIVE_DOWNLOAD_TIMEOUT_MS = 30 * 60_000;

// Downloads `url` to `destination`, resuming a `.partial` left by an earlier
// attempt when the server answers a range request. The caller verifies the
// pinned checksum; nothing here trusts the bytes. `what` names the asset in the
// error, e.g. "Neo4j". signal: the caller's own abort, beside the timeout.
export async function downloadResumable(url, destination, { what, timeoutMs = NATIVE_DOWNLOAD_TIMEOUT_MS, fetchImpl = fetch, signal } = {}) {
  const partial = `${destination}.partial`;
  let existingBytes = 0;
  try { existingBytes = (await stat(partial)).size; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const response = await fetchImpl(url, {
    headers: existingBytes > 0 ? { range: `bytes=${existingBytes}-` } : {},
    signal: signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]) : AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok || !response.body) throw new Error(`${what} download failed with HTTP ${response.status}.`);
  const resumed = existingBytes > 0 && response.status === 206;
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial, { mode: 0o600, flags: resumed ? 'a' : 'w' }));
  await rename(partial, destination);
}
