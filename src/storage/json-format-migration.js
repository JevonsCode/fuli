import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { contentHash } from '../../packages/roundtable/src/canonical-json.js';
import { DataFormatError } from '../../packages/roundtable/src/storage/data-format-error.js';
import {
  BACKUP_DIRECTORY, formatBackupName, formatBackupPath, formatBackupsOf, parseFormatBackupRef
} from '../../packages/roundtable/src/storage/format-backup-names.js';
import {
  appendJsonLedgerEvent, assertJsonFormatWritable, assertJsonLedgerWritable, jsonFormat, jsonLedgerEvents,
  withJsonFormatDirectory
} from './json-format.js';

// What a person confirms for one FULI JSON data file (rec#17 D-09 part 2),
// the counterpart of database-migration.js. Every change happens under the
// directory's format lock and follows one recoverable commit protocol, since
// the file and its ledger are two files and two renames:
// 1. every sidecar this FULI must write later (ledger, intent) is checked
//    first: a newer or unreadable one refuses before anything changes;
// 2. the file as it is is copied to format-backups/;
// 3. an intent record names the change: the backup, the digest of the file
//    before and after, and the ledger event that commits it;
// 4. the file is replaced; 5. the ledger event is appended; 6. the intent
//    is removed.
// An intent left behind (a crash, a full disk) is resolved by the next
// operation on the file, under the same lock: a file still as it was means
// nothing changed (the intent is dropped); a file as the change left it is
// committed (the ledger event appended); anything else is refused until the
// file is restored from the intent's backup. Preview, read-only, plans on
// what that resolution will leave and blocks only the last case. Undo restores the backup only while the file is still exactly
// what the migration wrote; a whole-file restore discards later changes and
// is a separate operation.

const SAMPLE_SIZE = 5;
const INTENT_VERSION = 1;
const INTENT_FORMAT = jsonFormat({ store: 'json-format-intent', versions: [INTENT_VERSION] });
const NO_STAGE = () => {};

export function previewJsonMigration(filePath, format) {
  const document = readDocument(filePath);
  const unusable = sidecarProblem(filePath);
  if (unusable) {
    return { store: format.store, kind: 'json', version: document?.version ?? null, target: format.supported,
      action: 'blocked', steps: [], reason: unusable };
  }
  return document ? filePlan(document, format) : null;
}

function filePlan(document, format) {
  const base = { store: format.store, kind: 'json', version: document.version ?? null, target: format.supported };
  if (Number.isInteger(document.version) && document.version > format.supported) {
    return { ...base, action: 'blocked', steps: [],
      reason: `written by a newer FULI (format ${document.version}); upgrade FULI or restore a backup` };
  }
  if (format.pendingFrom === null || document.version !== format.pendingFrom) return null;
  const { migration } = format;
  const keys = migration.recordIds(document).map(String).sort();
  const plan = { ...base, action: 'apply', automatic: [],
    step: { id: migration.id, summary: migration.summary, kind: 'rewrite', fromVersion: migration.from,
      toVersion: migration.to, count: keys.length, sampleIds: keys.slice(0, SAMPLE_SIZE), scopeDigest: contentHash(keys) },
    undo: 'available' };
  return { ...plan, digest: contentHash(plan) };
}

// What preview cannot pass over: a sidecar this FULI cannot write, or an
// interrupted change no operation can resolve on its own.
function sidecarProblem(filePath) {
  try {
    assertJsonLedgerWritable(filePath);
    assertJsonFormatWritable(intentPath(filePath), INTENT_FORMAT);
  } catch (error) {
    return `its format ledger or intent record cannot be written by this FULI (${error.message})`;
  }
  return intentResolution(filePath) === 'conflict' ? 'an interrupted change left the file neither as it was nor '
    + 'as the change left it; restore it from the backup the change names' : null;
}

// Resolves an interrupted change left behind (fuli migrate and console start).
export function recoverJsonFile(filePath, format, { now = () => new Date() } = {}) {
  if (!readIntent(filePath)) return null;
  return withRecoveredFile(filePath, format, { now, stage: NO_STAGE }, (_commit, resolution) => resolution);
}

export function applyConfirmedJsonMigration(filePath, format, { digest, actor, now = () => new Date(),
  copy = copyFileSync, applyId = randomUUID(), stage = NO_STAGE }) {
  return withRecoveredFile(filePath, format, { now, stage }, (commit) => {
    const document = readDocument(filePath);
    const plan = document ? filePlan(document, format) : null;
    if (plan?.action !== 'apply' || plan.digest !== digest) {
      const earlier = latestConfirmed(filePath);
      if (earlier?.status === 'applied' && earlier.planDigest === digest) {
        return { status: 'already_applied', store: format.store, migrationId: earlier.migrationId,
          applyId: earlier.applyId };
      }
      throw new DataFormatError(format.store, 'data_format_stale_preview', `FULI store "${format.store}" no longer `
        + 'matches the preview that was confirmed. Nothing was changed; run the preview again and confirm what it shows.',
      plan?.step ? [plan.step.id] : []);
    }
    const backupRef = backupFile(filePath, format, document.version, copy, now, `migration ${plan.step.id}`);
    const next = format.migration.rewrite(document);
    commit({ operation: 'apply', before: document, after: next, backupRef, event: {
      migrationId: plan.step.id, fromVersion: plan.step.fromVersion, toVersion: plan.step.toVersion, status: 'applied',
      backupRef, applyId, planDigest: digest, afterDigest: contentHash(next),
      detail: `confirmed locally (${actor.entrypoint}, presence unverified): ${plan.step.count} records`,
      recordedAt: now().toISOString() } });
    return { status: 'applied', store: format.store, migrationId: plan.step.id, applyId, backupRef,
      count: plan.step.count, fromVersion: plan.step.fromVersion, toVersion: plan.step.toVersion };
  });
}

