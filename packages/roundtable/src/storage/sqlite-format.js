import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
// How a step that has not run yet is reported by inspectSqliteStore.
const INSPECTED_STATES = Object.freeze({ baseline_detected: 'detected', applied: 'automatic',
  pending_confirmation: 'pending_confirmation' });

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
      + 'FULI does not use the store until that migration is completed or the store is restored from a backup.',
      interrupted) };
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
  const backupRef = takeBackup(path, format, version, backup, steps.map((step) => step.migration_id));
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
      const mismatches = schemaMismatches(database, format);
      if (mismatches.length) {
        return [{ ...baseline, status: 'pending_confirmation', detail: `schema mismatch: ${mismatches.join('; ')}` }];
      }
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
    return [...steps, ...classifyMigrations(database, format, version, reached).map((step) => ({ ...step,
      migration_id: step.migration.id, from_version: step.migration.to - 1, to_version: step.migration.to,
      kind: step.migration.kind, run: () => applyMigration(database, step.migration) }))];
  } finally {
    database.exec('ROLLBACK TO format_plan');
    database.exec('RELEASE format_plan');
  }
}

// Each registered step after reached, read-only: in effect already (an
// unversioned store only), whitelisted, or waiting for a person, which ends
// the list.
function classifyMigrations(database, format, version, reached) {
  const steps = [];
  for (const migration of format.migrations.filter(({ to }) => to > reached)) {
    if (version === 0 && missingColumns(database, migration).length === 0) {
      steps.push({ migration, status: 'baseline_detected', detail: 'every column exists' });
      continue;
    }
    const rows = AUTOMATIC_KINDS.has(migration.kind) || !userTables(database).includes(migration.table)
      ? 0 : migration.rowsToBackfill(database);
    if (rows) {
      steps.push({ migration, status: 'pending_confirmation', detail: `${rows} existing rows need a backfill` });
      break;
    }
    steps.push({ migration, status: 'applied', detail: migration.kind === 'backfill'
      ? 'added columns; no existing row needed a backfill' : `added ${Object.keys(migration.columns).join(', ')}` });
  }
  return steps;
}

// What opening the store would find and do, without changing a byte: no DDL,
// no backup, no ledger row, no version stamp, and no -wal/-shm left beside a
// store FULI is not using. For `fuli migrate status` and the console's
// startup report; never a substitute for openFormattedDatabase.
export function inspectSqliteStore(path, format) {
  const report = { store: format.store, kind: 'sqlite', target: format.version, version: null, ledger: [], steps: [] };
  if (!existsSync(path)) return { ...report, state: 'absent', note: 'created at the current version on first use' };
  let database;
  try {
    database = openReadOnly(path);
  } catch (error) {
    return { ...report, state: 'unavailable', note: `cannot be opened read-only (${error.message})` };
  }
  try {
    return { ...report, ...inspectOpenStore(database, format) };
  } catch (error) {
    return { ...report, state: 'unavailable', note: `cannot be read (${error.message})` };
  } finally {
    database.close();
  }
}

// A WAL store whose log is gone has no live writer and is read as immutable,
// so SQLite creates no log or index; a live one is read through its own log.
function openReadOnly(path) {
  let database;
  if (!walMode(path)) database = new DatabaseSync(path, { readOnly: true });
  else if (existsSync(`${path}-wal`)) {
    if (!existsSync(`${path}-shm`)) throw new Error('its write-ahead log has no index; start FULI once');
    database = new DatabaseSync(path, { readOnly: true });
  } else {
    const uri = pathToFileURL(path);
    uri.searchParams.set('immutable', '1');
    database = new DatabaseSync(uri, { readOnly: true });
  }
  database.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  return database;
}

// Bytes 18 and 19 of the SQLite header are 2 for a write-ahead-log database.
function walMode(path) {
  const header = Buffer.alloc(20);
  const descriptor = openSync(path, 'r');
  try { readSync(descriptor, header, 0, 20, 0); } finally { closeSync(descriptor); }
  return header[18] === 2 && header[19] === 2;
}

function inspectOpenStore(database, format) {
  const version = userVersion(database);
  const ledger = userTables(database).includes(LEDGER_TABLE)
    ? database.prepare(`SELECT migration_id, from_version, to_version, status, backup_ref, detail, recorded_at
      FROM ${LEDGER_TABLE} ORDER BY seq`).all().map((row) => ({ migrationId: row.migration_id,
      fromVersion: row.from_version, toVersion: row.to_version, status: row.status, backupRef: row.backup_ref,
      detail: row.detail, recordedAt: row.recorded_at }))
    : [];
  if (version > format.version) {
    return { version, ledger, state: format.readableVersions.includes(version) ? 'newer_readable' : 'newer_format' };
  }
  const interrupted = unfinished(database);
  if (interrupted.length) {
    return { version, ledger, state: 'half_applied',
      steps: interrupted.map((id) => ({ id, state: 'half_applied', detail: 'started and did not finish' })) };
  }
  if (version === format.version) return { version, ledger, state: 'current' };
  if (version === 0 && !userTables(database).length) {
    return { version, ledger, state: 'empty', note: 'built at the current version on first use' };
  }
  const steps = [];
  if (version === 0) {
    const mismatches = schemaMismatches(database, format);
    if (mismatches.length) {
      return { version, ledger, state: 'pending_confirmation', steps: [{ id: `${format.store}/1-baseline`,
        state: 'pending_confirmation', detail: `schema mismatch: ${mismatches.join('; ')}` }] };
    }
    const declared = new DatabaseSync(':memory:');
    let missing;
    try {
      declared.exec(format.schema);
      const existing = new Set(schemaNames(database));
      missing = schemaNames(declared).filter((name) => !existing.has(name));
    } finally { declared.close(); }
    steps.push({ id: `${format.store}/1-baseline`, state: missing.length ? 'automatic' : 'detected',
      detail: missing.length ? `creates ${missing.join(', ')}; unique indexes are checked against existing rows then`
        : 'every baseline table and index exists' });
  }
  for (const step of classifyMigrations(database, format, version, Math.max(version, 1))) {
    steps.push({ id: step.migration.id, state: INSPECTED_STATES[step.status], detail: step.detail });
  }
  return { version, ledger, steps,
    state: steps.some((step) => step.state === 'pending_confirmation') ? 'pending_confirmation' : 'upgrade_on_open' };
}

