import { RoundtableError } from '../errors.js';

// A local store this version must not use as it is: its data format is newer
// than this version knows, a migration is waiting for a person, a migration
// started and never finished, or the backup before a migration failed. The
// message says what to do (upgrade, restore a backup, confirm); retrying the
// same call cannot help, hence 503. A person's confirmation that no longer
// fits the store (a stale preview, records changed since a migration, nothing
// left to undo, a pruned backup) is a 409 the person resolves. steps names
// the migrations concerned.
const CONFIRMATION_CONFLICTS = new Set(['data_format_stale_preview', 'data_format_changed_since',
  'data_format_nothing_to_undo', 'data_format_undo_blocked', 'data_format_backup_missing']);

export class DataFormatError extends RoundtableError {
  constructor(store, code, message, steps = []) {
    super(code, message, { status: CONFIRMATION_CONFLICTS.has(code) ? 409 : 503 });
    this.name = 'DataFormatError';
    this.store = store;
    this.steps = steps;
  }
}

export function newerFormatError(store, version, supported) {
  return new DataFormatError(store, 'data_format_blocked',
    `FULI store "${store}" uses data format ${version}, newer than this FULI supports (${supported}). `
    + 'Upgrade FULI, or restore the backup made before the newer version first ran.');
}

export function pendingMigrationError(store, migration, detail) {
  return new DataFormatError(store, 'data_format_pending',
    `FULI store "${store}" needs migration ${migration.id} (${migration.summary}): ${detail}. FULI does not run it `
    + 'automatically; the store stays unavailable until a person confirms it.',
    [migration.id]);
}
