import { chmod, lstat, mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { sha256File } from '../security/digest.js';
import { downloadResumable } from '../native-runtime/resumable-download.js';

// One executable is about 7 MB; a stalled download gives up well before the
// next person-facing retry, and a lock older than that is a crashed download.
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

// Where a downloaded copy of a pinned asset lives in the managed runtime:
// <nativeRuntimeDir>/agent-kits/<component>-<version>/<asset name>.
export function downloadedExecutablePath(nativeRuntimeDir, asset) {
  return join(nativeRuntimeDir, 'agent-kits', `${asset.component}-${asset.version}`, asset.name);
}

// Downloads the pinned asset, verifies its SHA-256 and only then publishes it
// under its final name, the same way the macOS Neo4j archive is installed. A
// copy that fails verification is deleted and refused. Another process
// downloading the same asset makes this one fail instead of waiting.
export async function downloadPinnedExecutable(nativeRuntimeDir, asset, {
  download = (url, destination) => downloadResumable(url, destination, { what: asset.name, timeoutMs: DOWNLOAD_TIMEOUT_MS }),
  now = Date.now
} = {}) {
  const destination = downloadedExecutablePath(nativeRuntimeDir, asset);
  const directory = join(destination, '..');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory()) throw new Error('The agent kit directory must not be a symbolic link.');
  const lock = `${destination}.lock`;
  await takeLock(lock, now);
  const staged = `${destination}.download`;
  try {
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

async function takeLock(lock, now) {
  try { await mkdir(lock, { mode: 0o700 }); return; } catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (now() - (await stat(lock)).mtimeMs < DOWNLOAD_TIMEOUT_MS) {
    throw new Error('Another FULI process is downloading this component.');
  }
  await rm(lock, { recursive: true, force: true });
  await mkdir(lock, { mode: 0o700 });
}
