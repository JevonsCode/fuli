import { rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { inspectSqliteStore } from '../../packages/roundtable/src/storage/database-format.js';
import { undoableSqliteMigrations } from '../../packages/roundtable/src/storage/database-migration.js';
import { formatBackupsOf } from '../../packages/roundtable/src/storage/format-backup-names.js';
import { undoableJsonMigrations } from '../storage/json-format-migration.js';
import { inspectJsonStore } from '../storage/json-format.js';
import { localStoreFiles } from './local-stores.js';
import { recordFormatOperations } from './operations-log.js';

// How many format backups a data directory keeps (rec#17 D-09 part 2, D-11
// §5). Each store keeps its newest `keep` backups and the whole directory at
// most `maxBytes`, but a backup is never pruned while it is
// - the one an undoable migration restores from,
// - the backup the store's latest ledger entry refers to (the version last
//   applied), or
// - the newest backup of the version the store is at now.
// What was pruned is logged by store, backup name, version and size only.

const DEFAULT_KEEP = 3;
const DEFAULT_MAX_MEGABYTES = 1024;
const MEGABYTE = 1024 * 1024;

// FULI_FORMAT_BACKUP_KEEP and FULI_FORMAT_BACKUP_MAX_MB override the defaults.
export function backupRetentionPolicy(env = process.env, overrides = {}) {
  const keep = overrides.keep ?? positive(env.FULI_FORMAT_BACKUP_KEEP, 'FULI_FORMAT_BACKUP_KEEP') ?? DEFAULT_KEEP;
  const megabytes = overrides.maxMegabytes
    ?? positive(env.FULI_FORMAT_BACKUP_MAX_MB, 'FULI_FORMAT_BACKUP_MAX_MB') ?? DEFAULT_MAX_MEGABYTES;
  return { keep, maxBytes: megabytes * MEGABYTE };
}

function positive(value, name) {
  if (value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new TypeError(`${name} must be a positive whole number`);
  return number;
}

// dryRun lists what would go without removing it.
export function pruneFormatBackups(dataDir, { policy = backupRetentionPolicy(), dryRun = false,
  now = () => new Date(), remove = (path) => rmSync(path, { force: true }) } = {}) {
  const candidates = [];
  for (const store of localStoreFiles(dataDir)) {
    const backups = formatBackupsOf(store.path).map((backup) => ({ ...backup, store: store.format.store,
      label: store.label, file: join(dirname(store.path), 'format-backups', backup.name),
      bytes: statSync(join(dirname(store.path), 'format-backups', backup.name)).size }));
    const needed = neededBackups(store, backups);
    const newestFirst = backups.filter((backup) => !needed.has(backup.ref)).reverse();
    newestFirst.forEach((backup, index) => {
      if (index >= policy.keep) candidates.push({ ...backup, reason: `more than ${policy.keep} backups of this store` });
      else candidates.push({ ...backup, reason: null });
    });
    for (const backup of backups.filter((entry) => needed.has(entry.ref))) candidates.push({ ...backup, needed: true });
  }
  const pruned = candidates.filter((backup) => backup.reason);
  let total = candidates.filter((backup) => !backup.reason).reduce((sum, backup) => sum + backup.bytes, 0);
  for (const backup of candidates.filter((entry) => !entry.reason && !entry.needed)
    .sort((a, b) => a.takenAt.localeCompare(b.takenAt))) {
    if (total <= policy.maxBytes) break;
    pruned.push({ ...backup, reason: `backups use more than ${Math.round(policy.maxBytes / MEGABYTE)} MB` });
    total -= backup.bytes;
  }
  const at = now().toISOString();
  const events = pruned.map((backup) => ({ kind: 'pruned', store: backup.store, label: backup.label,
    backupRef: backup.ref, version: backup.version, bytes: backup.bytes, reason: backup.reason, at }));
  if (!dryRun) {
    for (const backup of pruned) remove(backup.file);
    recordFormatOperations(dataDir, events);
  }
  return { pruned: events, kept: candidates.length - pruned.length, bytesKept: total, policy };
}

function neededBackups(store, backups) {
  const needed = new Set();
  const undoable = store.kind === 'sqlite' ? undoableSqliteMigrations(store.path, store.format)
    : undoableJsonMigrations(store.path, store.format);
  for (const migration of undoable) needed.add(migration.backupRef);
  const report = store.kind === 'sqlite' ? inspectSqliteStore(store.path, store.format)
    : inspectJsonStore(store.path, store.format);
  const latest = report.ledger.findLast((entry) => entry.backupRef);
  if (latest) needed.add(latest.backupRef);
  const current = backups.filter((backup) => backup.version === report.version).at(-1);
  if (current) needed.add(current.ref);
  return needed;
}
