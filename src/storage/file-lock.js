import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// A cross-process lock on one lock file: an OS-backed SQLite reservation
// (BEGIN IMMEDIATE) that console, MCP and CLI processes all honour and that
// the OS releases when its holder exits. The lock file holds no data.
// waitMs: how long to wait for another holder; 0 fails at once.
export function acquireFileLock(lockPath, { waitMs = 0 } = {}) {
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const lock = new DatabaseSync(lockPath);
  try {
    chmodSync(lockPath, 0o600);
    lock.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(waitMs))}`);
    lock.exec('BEGIN IMMEDIATE');
  } catch (error) {
    lock.close();
    if (error.errcode === 5 || error.errcode === 6) {
      throw Object.assign(new Error('Another FULI process holds this lock'), { code: 'file_lock_busy', cause: error });
    }
    throw error;
  }
  return () => {
    try { lock.exec('ROLLBACK'); } finally { lock.close(); }
  };
}
