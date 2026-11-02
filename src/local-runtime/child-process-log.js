import { chmodSync, closeSync, mkdirSync, openSync, readSync, renameSync, rmSync, statSync, truncateSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

// A detached child (Neo4j, the Graph Provider, the console) writes straight to
// this file and outlives the process that started it. Its size is bounded when
// each child starts and, while it runs, by the console's periodic check
// (boundChildProcessLog): past the limit the file's last part becomes `.1`,
// older copies move up, the oldest is dropped and the file starts over. So no
// file or kept copy grows past the limit (REC #67).
const CHILD_LOG_MAX_BYTES = 50 * 1024 * 1024;
const CHILD_LOG_KEPT_COPIES = 3;
const PRIVATE_FILE_MODE = 0o600;
const COPY_CHUNK_BYTES = 1024 * 1024;
// Another process (an editor, a tail, a child that survived) holds the file
// without sharing deletion: keep appending rather than refuse to start.
const HELD_FILE_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);

/** Opens a child process's log for appending after rotating it when too large. Returns the descriptor. */
export function openChildProcessLog(logPath) {
  mkdirSync(dirname(logPath), { recursive: true });
  boundChildProcessLog(logPath);
  const descriptor = openSync(logPath, 'a', PRIVATE_FILE_MODE);
  keepPrivate(logPath);
  return descriptor;
}

/**
 * Rotates a log past the limit, also while its child is writing to it: the
 * child appends, so its next line lands at the start of the emptied file. A
 * line written between the copy and the emptying is lost. Returns whether it rotated.
 */
export function boundChildProcessLog(logPath) {
  const size = statSync(logPath, { throwIfNoEntry: false })?.size ?? 0;
  if (size <= CHILD_LOG_MAX_BYTES) return false;
  try {
    rmSync(`${logPath}.${CHILD_LOG_KEPT_COPIES}`, { force: true });
    for (let copy = CHILD_LOG_KEPT_COPIES - 1; copy >= 1; copy -= 1) {
      const older = `${logPath}.${copy}`;
      if (statSync(older, { throwIfNoEntry: false })) renameSync(older, `${logPath}.${copy + 1}`);
    }
    copyTail(logPath, `${logPath}.1`, size);
    truncateSync(logPath, 0);
  } catch (error) {
    if (!HELD_FILE_CODES.has(error.code)) throw error;
    return false;
  }
  keepPrivate(logPath);
  return true;
}

/** The kept copies of a log (`.1` to `.3`) that exist, with their sizes. */
export function childLogArchives(logPath) {
  return copyPaths(logPath).flatMap(path => {
    const stat = statSync(path, { throwIfNoEntry: false });
    return stat?.isFile() ? [{ path, bytes: stat.size }] : [];
  });
}

/** Deletes a log's kept copies, never the current file. Returns the bytes freed. */
export function removeChildLogArchives(logPath) {
  let freed = 0;
  for (const { path, bytes } of childLogArchives(logPath)) {
    try {
      rmSync(path, { force: true });
      freed += bytes;
    } catch (error) {
      if (!HELD_FILE_CODES.has(error.code)) throw error;
    }
  }
  return freed;
}

// The last CHILD_LOG_MAX_BYTES of the file, written to a private copy.
function copyTail(source, target, size) {
  const input = openSync(source, 'r');
  let output = null;
  try {
    output = openSync(target, 'w', PRIVATE_FILE_MODE);
    const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
    for (let position = Math.max(0, size - CHILD_LOG_MAX_BYTES); position < size;) {
      const read = readSync(input, buffer, 0, Math.min(COPY_CHUNK_BYTES, size - position), position);
      if (!read) break;
      writeSync(output, buffer, 0, read);
      position += read;
    }
  } finally {
    if (output !== null) closeSync(output);
    closeSync(input);
  }
}

const copyPaths = logPath => Array.from({ length: CHILD_LOG_KEPT_COPIES }, (_, copy) => `${logPath}.${copy + 1}`);

// Logs can hold task details, so only their owner reads them, the current file
// and every kept copy alike (REC #66). Windows keeps the profile's own ACLs.
function keepPrivate(logPath) {
  if (process.platform === 'win32') return;
  for (const path of [logPath, ...copyPaths(logPath)]) {
    if (statSync(path, { throwIfNoEntry: false })) chmodSync(path, PRIVATE_FILE_MODE);
  }
}
