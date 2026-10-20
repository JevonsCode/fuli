import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { DataFormatError, newerFormatError, pendingMigrationError } from './data-format-error.js';

// The data format of a local SQLite store (rec#17 D-09): its version, the
// migrations that reach it and the ledger of what was applied. A store opens
// its file only through openFormattedDatabase, which checks the format before
// any DDL or write:
// - a fresh file is built at the current version;
// - an unversioned file (written before this registry) is inspected: a step
//   already in effect is recorded as detected, a whitelisted step is applied;
// - a step that would change existing records stops there: the store is
//   unavailable until a person confirms the migration;
// - a newer file is opened read-only only when its version is declared
//   readable, otherwise refused;
// - any change to an existing file follows a consistent backup made with
//   SQLite's online backup API; a failed backup changes nothing.
// A migration, its ledger rows and the new version commit in one transaction,
// so an interrupted migration leaves the previous version and simply runs again.

const LEDGER = `CREATE TABLE IF NOT EXISTS fuli_format_ledger(
  seq INTEGER PRIMARY KEY AUTOINCREMENT, migration_id TEXT NOT NULL, from_version INTEGER NOT NULL,
  to_version INTEGER NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, backup_ref TEXT, detail TEXT,
  recorded_at TEXT NOT NULL)`;
const LEDGER_TABLE = 'fuli_format_ledger';
const BUSY_TIMEOUT_MS = 5000;
const BACKUP_TIMEOUT_MS = 120_000;
// Another process may hold the store while it backs it up and migrates it.
const MIGRATION_LOCK_TIMEOUT_MS = BACKUP_TIMEOUT_MS + 30_000;
const BACKUP_DIRECTORY = 'format-backups';
const BACKUP_PROCESS = fileURLToPath(new URL('./sqlite-backup-process.js', import.meta.url));
// The automatic whitelist: columns that are nullable or carry a constant
// default. A backfill of existing rows runs only when no row needs it; any
// other kind always waits for a person.
const AUTOMATIC_KINDS = new Set(['add-columns']);
const KINDS = new Set(['add-columns', 'backfill']);

// Validates a store's declaration once, at module load.
export function sqliteFormat({ store, schema, migrations = [], pragmas = '', readableVersions = [] }) {
  if (!/^[a-z][a-z0-9-]*$/.test(store)) throw new TypeError(`Invalid store id ${store}`);
  migrations.forEach((migration, index) => {
    if (!migration.id?.startsWith(`${store}/`) || !migration.summary) {
      throw new TypeError(`Each ${store} migration needs an id under ${store}/ and a summary`);
    }
    if (migration.to !== index + 2) throw new TypeError(`${migration.id} must move ${store} to version ${index + 2}`);
    if (!KINDS.has(migration.kind)) throw new TypeError(`${migration.id} has an unknown kind`);
    if (migration.kind === 'backfill' && !(migration.rowsToBackfill && migration.backfill)) {
      throw new TypeError(`${migration.id} must count and fill the rows it backfills`);
    }
    for (const type of Object.values(migration.columns)) {
      if (/\bNOT NULL\b/i.test(type) && !/\bDEFAULT\b/i.test(type)) {
        throw new TypeError(`${migration.id} adds a NOT NULL column without a default`);
      }
    }
  });
  return Object.freeze({ store, schema, migrations: Object.freeze([...migrations]), pragmas,
    readableVersions: Object.freeze([...readableVersions]), version: migrations.length + 1 });
}

export function openFormattedDatabase(path, format, { backup = backupSqliteDatabase,
  now = () => new Date().toISOString() } = {}) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(path);
  let access;
  try {
    database.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    access = prepareFormat(database, path, format, { backup, now });
    if (access === 'write') {
      if (format.pragmas) database.exec(format.pragmas);
      return database;
    }
  } catch (error) {
    database.close();
    throw error;
  }
  database.close();
  const readOnly = new DatabaseSync(path, { readOnly: true });
  readOnly.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  return readOnly;
}

