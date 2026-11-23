import { chmod, lstat, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { sha256File } from '../security/digest.js';
import { downloadResumable } from '../native-runtime/resumable-download.js';
import { acquireDownloadLock } from './executable-download-lock.js';

// One executable is about 7 MB; a stalled download gives up well before the
// next person-facing retry.
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
// A lock older than its download may take, plus the checksum and the rename,
// is a crashed or hung process's whose end FULI could not see.
const LOCK_ABANDONED_MS = DOWNLOAD_TIMEOUT_MS + 60_000;
// How often a process waiting for another one's download looks again.
const LOCK_POLL_MS = 250;

// Where a downloaded copy of a pinned asset lives in the managed runtime:
// <nativeRuntimeDir>/agent-kits/<component>-<version>/<asset name>.
export function downloadedExecutablePath(nativeRuntimeDir, asset) {
  return join(nativeRuntimeDir, 'agent-kits', `${asset.component}-${asset.version}`, asset.name);
}

// Downloads the pinned asset, verifies its SHA-256 and only then publishes it
// under its final name, the same way the macOS Neo4j archive is installed. A
// copy that fails verification is deleted and refused; a published copy that
// no longer matches is moved aside (`.unverified-*`) and downloaded again.
//
// One process downloads at a time (executable-download-lock.js). While
// another one does, this one calls onWait() once and waits for it, then uses
// its verified copy; with waitForOthers false it throws at once instead (code
// 'other_download'). It takes over the lock of a process that has ended, or
// one older than any download may take. Each process writes its own staging
// file, so even two holders never write the same file. signal aborts the wait
// and the download.
export async function downloadPinnedExecutable(nativeRuntimeDir, asset, {
  download = (url, destination, signal) => downloadResumable(url, destination,
    { what: asset.name, timeoutMs: DOWNLOAD_TIMEOUT_MS, signal }),
  now = Date.now,
  wait = (signal) => delay(LOCK_POLL_MS, undefined, { signal }),
  signal,
  onWait,
  waitForOthers = true,
  identity,
  identify
} = {}) {
  const destination = downloadedExecutablePath(nativeRuntimeDir, asset);
  const directory = join(destination, '..');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory()) throw new Error('The agent kit directory must not be a symbolic link.');
  const lock = await acquireDownloadLock(`${destination}.lock`, { abandonedAfterMs: LOCK_ABANDONED_MS, now, wait, signal,
    onWait, waitForOthers, ...(identity ? { identity } : {}), ...(identify ? { identify } : {}) });
  if (!lock) throw Object.assign(new Error(`Another FULI is downloading ${asset.name}.`), { code: 'other_download' });
  const staged = `${destination}.download-${lock.token}`;
  try {
    await removeAbandonedStaging(directory, asset.name, now(), LOCK_ABANDONED_MS);
    // Another process published it while this one waited for the lock.
    if (await isPublished(destination, asset)) return destination;
    await moveAsideUnverified(destination, now());
    await download(asset.url, staged, signal);
    if (await sha256File(staged) !== asset.sha256) {
      throw new Error(`The downloaded ${asset.name} failed checksum verification.`);
    }
    if (process.platform !== 'win32') await chmod(staged, 0o755);
    await rename(staged, destination);
    return destination;
  } finally {
    await rm(staged, { force: true });
    await rm(`${staged}.partial`, { force: true });
    await lock.release();
  }
}

async function isPublished(destination, asset) {
  try { return (await stat(destination)).isFile() && await sha256File(destination) === asset.sha256; } catch { return false; }
}

// A published copy that fails its pin is kept for inspection, never deleted.
async function moveAsideUnverified(destination, at) {
  try { await rename(destination, `${destination}.unverified-${at}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

// The staging files of processes killed mid-download, once older than any download may take.
async function removeAbandonedStaging(directory, name, at, abandonedAfterMs) {
  let names;
  try { names = await readdir(directory); } catch { return; }
  for (const entry of names.filter((candidate) => candidate.startsWith(`${name}.download-`))) {
    try { if (at - (await lstat(join(directory, entry))).mtimeMs >= abandonedAfterMs) await rm(join(directory, entry), { force: true }); }
    catch { /* gone already */ }
  }
}
