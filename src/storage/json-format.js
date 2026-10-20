import { readFileSync } from 'node:fs';

import { newerFormatError, pendingMigrationError } from '../../packages/roundtable/src/storage/data-format-error.js';
import { readJsonFile, writeJsonFileAtomic } from './json-file.js';

// The data format of FULI's JSON files (rec#17 D-09). Each file carries its
// format version, and its reader already refuses a version it does not know.
// A write must not replace a file a newer FULI wrote either: that version is
// above every version this FULI writes, and the overwrite would lose what it
// cannot read. Files without a version predate versioning and stay writable.

const LEDGER_VERSION = 1;

export function assertJsonFormatWritable(filePath, { store, supportedVersion }) {
  if (!Number.isInteger(supportedVersion)) throw new TypeError(`${store} needs a supported format version`);
  let stored;
  try {
    stored = JSON.parse(readFileSync(filePath, 'utf8'))?.version;
  } catch {
    // A missing file has nothing to protect; an unreadable one is the
    // reader's error to report, as before.
    return;
  }
  if (Number.isInteger(stored) && stored > supportedVersion) {
    throw newerFormatError(store, stored, supportedVersion);
  }
}

// supportedVersion: the newest version this FULI writes for the file, when a
// file may also be written at an older version (capture settings write 1 or 2).
export function writeVersionedJsonFileAtomic(filePath, value, { store,
  supportedVersion = value?.version, io } = {}) {
  assertJsonFormatWritable(filePath, { store, supportedVersion });
  writeJsonFileAtomic(filePath, value, io);
}

// A migration this file needs but no automatic step may run: it is recorded
// once in the file's ledger beside it, and the write that needed it refused.
export function refusePendingJsonMigration(filePath, { store, migration, detail, now = () => new Date() }) {
  const ledgerPath = `${filePath}.format-ledger.json`;
  const ledger = readJsonFile(ledgerPath, { version: LEDGER_VERSION, events: [] });
  const latest = ledger.events.findLast((event) => event.migrationId === migration.id);
  if (latest?.status !== 'pending_confirmation' || latest.detail !== detail) {
    writeVersionedJsonFileAtomic(ledgerPath, { version: LEDGER_VERSION, events: [...ledger.events, {
      migrationId: migration.id, fromVersion: migration.from, toVersion: migration.to,
      status: 'pending_confirmation', backupRef: null, detail, recordedAt: now().toISOString()
    }] }, { store: `${store}-ledger` });
  }
  throw pendingMigrationError(store, migration, detail);
}
