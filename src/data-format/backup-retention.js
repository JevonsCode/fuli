import { existsSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { inspectSqliteStore } from '../../packages/roundtable/src/storage/database-format.js';
import { undoableSqliteMigrations } from '../../packages/roundtable/src/storage/database-migration.js';
import { formatBackupsOf } from '../../packages/roundtable/src/storage/format-backup-names.js';
import { undoableJsonMigrations } from '../storage/json-format-migration.js';
import { inspectJsonStore } from '../storage/json-format.js';
import { localStoreFiles } from './local-stores.js';
import { recordFormatOperations } from './operations-log.js';

// How many format backups a data directory keeps (rec#17 D-09 part 2, D-11
// §5). Each store keeps its newest `keep` backups, and the format backups and
// the graph's undo journals together use at most `maxBytes`: one soft budget
// (format-retention.js weighs the journals in through `shared`). Past it the
// oldest items not needed go first, across both, journals of undone graph
// steps before anything else. A backup is never pruned while it is
// - the one an undoable migration restores from,
// - the backup the store's latest ledger entry refers to (the version last
//   applied), or
// - the newest backup of the version the store is at now.
// What was pruned is logged by store, backup name, version and size only.
// The count and size are a target, not a hard bound: backups that must be
// kept stay even beyond them. Graph undo journals live in the graph; this
// module only chooses which of the `shared` ones the size budget prunes. A
// store whose ledger cannot be read keeps every backup. The console prunes while it holds the data directory and
// `fuli migrate prune` holds it too, so pruning never runs during a
// whole-store restore (maintenance-lock.js).

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

export function sizeBudgetReason(policy) {
  return `format backups and graph undo journals use more than ${Math.round(policy.maxBytes / MEGABYTE)} MB`;
}

// dryRun lists what would go without removing it. shared: other items under
// the same size budget, as { key, bytes, at, needed, first } (first: pruned
// before anything else); the keys the budget prunes come back as sharedPruned.
export function pruneFormatBackups(dataDir, { policy = backupRetentionPolicy(), dryRun = false, shared = [],
  now = () => new Date(), remove = (path) => rmSync(path, { force: true }),
  sizeOf = (path) => statSync(path).size } = {}) {
  const candidates = [];
  for (const store of localStoreFiles(dataDir)) {
    const backups = formatBackupsOf(store.path).map((backup) => ({ ...backup, store: store.format.store,
      label: store.label, file: join(dirname(store.path), 'format-backups', backup.name),
      bytes: sizeOf(join(dirname(store.path), 'format-backups', backup.name)) }));
    const needed = neededBackups(store, backups);
    const newestFirst = backups.filter((backup) => !needed.has(backup.ref)).reverse();
    newestFirst.forEach((backup, index) => {
      if (index >= policy.keep) candidates.push({ ...backup, reason: `more than ${policy.keep} backups of this store` });
      else candidates.push({ ...backup, reason: null });
    });
    for (const backup of backups.filter((entry) => needed.has(entry.ref))) candidates.push({ ...backup, needed: true });
  }
  const pruned = candidates.filter((backup) => backup.reason);
  const pool = [...candidates.filter((backup) => !backup.reason).map((backup) => ({ bytes: backup.bytes,
    at: Date.parse(backup.takenAt), needed: Boolean(backup.needed), first: false, backup })),
  ...shared.map((item) => ({ ...item, at: Date.parse(item.at) || 0 }))];
  let total = pool.reduce((sum, item) => sum + item.bytes, 0);
  const sharedPruned = [];
  for (const item of pool.filter((entry) => !entry.needed)
    .sort((a, b) => Number(b.first) - Number(a.first) || a.at - b.at)) {
    if (total <= policy.maxBytes) break;
    if (item.backup) pruned.push({ ...item.backup, reason: sizeBudgetReason(policy) });
    else sharedPruned.push(item.key);
    total -= item.bytes;
  }
  const at = now().toISOString();
  const events = pruned.map((backup) => ({ kind: 'pruned', store: backup.store, label: backup.label,
    backupRef: backup.ref, version: backup.version, bytes: backup.bytes, reason: backup.reason, at }));
  if (!dryRun) {
    for (const backup of pruned) remove(backup.file);
    recordFormatOperations(dataDir, events);
  }
  return { pruned: events, kept: candidates.length - pruned.length, bytesKept: total, sharedPruned, policy };
}

function neededBackups(store, backups) {
  const everything = new Set(backups.map((backup) => backup.ref));
  const needed = new Set();
  let report;
  try {
    report = store.kind === 'sqlite' ? inspectSqliteStore(store.path, store.format)
      : inspectJsonStore(store.path, store.format);
  } catch {
    return everything;
  }
  // A store or ledger that cannot be read cannot say which backup it needs,
  // and an interrupted change still names its own.
  if (['unavailable', 'unreadable'].includes(report.state) || report.ledger.some((entry) => entry.status === 'unreadable')
    || existsSync(`${store.path}.format-intent.json`)) {
    return everything;
  }
  let undoable;
  try {
    undoable = store.kind === 'sqlite' ? undoableSqliteMigrations(store.path, store.format)
      : undoableJsonMigrations(store.path, store.format);
  } catch {
    return everything;
  }
  for (const migration of undoable) needed.add(migration.backupRef);
  const latest = report.ledger.findLast((entry) => entry.backupRef);
  if (latest) needed.add(latest.backupRef);
  const current = backups.filter((backup) => backup.version === report.version).at(-1);
  if (current) needed.add(current.ref);
  return needed;
}