export function undoableJsonMigrations(filePath, format) {
  const latest = latestConfirmed(filePath);
  return latest?.status === 'applied' ? [{ store: format.store, kind: 'json', applyId: latest.applyId,
    migrationId: latest.migrationId, fromVersion: latest.fromVersion, toVersion: latest.toVersion,
    backupRef: latest.backupRef, appliedAt: latest.recordedAt }] : [];
}

export function rollbackJsonMigration(filePath, format, { migrationId, actor, now = () => new Date(),
  copy = copyFileSync, stage = NO_STAGE }) {
  return withRecoveredFile(filePath, format, { now, stage }, (commit) => {
    const latest = latestConfirmed(filePath);
    if (latest?.status !== 'applied' || latest.migrationId !== migrationId) {
      throw new DataFormatError(format.store, 'data_format_nothing_to_undo', `FULI store "${format.store}" has no `
        + `confirmed migration ${migrationId} left to undo.`);
    }
    const current = readDocument(filePath);
    if (Number.isInteger(current?.version) && current.version > format.supported) {
      throw newerFile(format, current.version);
    }
    if (!current || contentHash(current) !== latest.afterDigest) {
      throw new DataFormatError(format.store, 'data_format_changed_since', `FULI store "${format.store}" changed `
        + `after migration ${migrationId}, so undoing it would overwrite those changes. Nothing was changed. `
        + `Restoring the whole file from ${latest.backupRef} would discard every change made since; that is a `
        + 'separate operation (fuli migrate restore).', [migrationId]);
    }
    const before = JSON.parse(readFileSync(backupPath(filePath, format, latest.backupRef), 'utf8'));
    const backupRef = backupFile(filePath, format, current.version, copy, now, `undoing ${migrationId}`);
    commit({ operation: 'rollback', before: current, after: before, backupRef, event: { migrationId,
      fromVersion: latest.toVersion, toVersion: latest.fromVersion, status: 'rolled_back', backupRef,
      applyId: latest.applyId, afterDigest: contentHash(before), detail: `undone locally (${actor.entrypoint}, `
        + `presence unverified) from ${latest.backupRef}`, recordedAt: now().toISOString() } });
    return { status: 'rolled_back', store: format.store, migrationId, applyId: latest.applyId, backupRef,
      version: latest.fromVersion };
  });
}

// What restoring backupRef would discard; `expected` on restore is this.
export function describeJsonRestore(filePath, format, backupRef) {
  const restored = JSON.parse(readFileSync(backupPath(filePath, format, backupRef), 'utf8'));
  const current = readDocument(filePath);
  const takenAt = backupTime(backupRef);
  return { store: format.store, kind: 'json', backupRef, takenAt, currentVersion: current?.version ?? null,
    backupVersion: restored?.version ?? null, tables: [], currentDigest: current ? contentHash(current) : null,
    laterMigrations: jsonLedgerEvents(filePath).filter((event) => !takenAt || event.recordedAt > takenAt)
      .map((event) => ({ migrationId: event.migrationId, status: event.status })),
    warning: `Every change to "${format.store}" made after ${takenAt ?? 'that backup'} is lost.` };
}

// expected: the describeJsonRestore result the person confirmed; a file that
// changed since is not overwritten.
export function restoreJsonFile(filePath, format, { backupRef, expected, actor, now = () => new Date(),
  copy = copyFileSync, stage = NO_STAGE }) {
  return withRecoveredFile(filePath, format, { now, stage }, (commit) => {
    const restored = JSON.parse(readFileSync(backupPath(filePath, format, backupRef), 'utf8'));
    if (Number.isInteger(restored?.version) && restored.version > format.supported) throw newerFile(format, restored.version);
    const current = readDocument(filePath);
    if (!expected || (current ? contentHash(current) : null) !== expected.currentDigest) {
      throw new DataFormatError(format.store, 'data_format_stale_preview', `FULI store "${format.store}" changed `
        + 'after you saw what the restore discards. Nothing was changed; look at it again before restoring.');
    }
    const safetyRef = current ? backupFile(filePath, format, current.version ?? 0, copy, now, 'a whole-file restore')
      : null;
    commit({ operation: 'restore', before: current, after: restored, backupRef: safetyRef, event: {
      migrationId: `${format.store}/restore`, fromVersion: current?.version ?? null, toVersion: restored.version ?? null,
      status: 'restored', backupRef: safetyRef, afterDigest: contentHash(restored),
      detail: `whole file restored locally (${actor.entrypoint}, presence unverified) from ${backupRef}; changes `
        + `after ${backupTime(backupRef) ?? 'that backup'} were discarded`, recordedAt: now().toISOString() } });
    return { status: 'restored', store: format.store, backupRef, safetyBackupRef: safetyRef,
      version: restored.version ?? null };
  });
}

