import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { DataFormatError } from '../../packages/roundtable/src/storage/data-format-error.js';

// Whole-store maintenance of one data directory (rec#17 D-09 part 2): a
// whole-store restore holds it exclusively, from before it asks the person
// until it is done; the console holds it shared for as long as it runs, and
// `fuli migrate apply/rollback/prune` while they work. So a console cannot
// start while a restore waits for its answer, and a restore cannot begin
// while a console runs. An OS-backed SQLite lock on a file with no data:
// shared = a read transaction kept open, exclusive = BEGIN EXCLUSIVE, both
// released by the OS when the holder exits. Writers in processes the
// console does not manage (MCP servers) are kept out by each store's own
// lock during the swap itself (database-migration.js, json-format-migration.js).

const LOCK_FILE = '.fuli-maintenance.lock';

function open(dataDir) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const path = join(dataDir, LOCK_FILE);
  const database = new DatabaseSync(path);
  try {
    chmodSync(path, 0o600);
    database.exec('PRAGMA busy_timeout = 0');
    database.exec('PRAGMA journal_mode = DELETE');
    database.exec('CREATE TABLE IF NOT EXISTS maintenance(holder TEXT)');
  } catch (error) {
    database.close();
    throw busy(error) ?? error;
  }
  return database;
}

function busy(error) {
  if (error?.errcode !== 5 && error?.errcode !== 6) return null;
  return new DataFormatError('data-format', 'data_format_maintenance', 'A whole-store restore (fuli migrate restore) '
    + 'is working on this FULI data, or FULI is running while one was asked for. Nothing was changed; try again '
    + 'once it has finished, or stop FULI first.');
}

// Held while FULI or a migration works on the data directory; many at once.
export function holdDataDirectory(dataDir) {
  const database = open(dataDir);
  try {
    database.exec('BEGIN');
    database.prepare('SELECT count(*) AS holders FROM maintenance').get();
  } catch (error) {
    database.close();
    throw busy(error) ?? error;
  }
  return () => {
    try { database.exec('ROLLBACK'); } finally { database.close(); }
  };
}

// Held by a whole-store restore alone; refused while anything holds it shared.
export function acquireMaintenance(dataDir) {
  const database = open(dataDir);
  try {
    database.exec('BEGIN EXCLUSIVE');
  } catch (error) {
    database.close();
    throw busy(error) ?? error;
  }
  return () => {
    try { database.exec('ROLLBACK'); } finally { database.close(); }
  };
}
