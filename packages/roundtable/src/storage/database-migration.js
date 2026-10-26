import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { contentHash } from '../canonical-json.js';
import { DataFormatError, newerFormatError } from './data-format-error.js';
import {
  LEDGER_TABLE, MIGRATION_LOCK_TIMEOUT_MS, backupSqliteDatabase, inspectOpenStore,
  ledgerWriter, openReadOnly, planSteps, setUserVersion, takeBackup, userTables, userVersion
} from './database-format.js';
import { formatBackupPath, formatBackupsOf, parseFormatBackupRef } from './format-backup-names.js';

// What a person confirms for one SQLite store (rec#17 D-09 part 2), next to
// what opening it does on its own (database-format.js):
// - preview: the first step that waits for a person, the rows it changes by
//   key only, and a digest of exactly that. The digest binds the plan; it is
//   not an authorization;
// - apply: under the store's write lock the plan is computed again, and a
//   different digest stops it ("preview again"). Then the online backup,
//   the steps, their ledger rows, an undo record and the version commit in
//   one transaction; a failed backup changes nothing;
// - rollback (undo one migration): restores the rows that migration changed
//   from its backup, only while every one of them is still exactly as the
//   migration left it (the lead-occupation migration's post-change check);
// - restore (the whole store): replaces the store with a backup. Every
//   change made after that backup is lost, so it is a separate operation the
//   caller runs only on a person's explicit request.

const UNDO_TABLE = 'fuli_format_undo';
const UNDO = `CREATE TABLE IF NOT EXISTS ${UNDO_TABLE}(apply_id TEXT PRIMARY KEY, migration_id TEXT NOT NULL,
  from_version INTEGER NOT NULL, to_version INTEGER NOT NULL, table_name TEXT NOT NULL, columns TEXT NOT NULL,
  backup_ref TEXT NOT NULL, plan_digest TEXT NOT NULL, after_digest TEXT NOT NULL, state TEXT NOT NULL,
  recorded_at TEXT NOT NULL)`;
const SAMPLE_SIZE = 5;

// The plan for one store: null when nothing waits for a person; action
// 'apply' with the step and its rows; or 'blocked' with why FULI cannot.
export function previewSqliteMigration(path, format) {
  if (!existsSync(path)) return null;
  const database = openReadOnly(path);
  try { return storePlan(database, format); } finally { database.close(); }
}

function storePlan(database, format) {
  const report = inspectOpenStore(database, format);
  const base = { store: format.store, kind: 'sqlite', version: report.version, target: format.version };
  if (report.state === 'newer_format') {
    return blocked(base, [], `written by a newer FULI (format ${report.version}); upgrade FULI or restore a backup`);
  }
  if (report.state === 'half_applied') {
    return blocked(base, report.steps.map((step) => step.id), 'a migration started and did not finish; restore a backup');
  }
  if (report.state !== 'pending_confirmation') return null;
  const index = report.steps.findIndex((step) => step.state === 'pending_confirmation');
  const pending = report.steps[index];
  const migration = format.migrations.find((candidate) => candidate.id === pending.id);
  if (migration?.kind !== 'backfill') {
    return blocked(base, [pending.id], `${pending.detail}; FULI cannot apply this itself: repair the store or `
      + 'restore a backup');
  }
  return withDigest({ ...base, action: 'apply',
    automatic: report.steps.slice(0, index).filter((step) => step.state === 'automatic').map((step) => step.id),
    step: { id: migration.id, summary: migration.summary, kind: migration.kind, fromVersion: migration.to - 1,
      toVersion: migration.to, count: pending.keys.length, sampleIds: pending.keys.slice(0, SAMPLE_SIZE),
      scopeDigest: contentHash(pending.keys) },
    undo: 'available' });
}

function blocked(base, steps, reason) {
  return { ...base, action: 'blocked', steps, reason };
}

function withDigest(plan) {
  return { ...plan, digest: contentHash(plan) };
}

