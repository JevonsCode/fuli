import { lstatSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { newerFormatError, pendingMigrationError } from '../../packages/roundtable/src/storage/data-format-error.js';
import { acquireFileLock } from './file-lock.js';
import { readJsonFile, writeJsonFileAtomic } from './json-file.js';

// The data format of FULI's JSON files (rec#17 D-09). Each store declares, as
// a program constant, the versions this FULI reads and writes (jsonFormat).
// A write never trusts the version of the value it writes: a value claiming a
// version this FULI does not write is refused, and so is replacing a file a
// newer FULI wrote. Reading the file on disk, checking it and replacing it
// happen under one cross-process lock per directory, so another FULI writer
// cannot slip a newer file in between. Files without a version predate
// versioning and stay writable.

const LEDGER_FORMAT_VERSION = 1;
const LOCK_FILE = '.fuli-format.lock';
const LOCK_WAIT_MS = 5000;

// versions: what this FULI reads and writes. pendingFrom: an older version it
// still reads whose rewrite waits for a person; migration names that step.
export function jsonFormat({ store, versions, pendingFrom = null, migration = null }) {
  if (!/^[a-z][a-z0-9-]*$/.test(store)) throw new TypeError(`Invalid store id ${store}`);
  if (!versions.length || !versions.every(Number.isInteger)) throw new TypeError(`${store} needs its format versions`);
  if ((pendingFrom === null) !== (migration === null)) throw new TypeError(`${store} pending step needs its migration`);
  return Object.freeze({ store, versions: Object.freeze([...versions]), supported: Math.max(...versions),
    pendingFrom, migration });
}

// Refuses a document version this FULI does not read and write, before any
// side effect that would act on it.
export function requireJsonFormatVersion(document, format) {
  const version = document?.version;
  if (format.versions.includes(version)) return;
  if (Number.isInteger(version) && version > format.supported) {
    throw newerFormatError(format.store, version, format.supported);
  }
  throw new TypeError(`${format.store} uses format version ${version}; this FULI reads and writes `
    + `${format.versions.join(' or ')}`);
}

export function assertJsonFormatWritable(filePath, format) {
  let stored;
  try {
    stored = JSON.parse(readFileSync(filePath, 'utf8'))?.version;
  } catch {
    // A missing file has nothing to protect; an unreadable one is the
    // reader's error to report, as before.
    return;
  }
  if (Number.isInteger(stored) && stored > format.supported) {
    throw newerFormatError(format.store, stored, format.supported);
  }
}

export function writeVersionedJsonFileAtomic(filePath, value, format, { io } = {}) {
  requireJsonFormatVersion(value, format ?? {});
  // Nothing of the current file is used, so an unreadable one is replaced as before.
  updateVersionedJsonFileAtomic(filePath, format, () => value, { io, read: () => null });
}

// A read-modify-write of one file under the directory lock, taken once: the
// latest file is read inside the lock, so a change another process saved
// meanwhile is never overwritten from an older snapshot. mutate(current)
// gets the parsed file (null when missing) and returns the new value, or
// undefined to leave the file as it is. read(filePath) may replace the
// default strict parse; write(filePath, value) the plain atomic write.
export function updateVersionedJsonFileAtomic(filePath, format, mutate, {
  io, read = readCurrentJson, write = (path, value) => writeJsonFileAtomic(path, value, { io })
} = {}) {
  if (!format?.versions) throw new TypeError('A versioned JSON write needs its store format');
  return withJsonFormatLock(filePath, () => {
    assertJsonFormatWritable(filePath, format);
    const current = read(filePath);
    const next = mutate(current);
    if (next === undefined) return current;
    requireJsonFormatVersion(next, format);
    write(filePath, next);
    return next;
  });
}

// Removes a file under the same lock, after checking again that no newer
// FULI wrote it; a newer file is refused like a write would be.
export function removeVersionedJsonFileAtomic(filePath, format) {
  if (!format?.versions) throw new TypeError('A versioned JSON removal needs its store format');
  // No file, nothing to protect or remove: no lock is needed, and its
  // directory may not even exist or be creatable. Only "does not exist"
  // means absent; a file that cannot be checked (EACCES, EIO…) may exist and
  // must not be taken for gone, so that error is the caller's.
  if (!fileExists(filePath)) return;
  withJsonFormatLock(filePath, () => {
    assertJsonFormatWritable(filePath, format);
    rmSync(filePath, { force: true });
  });
}

const ABSENT = new Set(['ENOENT', 'ENOTDIR']);

function fileExists(filePath) {
  try {
    lstatSync(filePath);
    return true;
  } catch (error) {
    if (ABSENT.has(error?.code)) return false;
    throw error;
  }
}

function readCurrentJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

// One lock per directory, shared by every versioned file in it.
function withJsonFormatLock(filePath, operation) {
  const release = acquireFileLock(join(dirname(filePath), LOCK_FILE), { waitMs: LOCK_WAIT_MS });
  try { return operation(); } finally { release(); }
}

const LEDGER_FORMAT = jsonFormat({ store: 'json-format-ledger', versions: [LEDGER_FORMAT_VERSION] });

// A migration this file needs but no automatic step may run: it is recorded
// once in the file's ledger beside it, and the write that needed it refused.
export function refusePendingJsonMigration(filePath, { format, detail, now = () => new Date() }) {
  const { migration } = format;
  const ledgerPath = `${filePath}.format-ledger.json`;
  const ledger = readJsonFile(ledgerPath, { version: LEDGER_FORMAT_VERSION, events: [] });
  const latest = ledger.events.findLast((event) => event.migrationId === migration.id);
  if (latest?.status !== 'pending_confirmation' || latest.detail !== detail) {
    writeVersionedJsonFileAtomic(ledgerPath, { version: LEDGER_FORMAT_VERSION, events: [...ledger.events, {
      migrationId: migration.id, fromVersion: migration.from, toVersion: migration.to,
      status: 'pending_confirmation', backupRef: null, detail, recordedAt: now().toISOString()
    }] }, LEDGER_FORMAT);
  }
  throw pendingMigrationError(format.store, migration, detail);
}

// A JSON data file as `fuli migrate status` reports it, read only.
export function inspectJsonStore(filePath, format) {
  const report = { store: format.store, kind: 'json', target: format.supported, version: null,
    ledger: ledgerEvents(filePath), steps: [] };
  let document;
  try {
    document = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return { ...report, state: 'absent' };
    if (error instanceof SyntaxError) return { ...report, state: 'unreadable', note: 'not valid JSON' };
    return { ...report, state: 'unavailable', note: `cannot be read (${error.code ?? error.message})` };
  }
  const version = document?.version;
  if (!Number.isInteger(version)) return { ...report, state: 'unversioned', note: 'written before versioning' };
  if (version > format.supported) return { ...report, version, state: 'newer_format' };
  if (version === format.pendingFrom) {
    return { ...report, version, state: 'pending_confirmation',
      steps: [{ id: format.migration.id, state: 'pending_confirmation', detail: format.migration.summary }] };
  }
  return { ...report, version, state: format.versions.includes(version) ? 'current' : 'unsupported' };
}

function ledgerEvents(filePath) {
  try {
    return readJsonFile(`${filePath}.format-ledger.json`, { events: [] }).events ?? [];
  } catch {
    return [{ status: 'unreadable', detail: 'the format ledger beside this file is not valid JSON' }];
  }
}
