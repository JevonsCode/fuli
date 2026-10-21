import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { contentHash } from '../../packages/roundtable/src/canonical-json.js';
import { DataFormatError } from '../../packages/roundtable/src/storage/data-format-error.js';
import {
  BACKUP_DIRECTORY, formatBackupName, formatBackupPath, formatBackupsOf, parseFormatBackupRef
} from '../../packages/roundtable/src/storage/format-backup-names.js';
import { appendJsonLedgerEvent, jsonLedgerEvents, withJsonFormatDirectory } from './json-format.js';

// What a person confirms for one FULI JSON data file (rec#17 D-09 part 2),
// the counterpart of database-migration.js. The file is read, checked against
// the confirmed plan, copied to a backup and rewritten under its directory's
// format lock; a whole-file write cannot be half-applied. Undo restores the
// backup only while the file is still exactly what the migration wrote; a
// whole-file restore discards later changes and is a separate operation.

const SAMPLE_SIZE = 5;
const BACKUP_NAME = /\.v(\d+)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.json$/;

export function previewJsonMigration(filePath, format) {
  const document = readDocument(filePath);
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

export function applyConfirmedJsonMigration(filePath, format, { digest, actor, now = () => new Date(),
  copy = copyFileSync, applyId = randomUUID() }) {
  return withJsonFormatDirectory(filePath, ({ write }) => {
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
    write(filePath, next, format);
    appendJsonLedgerEvent(write, filePath, { migrationId: plan.step.id, fromVersion: plan.step.fromVersion,
      toVersion: plan.step.toVersion, status: 'applied', backupRef, applyId, planDigest: digest,
      afterDigest: contentHash(next), detail: `confirmed locally (${actor.entrypoint}, presence unverified): `
        + `${plan.step.count} records`, recordedAt: now().toISOString() });
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
  copy = copyFileSync }) {
  return withJsonFormatDirectory(filePath, ({ write }) => {
    const latest = latestConfirmed(filePath);
    if (latest?.status !== 'applied' || latest.migrationId !== migrationId) {
      throw new DataFormatError(format.store, 'data_format_nothing_to_undo', `FULI store "${format.store}" has no `
        + `confirmed migration ${migrationId} left to undo.`);
    }
    const current = readDocument(filePath);
    if (!current || contentHash(current) !== latest.afterDigest) {
      throw new DataFormatError(format.store, 'data_format_changed_since', `FULI store "${format.store}" changed `
        + `after migration ${migrationId}, so undoing it would overwrite those changes. Nothing was changed. `
        + `Restoring the whole file from ${latest.backupRef} would discard every change made since; that is a `
        + 'separate operation (fuli migrate restore).', [migrationId]);
    }
    const before = JSON.parse(readFileSync(backupPath(filePath, format, latest.backupRef), 'utf8'));
    const backupRef = backupFile(filePath, format, current.version, copy, now, `undoing ${migrationId}`);
    write(filePath, before, format);
    appendJsonLedgerEvent(write, filePath, { migrationId, fromVersion: latest.toVersion, toVersion: latest.fromVersion,
      status: 'rolled_back', backupRef, applyId: latest.applyId, detail: `undone locally (${actor.entrypoint}, `
        + `presence unverified) from ${latest.backupRef}`, recordedAt: now().toISOString() });
    return { status: 'rolled_back', store: format.store, migrationId, applyId: latest.applyId, backupRef,
      version: latest.fromVersion };
  });
}

export function describeJsonRestore(filePath, format, backupRef) {
  const restored = JSON.parse(readFileSync(backupPath(filePath, format, backupRef), 'utf8'));
  const current = readDocument(filePath);
  const takenAt = backupTime(backupRef);
  return { store: format.store, kind: 'json', backupRef, takenAt, currentVersion: current?.version ?? null,
    backupVersion: restored?.version ?? null, tables: [],
    laterMigrations: jsonLedgerEvents(filePath).filter((event) => !takenAt || event.recordedAt > takenAt)
      .map((event) => ({ migrationId: event.migrationId, status: event.status })),
    warning: `Every change to "${format.store}" made after ${takenAt ?? 'that backup'} is lost.` };
}

export function restoreJsonFile(filePath, format, { backupRef, actor, now = () => new Date(), copy = copyFileSync }) {
  return withJsonFormatDirectory(filePath, ({ write }) => {
    const restored = JSON.parse(readFileSync(backupPath(filePath, format, backupRef), 'utf8'));
    if (Number.isInteger(restored?.version) && restored.version > format.supported) {
      throw new DataFormatError(format.store, 'data_format_blocked', `Backup ${backupRef} of "${format.store}" uses `
        + `data format ${restored.version}, newer than this FULI supports (${format.supported}). Nothing was changed.`);
    }
    const current = readDocument(filePath);
    const safetyRef = current ? backupFile(filePath, format, current.version ?? 0, copy, now, 'a whole-file restore')
      : null;
    write(filePath, restored, format);
    appendJsonLedgerEvent(write, filePath, { migrationId: `${format.store}/restore`,
      fromVersion: current?.version ?? null, toVersion: restored.version ?? null, status: 'restored',
      backupRef: safetyRef, detail: `whole file restored locally (${actor.entrypoint}, presence unverified) from `
        + `${backupRef}; changes after ${backupTime(backupRef) ?? 'that backup'} were discarded`,
      recordedAt: now().toISOString() });
    return { status: 'restored', store: format.store, backupRef, safetyBackupRef: safetyRef,
      version: restored.version ?? null };
  });
}

export function jsonBackupFiles(filePath) {
  return formatBackupsOf(filePath).map(({ ref, version, takenAt }) => ({ ref, version, takenAt }));
}

// The latest apply or undo; an apply after it was undone needs a new preview.
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