// Where an unversioned store's tables mean something other than declared:
// columns, types, NOT NULL, defaults, primary keys, unique constraints and
// named indexes. A column a later step adds may be missing and a declared
// index may not exist yet; any other difference is a mismatch, never
// "already in effect".
function schemaMismatches(database, format) {
  const declared = new DatabaseSync(':memory:');
  try {
    declared.exec(format.schema);
    for (const migration of format.migrations) {
      for (const [name, type] of Object.entries(migration.columns)) {
        declared.exec(`ALTER TABLE ${migration.table} ADD COLUMN ${name} ${type}`);
      }
    }
    const later = new Set(format.migrations.flatMap(({ table, columns }) =>
      Object.keys(columns).map((name) => `${table}.${name}`)));
    const existing = new Set(userTables(database));
    return userTables(declared).filter((table) => existing.has(table)).flatMap((table) => [
      ...columnMismatches(table, columnShapes(declared, table), columnShapes(database, table), later),
      ...indexMismatches(table, indexShapes(declared, table), indexShapes(database, table))
    ]);
  } finally {
    declared.close();
  }
}

function columnShapes(database, table) {
  return new Map(database.prepare(`PRAGMA table_info(${table})`).all().map((column) => [column.name,
    `${String(column.type).toUpperCase()}${column.notnull ? ' NOT NULL' : ''}`
    + `${column.dflt_value === null ? '' : ` DEFAULT ${column.dflt_value}`}${column.pk ? ` PK${column.pk}` : ''}`]));
}

function columnMismatches(table, declared, existing, later) {
  const mismatches = [];
  for (const [name, shape] of existing) {
    if (!declared.has(name)) mismatches.push(`${table}.${name} is not declared`);
    else if (declared.get(name) !== shape) mismatches.push(`${table}.${name} is ${shape}, declared ${declared.get(name)}`);
  }
  for (const name of declared.keys()) {
    if (!existing.has(name) && !later.has(`${table}.${name}`)) mismatches.push(`${table}.${name} is missing`);
  }
  return mismatches;
}

// Constraint indexes (UNIQUE, PRIMARY KEY) by meaning, since SQLite names them
// itself; created indexes by name, with their columns, uniqueness and WHERE.
function indexShapes(database, table) {
  const constraints = [];
  const named = new Map();
  for (const index of database.prepare(`PRAGMA index_list(${table})`).all()) {
    const columns = database.prepare(`PRAGMA index_info("${index.name}")`).all().map((column) => column.name).join(',');
    const shape = `${index.unique ? 'unique ' : ''}(${columns})`;
    if (index.origin === 'c') {
      const sql = database.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(index.name)?.sql ?? '';
      const where = /\bWHERE\b(.*)$/is.exec(sql)?.[1].replace(/\s+/g, ' ').trim() ?? '';
      named.set(index.name, `${shape}${where ? ` WHERE ${where}` : ''}`);
    } else {
      constraints.push(`${index.origin} ${shape}`);
    }
  }
  return { constraints: constraints.sort(), named };
}

function indexMismatches(table, declared, existing) {
  const mismatches = [];
  if (declared.constraints.join(';') !== existing.constraints.join(';')) {
    mismatches.push(`${table} has keys ${existing.constraints.join(', ') || 'none'}, declared `
      + `${declared.constraints.join(', ') || 'none'}`);
  }
  for (const [name, shape] of declared.named) {
    if (existing.named.has(name) && existing.named.get(name) !== shape) {
      mismatches.push(`index ${name} is ${existing.named.get(name)}, declared ${shape}`);
    }
  }
  return mismatches;
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

function takeBackup(path, format, version, backup, stepIds) {
  if (path === ':memory:') return null;
  const directory = join(dirname(path), BACKUP_DIRECTORY);
  const name = `${basename(path)}.v${version}-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    backup(path, join(directory, name));
  } catch (error) {
    throw new DataFormatError(format.store, 'data_format_backup_failed',
      `FULI store "${format.store}" needs a format upgrade, but the backup before it failed `
      + `(${error.message}); nothing was changed.`, stepIds);
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
