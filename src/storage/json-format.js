import { lstatSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { contentHash } from '../../packages/roundtable/src/canonical-json.js';
import {
  DataFormatError, newerFormatError, pendingMigrationError
} from '../../packages/roundtable/src/storage/data-format-error.js';
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
// still reads whose rewrite waits for a person; migration names that step,
// rewrite(document) is the step a person confirms and recordIds(document)
// names, without content, the records it changes.
export function jsonFormat({ store, versions, pendingFrom = null, migration = null }) {
  if (!/^[a-z][a-z0-9-]*$/.test(store)) throw new TypeError(`Invalid store id ${store}`);
  if (!versions.length || !versions.every(Number.isInteger)) throw new TypeError(`${store} needs its format versions`);
  if ((pendingFrom === null) !== (migration === null)) throw new TypeError(`${store} pending step needs its migration`);
  if (migration && !(typeof migration.rewrite === 'function' && typeof migration.recordIds === 'function')) {
    throw new TypeError(`${migration.id} must rewrite the document and name the records it changes`);
  }
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

const UNREADABLE_RECORD = Object.freeze({ status: 'unreadable' });

// A small state record (a first-run question, a guide): null when there is
// none, `{ status: 'unreadable' }` for a file this FULI cannot read or does
// not write, so a caller treats it as neither missing nor any known state.
export function readJsonRecord(filePath, format) {
  try {
    const record = readJsonFile(filePath, null);
    return record === null || format.versions.includes(record?.version) ? record : UNREADABLE_RECORD;
  } catch {
    return UNREADABLE_RECORD;
  }
}

// Returns the version on disk (undefined when there is none to protect).
export function assertJsonFormatWritable(filePath, format) {
  let stored;
  try {
    stored = JSON.parse(readFileSync(filePath, 'utf8'))?.version;
  } catch {
    // A missing file has nothing to protect; an unreadable one is the
    // reader's error to report, as before.
    return undefined;
  }
  if (Number.isInteger(stored) && stored > format.supported) {
    throw newerFormatError(format.store, stored, format.supported);
  }
  return stored;
}

export function writeVersionedJsonFileAtomic(filePath, value, format, { io, durable = false } = {}) {
  requireJsonFormatVersion(value, format ?? {});
  // Nothing of the current file is used, so an unreadable one is replaced as before.
  updateVersionedJsonFileAtomic(filePath, format, () => value, { io, durable, read: () => null });
}

// A read-modify-write of one file under the directory lock, taken once: the
// latest file is read inside the lock, so a change another process saved
// meanwhile is never overwritten from an older snapshot. mutate(current)
// gets the parsed file (null when missing) and returns the new value, or
// undefined to leave the file as it is. read(filePath) may replace the
// default strict parse; write(filePath, value) the plain atomic write. durable
// fsyncs the default write before replacement; a custom writer owns its own durability.
export function updateVersionedJsonFileAtomic(filePath, format, mutate, {
  io, durable = false, read = readCurrentJson, write = (path, value) => writeJsonFileAtomic(path, value, { io, durable })
} = {}) {
  if (!format?.versions) throw new TypeError('A versioned JSON write needs its store format');
  return withJsonFormatLock(filePath, () => {
    resolveInterruptedChange(filePath, format);
    const onDisk = assertJsonFormatWritable(filePath, format);
    const current = read(filePath);
    const next = mutate(current);
    if (next === undefined) return current;
    requireJsonFormatVersion(next, format);
    refuseCrossingPendingStep(format, onDisk, next.version);
    write(filePath, next);
    return next;
  });
}

// A file at the version a confirmed step starts from (written by an earlier
// FULI, or put back by undoing that step) changes version only through that
// step. An ordinary write computed from an older read (say, before another
// process undid the step) is refused here, inside the lock, instead of
// silently redoing the migration nobody confirmed.
function refuseCrossingPendingStep(format, onDisk, written) {
  if (format.pendingFrom === null || onDisk !== format.pendingFrom || written === onDisk) return;
  throw pendingMigrationError(format.store, format.migration, `the file is at version ${onDisk} and an ordinary `
    + `write would make it ${written}`);
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
    resolveInterruptedChange(filePath, format);
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

// Several versioned files of one directory changed under one hold of its
// lock (a confirmed migration writes the file and its ledger). operation
// gets write(path, value, format) and remove(path, format), each checking the
// file on disk again; paths outside the directory are refused. With format,
// an interrupted change of filePath is resolved first (resolution is passed
// on). allowConflict lets a whole-file restore run over one that cannot be
// resolved: the conflicting intent stays in place, guarding the file, until
// the restore's own intent replaces it (resolution 'conflict', intent).
export function withJsonFormatDirectory(filePath, operation, { format = null, allowConflict = false } = {}) {
  const directory = dirname(filePath);
  const inside = (path) => {
    if (dirname(path) !== directory) throw new TypeError('A locked JSON change stays in its directory');
  };
  return withJsonFormatLock(filePath, () => {
    const resolution = format ? resolveInterruptedChange(filePath, format, { allowConflict }) : null;
    return operation({
      write(path, value, fileFormat) {
        inside(path);
        lockedWrite(path, value, fileFormat);
      },
      remove(path, fileFormat) {
        inside(path);
        assertJsonFormatWritable(path, fileFormat);
        rmSync(path, { force: true });
      },
      resolution,
      intent: resolution === 'conflict' ? readJsonIntent(filePath) : null
    });
  });
}

function lockedWrite(path, value, format) {
  assertJsonFormatWritable(path, format);
  requireJsonFormatVersion(value, format);
  writeJsonFileAtomic(path, value);
}

// An interrupted confirmed change (json-format-migration.js) is an intent
// record beside the file: the backup, the file's digest before and after,
// and the ledger event that commits it. Every writer of the file resolves it
// first, inside the directory lock, so no ordinary write can turn a
// resolvable intent into one that matches neither side:
// - the file is as the change left it: the ledger event is committed (once);
// - the file is as it was: the intent is dropped;
// - anything else is refused until a whole-file restore settles it. The
//   restore's intent carries the conflicting one (settles): if the restore
//   is interrupted before it wrote the file, the conflicting intent is put
//   back rather than dropped, so the file stays guarded.
const INTENT_VERSION = 1;
export const JSON_INTENT_FORMAT = jsonFormat({ store: 'json-format-intent', versions: [INTENT_VERSION] });

export function jsonIntentPath(filePath) {
  return `${filePath}.format-intent.json`;
}

export function readJsonIntent(filePath) {
  try {
    return JSON.parse(readFileSync(jsonIntentPath(filePath), 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

// null, 'completed', 'dropped' or 'conflict': what resolving would leave,
// read only. A restore's intent that never wrote the file puts back the
// conflict it was settling, so that nested intent decides.
export function jsonIntentResolution(filePath) {
  const intent = readJsonIntent(filePath);
  if (!intent) return null;
  const current = readCurrentJson(filePath);
  const digest = current ? contentHash(current) : null;
  let effective = intent;
  while (effective.settles && topResolution(effective, digest) === 'dropped') effective = effective.settles;
  return topResolution(effective, digest);
}

function topResolution(intent, digest) {
  if (digest === intent.afterDigest) return 'completed';
  return digest === intent.beforeDigest ? 'dropped' : 'conflict';
}

function resolveInterruptedChange(filePath, format, { allowConflict = false } = {}) {
  const intent = readJsonIntent(filePath);
  if (!intent) return null;
  assertJsonFormatWritable(jsonIntentPath(filePath), JSON_INTENT_FORMAT);
  const current = readCurrentJson(filePath);
  const resolution = topResolution(intent, current ? contentHash(current) : null);
  if (resolution === 'completed') {
    const committed = jsonLedgerEvents(filePath).some((event) => event.status === intent.event.status
      && event.migrationId === intent.event.migrationId && event.recordedAt === intent.event.recordedAt);
    if (!committed) appendJsonLedgerEvent(lockedWrite, filePath, intent.event);
  } else if (resolution === 'dropped' && intent.settles) {
    // A restore that never wrote the file: the conflict it was settling is back.
    lockedWrite(jsonIntentPath(filePath), intent.settles, JSON_INTENT_FORMAT);
    return resolveInterruptedChange(filePath, format, { allowConflict });
  } else if (resolution === 'conflict') {
    if (allowConflict) return 'conflict';
    throw new DataFormatError(format.store, 'data_format_interrupted', `FULI store "${format.store}" has an `
      + `interrupted ${intent.operation} (${intent.event?.migrationId}) and the file is neither as it was nor as `
      + 'that change left it. Nothing was written; restore the whole file (Settings → Data format migrations) from '
      + `${intent.backupRef ?? 'a backup'} or another backup.`, intent.event?.migrationId ? [intent.event.migrationId] : []);
  }
  rmSync(jsonIntentPath(filePath), { force: true });
  return resolution;
}

const LEDGER_FORMAT = jsonFormat({ store: 'json-format-ledger', versions: [LEDGER_FORMAT_VERSION] });

// A migration this file needs but no automatic step may run: it is recorded
// once in the file's ledger beside it, and the write that needed it refused.
// Everything under the directory lock: the file is read again (a confirmed
// apply may have moved it on since the caller looked: then nothing is
// recorded and false is returned, so the caller reads again), and the ledger
// is read and appended to in the same hold, never written back from a
// snapshot read outside it.
export function refusePendingJsonMigration(filePath, { format, detail, now = () => new Date() }) {
  const { migration } = format;
  const stillPending = withJsonFormatLock(filePath, () => {
    resolveInterruptedChange(filePath, format);
    if (readCurrentJson(filePath)?.version !== format.pendingFrom) return false;
    const latest = jsonLedgerEvents(filePath).findLast((event) => event.migrationId === migration.id);
    if (latest?.status !== 'pending_confirmation' || latest.detail !== detail) {
      appendJsonLedgerEvent(lockedWrite, filePath, { migrationId: migration.id, fromVersion: migration.from,
        toVersion: migration.to, status: 'pending_confirmation', backupRef: null, detail,
        recordedAt: now().toISOString() });
    }
    return true;
  });
  if (!stillPending) return false;
  throw pendingMigrationError(format.store, migration, detail);
}

// A JSON data file as `fuli migrate status` reports it, read only.
export function inspectJsonStore(filePath, format) {
  const report = { store: format.store, kind: 'json', target: format.supported, version: null,
    ledger: jsonLedgerEvents(filePath), steps: [] };
  let document;
  try {
    document = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return { ...report, state: 'absent' };
    if (error instanceof SyntaxError) return { ...report, state: 'unreadable', note: 'not valid JSON' };
    return { ...report, state: 'unavailable', note: `cannot be read (${error.code ?? error.message})` };
  }
  const version = document?.version;
  const interrupted = jsonIntentResolution(filePath);
  if (interrupted === 'conflict') {
    const intent = readJsonIntent(filePath);
    const conflicting = intent.settles && topResolution(intent, contentHash(document)) === 'dropped' ? intent.settles : intent;
    return { ...report, version: version ?? null, state: 'half_applied',
      steps: [{ id: conflicting.event?.migrationId ?? `${format.store}/unknown`, state: 'half_applied',
        detail: 'an interrupted change left the file neither as it was nor as it would have left it' }] };
  }
  if (interrupted) {
    report.note = `an interrupted change is ${interrupted === 'completed' ? 'committed' : 'dropped'} by the next write`;
  }
  if (!Number.isInteger(version)) return { ...report, state: 'unversioned', note: 'written before versioning' };
  if (version > format.supported) return { ...report, version, state: 'newer_format' };
  if (version === format.pendingFrom) {
    return { ...report, version, state: 'pending_confirmation',
      steps: [{ id: format.migration.id, state: 'pending_confirmation', detail: format.migration.summary }] };
  }
  return { ...report, version, state: format.versions.includes(version) ? 'current' : 'unsupported' };
}

function jsonLedgerPath(filePath) {
  return `${filePath}.format-ledger.json`;
}

// Refuses a ledger this FULI cannot extend (a newer version, or not JSON)
// before anything that would need to append to it.
export function assertJsonLedgerWritable(filePath) {
  assertJsonFormatWritable(jsonLedgerPath(filePath), LEDGER_FORMAT);
  readJsonFile(jsonLedgerPath(filePath), { events: [] });
}

// Appends one event to a file's format ledger, with the writer of
// withJsonFormatDirectory, so it lands under the same hold of the lock.
export function appendJsonLedgerEvent(write, filePath, event) {
  const ledgerPath = jsonLedgerPath(filePath);
  const ledger = readJsonFile(ledgerPath, { version: LEDGER_FORMAT_VERSION, events: [] });
  write(ledgerPath, { version: LEDGER_FORMAT_VERSION, events: [...ledger.events, event] }, LEDGER_FORMAT);
}

export function jsonLedgerEvents(filePath) {
  try {
    return readJsonFile(jsonLedgerPath(filePath), { events: [] }).events ?? [];
  } catch {
    return [{ status: 'unreadable', detail: 'the format ledger beside this file is not valid JSON' }];
  }
}
