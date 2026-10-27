import { mkdirSync, openSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

// A detached child (Neo4j, the Graph Provider, the console) writes straight to
// this file and outlives the process that started it, so the size is bounded
// when each child starts: a log past the limit becomes `.1`, older copies move
// up, and the oldest is dropped.
const CHILD_LOG_MAX_BYTES = 50 * 1024 * 1024;
const CHILD_LOG_KEPT_COPIES = 3;
// Another process (an editor, a tail, a child that survived) holds the file
// without sharing deletion: keep appending rather than refuse to start.
const HELD_FILE_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);

/** Opens a child process's log for appending after rotating it when too large. Returns the descriptor. */
export function openChildProcessLog(logPath) {
  mkdirSync(dirname(logPath), { recursive: true });
  try {
    rotateWhenFull(logPath);
  } catch (error) {
    if (!HELD_FILE_CODES.has(error.code)) throw error;
  }
  return openSync(logPath, 'a');
}

function rotateWhenFull(logPath) {
  const size = statSync(logPath, { throwIfNoEntry: false })?.size ?? 0;
  if (size <= CHILD_LOG_MAX_BYTES) return;
  rmSync(`${logPath}.${CHILD_LOG_KEPT_COPIES}`, { force: true });
  for (let copy = CHILD_LOG_KEPT_COPIES - 1; copy >= 1; copy -= 1) {
    const older = `${logPath}.${copy}`;
    if (statSync(older, { throwIfNoEntry: false })) renameSync(older, `${logPath}.${copy + 1}`);
  }
  renameSync(logPath, `${logPath}.1`);
}