function prepareFormat(database, path, format, options) {
  const version = userVersion(database);
  if (version > format.version) return newerAccess(format, version);
  if (version === format.version && !unfinished(database).length) return 'write';
  database.exec(`PRAGMA busy_timeout = ${MIGRATION_LOCK_TIMEOUT_MS}`);
  let outcome;
  try {
    database.exec('BEGIN IMMEDIATE');
    outcome = migrate(database, path, format, options);
    database.exec(outcome.commit ? 'COMMIT' : 'ROLLBACK');
  } catch (error) {
    if (database.isTransaction) database.exec('ROLLBACK');
    throw error;
  } finally {
    database.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  }
  if (outcome.error) throw outcome.error;
  return outcome.access;
}

// Runs inside BEGIN IMMEDIATE: another process may have migrated meanwhile.
function migrate(database, path, format, { backup, now }) {
  const version = userVersion(database);
  if (version > format.version) return { access: newerAccess(format, version) };
  const interrupted = unfinished(database);
  if (interrupted.length) {
    return { error: new DataFormatError(format.store, 'data_format_interrupted',
      `FULI store "${format.store}" has a migration (${interrupted.join(', ')}) that started and did not finish. `
      + 'FULI does not use the store until that migration is completed or the store is restored from a backup.') };
  }
  if (version === format.version) return { access: 'write' };
  const record = ledgerWriter(database, now);
  if (version === 0 && !userTables(database).length) {
    database.exec(format.schema);
    for (const migration of format.migrations) applyMigration(database, migration);
    record({ migration_id: `${format.store}/created`, from_version: 0, to_version: format.version,
      kind: 'schema', status: 'created', detail: 'a fresh store built at the current version' });
    setUserVersion(database, format.version);
    return { access: 'write', commit: true };
  }
  const steps = planSteps(database, format, version);
  const pending = steps.find((step) => step.status === 'pending_confirmation');
  const recorded = latestEntries(database);
  const changes = steps.filter((step) => step !== pending
    || recorded.get(step.migration_id)?.status !== step.status || recorded.get(step.migration_id)?.detail !== step.detail);
  if (!changes.length) return { error: pendingMigrationError(format.store, pending.migration, pending.detail) };
  const backupRef = takeBackup(path, format, version, backup);
  for (const step of steps) {
    if (step.status === 'applied') step.run();
    record({ ...step, backup_ref: backupRef });
  }
  const reached = steps.filter((step) => step !== pending).at(-1)?.to_version ?? version;
  setUserVersion(database, reached);
  if (pending) return { commit: true, error: pendingMigrationError(format.store, pending.migration, pending.detail) };
  return { access: 'write', commit: true };
}

// What opening would do, decided inside a savepoint that is always rolled
// back, so the backup is taken before anything changes. The baseline schema
// is tried here first: a unique index existing rows violate fails now.
function planSteps(database, format, version) {
  database.exec('SAVEPOINT format_plan');
  try {
    const steps = [];
    let reached = version;
    if (version === 0) {
      const baseline = { migration: { id: `${format.store}/1-baseline`, summary: 'the baseline tables and indexes' },
        migration_id: `${format.store}/1-baseline`, from_version: 0, to_version: 1, kind: 'schema',
        run: () => database.exec(format.schema) };
      const before = new Set(schemaNames(database));
      try {
        database.exec(format.schema);
      } catch (error) {
        return [{ ...baseline, status: 'pending_confirmation',
          detail: `existing rows conflict with the baseline schema (${error.message})` }];
      }
      const added = schemaNames(database).filter((name) => !before.has(name));
      steps.push({ ...baseline, status: added.length ? 'applied' : 'baseline_detected',
        detail: added.length ? `created ${added.join(', ')}` : 'every baseline table and index exists' });
      reached = 1;
    }
    for (const migration of format.migrations.filter(({ to }) => to > reached)) {
      const step = { migration, migration_id: migration.id, from_version: migration.to - 1, to_version: migration.to,
        kind: migration.kind, run: () => applyMigration(database, migration) };
      if (version === 0 && missingColumns(database, migration).length === 0) {
        steps.push({ ...step, status: 'baseline_detected', detail: 'every column exists' });
        continue;
      }
      const rows = AUTOMATIC_KINDS.has(migration.kind) ? 0 : migration.rowsToBackfill(database);
      if (rows) {
        steps.push({ ...step, status: 'pending_confirmation', detail: `${rows} existing rows need a backfill` });
        break;
      }
      steps.push({ ...step, status: 'applied', detail: migration.kind === 'backfill'
        ? 'added columns; no existing row needed a backfill' : `added ${Object.keys(migration.columns).join(', ')}` });
    }
    return steps;
  } finally {
    database.exec('ROLLBACK TO format_plan');
    database.exec('RELEASE format_plan');
  }
}

