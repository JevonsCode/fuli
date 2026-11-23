import { chmod, lstat, mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { sha256File } from '../security/digest.js';
import { downloadResumable } from '../native-runtime/resumable-download.js';

// One executable is about 7 MB; a stalled download gives up well before the
// next person-facing retry, and a lock older than that is a crashed download.
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
// How often a process waiting for another one's download looks again.
const LOCK_POLL_MS = 250;

// Where a downloaded copy of a pinned asset lives in the managed runtime:
// <nativeRuntimeDir>/agent-kits/<component>-<version>/<asset name>.
export function downloadedExecutablePath(nativeRuntimeDir, asset) {
  return join(nativeRuntimeDir, 'agent-kits', `${asset.component}-${asset.version}`, asset.name);
}

// Downloads the pinned asset, verifies its SHA-256 and only then publishes it
// under its final name, the same way the macOS Neo4j archive is installed. A
// copy that fails verification is deleted and refused. While another process
// downloads the same asset this one waits for it and uses its verified copy;
// it downloads itself only when that one ends without a copy, or its lock is
// older than any download may take (a crashed process).
export async function downloadPinnedExecutable(nativeRuntimeDir, asset, {
  download = (url, destination) => downloadResumable(url, destination, { what: asset.name, timeoutMs: DOWNLOAD_TIMEOUT_MS }),
  now = Date.now,
  wait = () => delay(LOCK_POLL_MS)
} = {}) {
  const destination = downloadedExecutablePath(nativeRuntimeDir, asset);
  const directory = join(destination, '..');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory()) throw new Error('The agent kit directory must not be a symbolic link.');
  const lock = `${destination}.lock`;
  while (!(await takeLock(lock, now))) await wait();
  const staged = `${destination}.download`;
  try {
    // Another process published it while this one waited for the lock.
    if (await isPublished(destination, asset)) return destination;
    await download(asset.url, staged);
    if (await sha256File(staged) !== asset.sha256) {
      throw new Error(`The downloaded ${asset.name} failed checksum verification.`);
    }
    if (process.platform !== 'win32') await chmod(staged, 0o755);
    await rename(staged, destination);
    return destination;
  } finally {
    await rm(staged, { force: true });
    await rm(lock, { recursive: true, force: true });
  }
}

// True once this process holds the lock; false while another process's
// download is still within its time.
async function takeLock(lock, now) {
  if (await createLock(lock)) return true;
  let held;
  try { held = await stat(lock); } catch (error) { if (error.code === 'ENOENT') return createLock(lock); throw error; }
  if (now() - held.mtimeMs < DOWNLOAD_TIMEOUT_MS) return false;
  await rm(lock, { recursive: true, force: true });
  return createLock(lock);
}

async function createLock(lock) {
  try { await mkdir(lock, { mode: 0o700 }); return true; } catch (error) { if (error.code !== 'EEXIST') throw error; return false; }
}

async function isPublished(destination, asset) {
  try { return (await stat(destination)).isFile() && await sha256File(destination) === asset.sha256; } catch { return false; }
}
