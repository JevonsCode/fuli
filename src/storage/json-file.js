import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

// Windows refuses to rename over a file another process has open, even for a
// moment: a console request reading it while setup replaces it fails with
// EPERM, EACCES or EBUSY. Readers close the file promptly, so the rename is
// retried with a growing pause for about two seconds before the error is
// surfaced. Other systems replace an open file, so there these codes are
// persistent and only reach the caller after the same bounded wait.
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_RETRY_FIRST_PAUSE_MS = 5;
const RENAME_RETRY_MAX_PAUSE_MS = 200;
const RENAME_RETRY_BUDGET_MS = 2000;

const DEFAULT_IO = Object.freeze({
  closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeFileSync, pauseSync
});

export function readJsonFile(filePath, fallback) {
  if (!existsSync(filePath)) return fallback;

  const raw = readFileSync(filePath, 'utf8');
  return raw.trim() ? JSON.parse(raw) : fallback;
}

export function writeJsonFileAtomic(filePath, value, options = {}) {
  writeTextFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`, options);
}

// Replaces a file through a temporary sibling so readers never see a partial
// write. An existing file keeps its permissions; a new one is private.
// durable: the temporary file reaches the disk (fsync) before it replaces the
// target, for state that must survive a crash right after the write.
// beforeReplace: validates the target immediately before every rename attempt,
// including retries. A failed validation aborts without replacing the target.
// io: replaces file-system calls, for tests.
export function writeTextFileAtomic(filePath, text, { durable = false, beforeReplace, io = {} } = {}) {
  const fileIo = { ...DEFAULT_IO, ...io };
  const directory = dirname(filePath);
  const tempPath = join(directory, `.${basename(filePath)}.${randomUUID()}.tmp`);
  let mode = 0o600;
  try {
    mode = fileIo.statSync(filePath).mode & 0o777;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  fileIo.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    if (durable) writeDurably(tempPath, text, mode, fileIo);
    else fileIo.writeFileSync(tempPath, text, { encoding: 'utf8', flag: 'wx', mode });
    replaceWithRetry(tempPath, filePath, fileIo, beforeReplace);
  } catch (error) {
    try {
      fileIo.rmSync(tempPath, { force: true });
    } catch {
      // Preserve the write or rename failure that caused cleanup.
    }
    throw error;
  }
}

function writeDurably(tempPath, text, mode, fileIo) {
  const descriptor = fileIo.openSync(tempPath, 'wx', mode);
  try {
    fileIo.writeFileSync(descriptor, text, 'utf8');
    fileIo.fsyncSync(descriptor);
  } finally {
    fileIo.closeSync(descriptor);
  }
}

// The temporary file stays complete and the target untouched until one rename
// succeeds, so retrying keeps the write atomic, inside the caller's lock.
function replaceWithRetry(tempPath, filePath, fileIo, beforeReplace) {
  let waited = 0;
  for (let pause = RENAME_RETRY_FIRST_PAUSE_MS; ; pause = Math.min(pause * 2, RENAME_RETRY_MAX_PAUSE_MS)) {
    beforeReplace?.();
    try {
      fileIo.renameSync(tempPath, filePath);
      return;
    } catch (error) {
      if (!RENAME_RETRY_CODES.has(error?.code) || waited >= RENAME_RETRY_BUDGET_MS) throw error;
    }
    fileIo.pauseSync(pause);
    waited += pause;
  }
}

function pauseSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