function newerAccess(format, version) {
  if (format.readableVersions.includes(version)) return 'read';
  throw newerFormatError(format.store, version, format.version);
}

function applyMigration(database, migration) {
  for (const name of missingColumns(database, migration)) {
    database.exec(`ALTER TABLE ${migration.table} ADD COLUMN ${name} ${migration.columns[name]}`);
  }
  if (migration.kind === 'backfill') migration.backfill(database);
}

function takeBackup(path, format, version, backup) {
  if (path === ':memory:') return null;
  const directory = join(dirname(path), BACKUP_DIRECTORY);
  const name = `${basename(path)}.v${version}-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    backup(path, join(directory, name));
  } catch (error) {
    throw new DataFormatError(format.store, 'data_format_backup_failed',
      `FULI store "${format.store}" needs a format upgrade, but the backup before it failed `
      + `(${error.message}); nothing was changed.`);
  }
  return `${BACKUP_DIRECTORY}/${name}`;
}

// SQLite's online backup API copies a consistent snapshot of a store other
// connections are using. Store opening is synchronous and node:sqlite's
// backup() is not, so it runs to completion in a short-lived child process
// while this connection holds the store's write lock.
export function backupSqliteDatabase(source, target) {
  const result = spawnSync(process.execPath, [BACKUP_PROCESS, source, target],
    { encoding: 'utf8', timeout: BACKUP_TIMEOUT_MS, windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || `backup exited with ${result.status}`);
}

function ledgerWriter(database, now) {
  let created = false;
  return (row) => {
    if (!created) { database.exec(LEDGER); created = true; }
    database.prepare(`INSERT INTO ${LEDGER_TABLE}(migration_id, from_version, to_version, kind, status, backup_ref,
      detail, recorded_at) VALUES(?,?,?,?,?,?,?,?)`).run(row.migration_id, row.from_version, row.to_version, row.kind,
      row.status, row.backup_ref ?? null, row.detail ?? null, now());
  };
}

function latestEntries(database) {
  if (!userTables(database).includes(LEDGER_TABLE)) return new Map();
  return new Map(database.prepare(`SELECT migration_id, status, detail FROM ${LEDGER_TABLE} ORDER BY seq`).all()
    .map((row) => [row.migration_id, row]));
}

// Migrations whose latest ledger row says they started and never finished.
// This engine commits a migration with its ledger rows, so only a step that
// runs outside one transaction could leave one.
function unfinished(database) {
  if (!userTables(database).includes(LEDGER_TABLE)) return [];
  return database.prepare(`SELECT migration_id FROM ${LEDGER_TABLE} AS entry WHERE status = 'started'
    AND seq = (SELECT max(seq) FROM ${LEDGER_TABLE} WHERE migration_id = entry.migration_id)`).all()
    .map((row) => row.migration_id);
}

function userVersion(database) {
  return database.prepare('PRAGMA user_version').get().user_version;
}

function setUserVersion(database, version) {
  database.exec(`PRAGMA user_version = ${Number(version)}`);
}

function userTables(database) {
  return database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all().map((row) => row.name);
}

function schemaNames(database) {
  return database.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all().map((row) => row.name);
}

function missingColumns(database, migration) {
  const existing = new Set(database.prepare(`PRAGMA table_info(${migration.table})`).all().map((column) => column.name));
  return Object.keys(migration.columns).filter((name) => !existing.has(name));
}