export function jsonBackupFiles(filePath) {
  return formatBackupsOf(filePath).map(({ ref, version, takenAt }) => ({ ref, version, takenAt }));
}

// The lock, the sidecar check and the recovery of an earlier interrupted
// change, then operation(commit); commit runs steps 3–6 of the protocol.
function withRecoveredFile(filePath, format, { now, stage }, operation) {
  return withJsonFormatDirectory(filePath, ({ write, remove }) => {
    assertJsonLedgerWritable(filePath);
    assertJsonFormatWritable(intentPath(filePath), INTENT_FORMAT);
    const resolution = resolveIntent(filePath, format, { write, remove });
    return operation(({ operation: kind, before, after, backupRef, event }) => {
      write(intentPath(filePath), { version: INTENT_VERSION, operation: kind, store: format.store, backupRef,
        beforeDigest: before ? contentHash(before) : null, afterDigest: contentHash(after), event,
        preparedAt: now().toISOString() }, INTENT_FORMAT);
      stage('intent');
      write(filePath, after, format);
      stage('file');
      appendJsonLedgerEvent(write, filePath, event);
      stage('ledger');
      remove(intentPath(filePath), INTENT_FORMAT);
    }, resolution);
  });
}

// What resolving the intent would do, read only: null, 'completed',
// 'dropped' or 'conflict'.
function intentResolution(filePath) {
  const intent = readIntent(filePath);
  if (!intent) return null;
  const current = readDocument(filePath);
  const digest = current ? contentHash(current) : null;
  if (digest === intent.afterDigest) return 'completed';
  return digest === intent.beforeDigest ? 'dropped' : 'conflict';
}

function resolveIntent(filePath, format, { write, remove }) {
  const resolution = intentResolution(filePath);
  if (!resolution) return null;
  const intent = readIntent(filePath);
  if (resolution === 'completed') {
    const committed = jsonLedgerEvents(filePath).some((event) => event.status === intent.event.status
      && event.migrationId === intent.event.migrationId && event.recordedAt === intent.event.recordedAt);
    if (!committed) appendJsonLedgerEvent(write, filePath, intent.event);
    remove(intentPath(filePath), INTENT_FORMAT);
    return 'completed';
  }
  if (resolution === 'dropped') {
    remove(intentPath(filePath), INTENT_FORMAT);
    return 'dropped';
  }
  throw new DataFormatError(format.store, 'data_format_interrupted', `FULI store "${format.store}" has an `
    + `interrupted ${intent.operation} (${intent.event?.migrationId}) and the file is neither as it was nor as that `
    + `change left it. Nothing was changed; restore it from ${intent.backupRef ?? 'a backup'} (fuli migrate restore).`,
  intent.event?.migrationId ? [intent.event.migrationId] : []);
}

function intentPath(filePath) {
  return `${filePath}.format-intent.json`;
}

function readIntent(filePath) {
  try {
    return JSON.parse(readFileSync(intentPath(filePath), 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function newerFile(format, version) {
  return new DataFormatError(format.store, 'data_format_blocked', `FULI store "${format.store}" uses data format `
    + `${version}, newer than this FULI supports (${format.supported}). Nothing was changed.`);
}

// The latest apply, undo or restore; an apply after an undo needs a new preview.
function latestConfirmed(filePath) {
  return jsonLedgerEvents(filePath).findLast((event) => ['applied', 'rolled_back', 'restored'].includes(event.status));
}

function readDocument(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function backupFile(filePath, format, version, copy, now, purpose) {
  const directory = join(dirname(filePath), BACKUP_DIRECTORY);
  const name = formatBackupName(filePath, version, now(), 'json');
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    copy(filePath, join(directory, name));
  } catch (error) {
    throw new DataFormatError(format.store, 'data_format_backup_failed', `FULI store "${format.store}" needs `
      + `${purpose}, but the backup before it failed (${error.message}); nothing was changed.`);
  }
  return `${BACKUP_DIRECTORY}/${name}`;
}

function backupPath(filePath, format, backupRef) {
  const file = formatBackupPath(filePath, backupRef);
  if (!file) {
    throw new DataFormatError(format.store, 'data_format_backup_missing', `FULI store "${format.store}" has no `
      + `backup ${backupRef}; it may have been pruned. Nothing was changed.`);
  }
  return file;
}

function backupTime(backupRef) {
  return parseFormatBackupRef(backupRef)?.takenAt ?? null;
}
