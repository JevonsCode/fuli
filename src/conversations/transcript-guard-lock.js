import { constants } from 'node:fs';
import { lstat, mkdir } from 'node:fs/promises';
import { openWithoutFollowing } from '../system/open-without-following.js';
import { createServer } from 'node:net';
import { join } from 'node:path';

export const TRANSCRIPT_GUARD_BUSY = 'FULI_TRANSCRIPT_GUARD_BUSY';

// BSD open(2): take an exclusive flock atomically with the open. Same value on
// macOS, FreeBSD and OpenBSD; Node does not export it in fs.constants.
const O_EXLOCK = 0x20;
const FLOCK_PLATFORMS = new Set(['darwin', 'freebsd', 'openbsd']);

// Cross-process mutex named only by an opaque digest inside a Fuli-owned
// namespace, so unrelated sockets or ports cannot hold it. Every mechanism is
// released by the OS when the holder exits or is killed. Contention therefore
// always means another Fuli guard for the same session and fails closed.
export async function acquireTranscriptGuardLock(lockDirectory, lockKey, platform = process.platform) {
  if (!/^[a-f0-9]{64}$/.test(lockKey)) throw new Error('Invalid transcript guard lock key');
  if (platform === 'win32') return listenExclusive(`\\\\.\\pipe\\fuli-transcript-guard-${lockKey}`);
  // Linux abstract sockets have no file, so a killed holder leaves nothing stale.
  if (platform === 'linux') return listenExclusive(`\0fuli-transcript-guard-${lockKey}`);
  if (FLOCK_PLATFORMS.has(platform)) return lockExclusiveFile(lockDirectory, lockKey);
  throw new Error('Transcript guard locking is unavailable on this platform');
}

export const isTranscriptGuardBusy = error => error?.code === TRANSCRIPT_GUARD_BUSY;

function busy(cause) {
  return Object.assign(new Error('Another Fuli hook holds this session transcript guard'), {
    code: TRANSCRIPT_GUARD_BUSY, cause
  });
}

async function listenExclusive(path) {
  const server = createServer(socket => socket.destroy());
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ path, exclusive: true }, resolve);
    });
  } catch (error) {
    throw error.code === 'EADDRINUSE' ? busy(error) : error;
  }
  return () => new Promise(resolve => server.close(() => resolve()));
}

async function lockExclusiveFile(directory, lockKey) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory()) throw new Error('Transcript guard lock directory is unavailable');
  let handle;
  try {
    handle = await openWithoutFollowing(join(directory, `${lockKey}.lock`),
      constants.O_RDWR | constants.O_CREAT | constants.O_NONBLOCK | O_EXLOCK, 0o600);
  } catch (error) {
    throw ['EAGAIN', 'EWOULDBLOCK'].includes(error.code) ? busy(error) : error;
  }
  return () => handle.close();
}