// actor: who confirmed, e.g. { entrypoint: 'cli' }; FULI cannot verify that a
// person was present, and the ledger says so.
export function applyConfirmedSqliteMigration(path, format, { digest, actor, backup = backupSqliteDatabase,
  now = () => new Date().toISOString(), applyId = randomUUID() }) {
  return withWriteLock(path, (database) => {
    const plan = storePlan(database, format);
    if (plan?.action !== 'apply' || plan.digest !== digest) {
      const earlier = appliedUndo(database, digest);
      if (earlier) return { status: 'already_applied', store: format.store, migrationId: earlier.migration_id,
        applyId: earlier.apply_id };
      throw stalePreview(format.store, plan);
    }
    const steps = planSteps(database, format, plan.version);
    const confirmed = steps.at(-1);
    if (confirmed?.migration_id !== plan.step.id || confirmed.status !== 'pending_confirmation') {
      throw stalePreview(format.store, plan);
    }
    const backupRef = takeBackup(path, format, plan.version, backup, steps.map((step) => step.migration_id),
      { purpose: `migration ${plan.step.id}` });
    const record = ledgerWriter(database, now);
    for (const step of steps.slice(0, -1)) {
      if (step.status === 'applied') step.run();
      record({ ...step, backup_ref: backupRef });
    }
    confirmed.run();
    record({ ...confirmed, status: 'applied', backup_ref: backupRef,
      detail: `confirmed locally (${actor.entrypoint}, presence unverified): ${plan.step.count} rows; undo ${applyId}` });
    const migration = confirmed.migration;
    database.exec(UNDO);
    database.prepare(`INSERT INTO ${UNDO_TABLE}(apply_id, migration_id, from_version, to_version, table_name, columns,
      backup_ref, plan_digest, after_digest, state, recorded_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(applyId,
      migration.id, confirmed.from_version, confirmed.to_version, migration.table,
      JSON.stringify(Object.keys(migration.columns)), backupRef, digest,
      columnsDigest(database, migration.table, Object.keys(migration.columns)), 'applied', now());
    setUserVersion(database, confirmed.to_version);
    return { status: 'applied', store: format.store, migrationId: migration.id, applyId, backupRef,
      count: plan.step.count, fromVersion: confirmed.from_version, toVersion: confirmed.to_version };
  });
}

// The confirmed migrations of this store that can still be undone, newest first.
export function undoableSqliteMigrations(path, format) {
  if (!existsSync(path)) return [];
  const database = openReadOnly(path);
  try {
    if (!userTables(database).includes(UNDO_TABLE)) return [];
    return database.prepare(`SELECT apply_id, migration_id, from_version, to_version, backup_ref, recorded_at
      FROM ${UNDO_TABLE} WHERE state = 'applied' ORDER BY recorded_at DESC, rowid DESC`).all()
      .map((row) => ({ store: format.store, kind: 'sqlite', applyId: row.apply_id, migrationId: row.migration_id,
        fromVersion: row.from_version, toVersion: row.to_version, backupRef: row.backup_ref,
        appliedAt: row.recorded_at }));
  } finally { database.close(); }
}

// Undoes the latest confirmed migration (migrationId must name it). Refused
// when a later step changed records, when any row it changed differs from
// what it left, or when its backup is gone; nothing changes then.
export function rollbackSqliteMigration(path, format, { migrationId, actor, backup = backupSqliteDatabase,
  now = () => new Date().toISOString() }) {
  return withWriteLock(path, (database) => {
    // A newer FULI may have moved the store on without touching these rows;
    // this FULI cannot know what moving the version back would mean for it.
    const current = userVersion(database);
    if (current > format.version) throw newerFormatError(format.store, current, format.version);
    const undo = userTables(database).includes(UNDO_TABLE) ? database.prepare(`SELECT * FROM ${UNDO_TABLE}
      WHERE state = 'applied' ORDER BY recorded_at DESC, rowid DESC LIMIT 1`).get() : null;
    if (!undo || undo.migration_id !== migrationId) {
      throw new DataFormatError(format.store, 'data_format_nothing_to_undo', `FULI store "${format.store}" has no `
        + `confirmed migration ${migrationId} left to undo${undo ? `; the latest is ${undo.migration_id}` : ''}.`);
    }
    const version = userVersion(database);
    const later = format.migrations.filter(({ to }) => to > undo.to_version && to <= version);
    if (version < undo.to_version || later.some(({ kind }) => kind !== 'add-columns')) {
      throw new DataFormatError(format.store, 'data_format_undo_blocked', `FULI store "${format.store}" changed `
        + `records in a later migration after ${migrationId}; undo that one first. Nothing was changed.`, [migrationId]);
    }
    const columns = JSON.parse(undo.columns);
    if (columnsDigest(database, undo.table_name, columns) !== undo.after_digest) {
      throw new DataFormatError(format.store, 'data_format_changed_since', `Rows of FULI store "${format.store}" `
        + `changed after migration ${migrationId}, so undoing it would overwrite those changes. Nothing was changed. `
        + `Restoring the whole store from ${undo.backup_ref} would discard every change made since; that is a `
        + 'separate operation: a whole-store restore (Settings → Data format migrations).', [migrationId]);
    }
    const before = backupRows(path, format, undo.backup_ref, undo.table_name, columns);
    const backupRef = takeBackup(path, format, version, backup, [migrationId], { purpose: `undoing ${migrationId}` });
    // A column the migration added gets what adding it gave every row: its
    // declared default, or null. The column itself stays; a later apply reuses it.
    const added = new Map(database.prepare(`PRAGMA table_info(${undo.table_name})`).all()
      .filter((column) => columns.includes(column.name) && !before.columns.has(column.name))
      .map((column) => [column.name, column.dflt_value ?? 'NULL']));
    const kept = columns.filter((name) => !added.has(name));
    const update = database.prepare(`UPDATE ${undo.table_name} SET ${[...kept.map((name) => `${name} = ?`),
      ...[...added].map(([name, value]) => `${name} = ${value}`)].join(', ')} WHERE rowid = ?`);
    const rowids = database.prepare(`SELECT rowid AS id FROM ${undo.table_name}`).all().map((row) => row.id);
    for (const rowid of rowids) update.run(...kept.map((name) => before.rows.get(rowid)?.[name] ?? null), rowid);
    ledgerWriter(database, now)({ migration_id: migrationId, from_version: version, to_version: undo.from_version,
      kind: 'undo', status: 'rolled_back', backup_ref: backupRef,
      detail: `undone locally (${actor.entrypoint}, presence unverified): ${rowids.length} rows restored from `
        + `${undo.backup_ref}; undo ${undo.apply_id}` });
    database.prepare(`UPDATE ${UNDO_TABLE} SET state = 'rolled_back' WHERE apply_id = ?`).run(undo.apply_id);
    setUserVersion(database, undo.from_version);
    return { status: 'rolled_back', store: format.store, migrationId, applyId: undo.apply_id, backupRef,
      rows: rowids.length, version: undo.from_version };
  });
}

// What a whole-store restore from backupRef would discard, by counts only.
// restoreSqliteStore takes it back as `expected` and checks it again.
export function describeSqliteRestore(path, format, backupRef) {
  const backupPath = backupFile(path, format, backupRef);
  return restoreImpact(format, backupRef, existsSync(path) ? withReadOnly(path, storeShape) : EMPTY_SHAPE,
    withReadOnly(backupPath, storeShape));
}

function restoreImpact(format, backupRef, current, restored) {
  const takenAt = backupTime(backupRef);
  return { store: format.store, kind: 'sqlite', backupRef, takenAt, currentVersion: current.version,
    backupVersion: restored.version,
    tables: [...new Set([...Object.keys(current.tables), ...Object.keys(restored.tables)])].sort()
      .map((table) => ({ table, current: current.tables[table] ?? 0, backup: restored.tables[table] ?? 0 })),
    laterMigrations: current.ledger.filter((entry) => !takenAt || entry.recorded_at > takenAt)
      .map((entry) => ({ migrationId: entry.migration_id, status: entry.status })),
    currentDigest: current.digest,
    warning: `Every change to "${format.store}" made after ${takenAt ?? 'that backup'} is lost.` };
}

// Replaces the whole store with backupRef, on a person's explicit request
// only; it is never part of apply or rollback. It runs under the store's
// write lock, held from the check to the commit, so no writer of any process
// gets in between: the store must still be what the person saw (`expected`,
// from describeSqliteRestore), the store as it is is backed up, and its
// tables, indexes, triggers, version and ledger are replaced by the backup's
// in one transaction. A writer that tried meanwhile waits, then writes to
// the restored store, so nothing it wrote is lost to the restore.
export function restoreSqliteStore(path, format, { backupRef, expected, actor, backup = backupSqliteDatabase,
  now = () => new Date().toISOString(), stage = () => {} }) {
  const backupPath = backupFile(path, format, backupRef);
  const restoredVersion = withReadOnly(backupPath, userVersion);
  if (restoredVersion > format.version && !format.readableVersions.includes(restoredVersion)) {
    throw new DataFormatError(format.store, 'data_format_blocked', `Backup ${backupRef} of "${format.store}" uses `
      + `data format ${restoredVersion}, newer than this FULI supports (${format.version}). Nothing was changed.`);
  }
  const database = new DatabaseSync(path);
  try {
    database.exec(`PRAGMA busy_timeout = ${MIGRATION_LOCK_TIMEOUT_MS}`);
    database.prepare('ATTACH DATABASE ? AS restored').run(backupPath);
    try {
      database.exec('BEGIN IMMEDIATE');
      try {
        const result = swapStore(database, path, format, { backupRef, expected, actor, backup, now, stage });
        database.exec('COMMIT');
        return result;
      } catch (error) {
        if (database.isTransaction) database.exec('ROLLBACK');
        throw error;
      }
    } finally {
      database.exec('DETACH DATABASE restored');
    }
  } finally {
    database.close();
  }
}

const OBJECT_ORDER = Object.freeze({ view: 0, trigger: 1, index: 2, table: 3 });

function swapStore(database, path, format, { backupRef, expected, actor, backup, now, stage }) {
  const current = storeShape(database, 'main');
  const impact = restoreImpact(format, backupRef, current, storeShape(database, 'restored'));
  if (!expected || impact.currentDigest !== expected.currentDigest || impact.currentVersion !== expected.currentVersion) {
    throw new DataFormatError(format.store, 'data_format_stale_preview', `FULI store "${format.store}" changed after `
      + 'you saw what the restore discards. Nothing was changed; look at it again before restoring.');
  }
  const safetyRef = takeBackup(path, format, current.version, backup, [`${format.store}/restore`],
    { purpose: 'a whole-store restore' });
  stage('safety-backup');
  const objects = (schema) => database.prepare(`SELECT type, name, sql FROM ${schema}.sqlite_master
    WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL`).all();
  // Dropping a table drops its indexes and triggers; views go first.
  for (const object of objects('main').sort((a, b) => OBJECT_ORDER[a.type] - OBJECT_ORDER[b.type])) {
    if (object.type !== 'index') database.exec(`DROP ${object.type.toUpperCase()} IF EXISTS main."${object.name}"`);
  }
  const restored = objects('restored').sort((a, b) => OBJECT_ORDER[b.type] - OBJECT_ORDER[a.type]);
  for (const object of restored.filter(({ type }) => type === 'table')) {
    database.exec(object.sql);
    database.exec(`INSERT INTO main."${object.name}" SELECT * FROM restored."${object.name}"`);
  }
  for (const object of restored.filter(({ type }) => type !== 'table')) database.exec(object.sql);
  const sequences = (schema) => database.prepare(`SELECT 1 FROM ${schema}.sqlite_master
    WHERE name = 'sqlite_sequence'`).get();
  if (sequences('restored') && sequences('main')) {
    database.exec('DELETE FROM main.sqlite_sequence; INSERT INTO main.sqlite_sequence SELECT * FROM restored.sqlite_sequence');
  }
  setUserVersion(database, impact.backupVersion);
  ledgerWriter(database, now)({ migration_id: `${format.store}/restore`, from_version: current.version,
    to_version: impact.backupVersion, kind: 'restore', status: 'restored', backup_ref: safetyRef,
    detail: `whole store restored locally (${actor.entrypoint}, presence unverified) from ${backupRef}; changes `
      + `after ${impact.takenAt ?? 'that backup'} were discarded` });
  return { status: 'restored', store: format.store, backupRef, safetyBackupRef: safetyRef, version: impact.backupVersion };
}

// The backups of one store file, oldest first, with the version each was taken from.
export function sqliteBackupFiles(path) {
  return formatBackupsOf(path).map(({ ref, version, takenAt }) => ({ ref, version, takenAt }));
}

function withWriteLock(path, operation) {
  if (!existsSync(path)) throw new TypeError(`No store at ${basename(path)}`);
  const database = new DatabaseSync(path);
  try {
    database.exec(`PRAGMA busy_timeout = ${MIGRATION_LOCK_TIMEOUT_MS}`);
    database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation(database);
      database.exec('COMMIT');
      return result;
    } catch (error) {
      if (database.isTransaction) database.exec('ROLLBACK');
      throw error;
    }
  } finally {
    database.close();
  }
}

function appliedUndo(database, digest) {
  if (!digest || !userTables(database).includes(UNDO_TABLE)) return null;
  return database.prepare(`SELECT apply_id, migration_id FROM ${UNDO_TABLE} WHERE plan_digest = ?
    AND state = 'applied'`).get(digest) ?? null;
}

function stalePreview(store, plan) {
  return new DataFormatError(store, 'data_format_stale_preview', `FULI store "${store}" no longer matches the `
    + `preview that was confirmed${plan ? '' : ' (nothing waits for a person now)'}. Nothing was changed; run the `
    + 'preview again and confirm what it shows.', plan?.step ? [plan.step.id] : []);
}

// Every row of the table with the given columns: an insert, a delete or a
// changed value after the migration gives another digest.
function columnsDigest(database, table, columns) {
  const rows = database.prepare(`SELECT rowid AS id, ${columns.join(', ')} FROM ${table} ORDER BY rowid`).all();
  return contentHash(rows.map((row) => [row.id, ...columns.map((name) => plainValue(row[name]))]));
}

function plainValue(value) {
  return value instanceof Uint8Array ? `base64:${Buffer.from(value).toString('base64')}` : value;
}

// The values the backup holds; a column the migration added is absent there.
function backupRows(path, format, backupRef, table, columns) {
  const database = new DatabaseSync(backupFile(path, format, backupRef), { readOnly: true });
  try {
    const present = new Set(database.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
    const kept = columns.filter((name) => present.has(name));
    return { columns: new Set(kept), rows: new Map(database.prepare(`SELECT rowid AS id${kept.map((name) => `, ${name}`)
      .join('')} FROM ${table}`).all().map((row) => [row.id, row])) };
  } finally { database.close(); }
}

// Only a backup of this very store, inside its own backup directory.
function backupFile(path, format, backupRef) {
  const file = formatBackupPath(path, backupRef);
  if (!file) {
    throw new DataFormatError(format.store, 'data_format_backup_missing', `FULI store "${format.store}" has no `
      + `backup ${backupRef}; it may have been pruned. Nothing was changed.`);
  }
  return file;
}

// Row counts, version, ledger and a digest of every row of one schema of an
// open connection: what a restore would discard, and whether it changed.
function storeShape(database, schema = 'main') {
  const tables = database.prepare(`SELECT name FROM ${schema}.sqlite_master WHERE type = 'table'
    AND name NOT LIKE 'sqlite_%' ORDER BY name`).all().map((row) => row.name);
  const counts = {};
  const rows = {};
  for (const name of tables) {
    const all = database.prepare(`SELECT * FROM ${schema}."${name}"`).all();
    rows[name] = all.map((row) => Object.values(row).map(plainValue)).map((row) => JSON.stringify(row)).sort();
    if (!name.startsWith('fuli_format_')) counts[name] = all.length;
  }
  const ledger = tables.includes(LEDGER_TABLE) ? database.prepare(`SELECT migration_id, status, recorded_at
    FROM ${schema}.${LEDGER_TABLE} ORDER BY seq`).all() : [];
  const version = database.prepare(`PRAGMA ${schema}.user_version`).get().user_version;
  return { version, tables: counts, ledger, digest: contentHash({ version, rows }) };
}

// A store that does not exist reads as the empty file restoring creates.
const EMPTY_SHAPE = Object.freeze({ version: 0, tables: {}, ledger: [], digest: contentHash({ version: 0, rows: {} }) });

function withReadOnly(path, read) {
  const database = openReadOnly(path);
  try { return read(database); } finally { database.close(); }
}

function backupTime(backupRef) {
  return parseFormatBackupRef(backupRef)?.takenAt ?? null;
}
