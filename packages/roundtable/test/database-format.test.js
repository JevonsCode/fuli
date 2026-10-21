import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { inspectSqliteStore, openFormattedDatabase, sqliteFormat } from '../src/storage/database-format.js';

// Synthetic stores only: a version 1 table, an automatic column (v2) and a
// backfill of earlier rows (v3), the shapes FULI's stores declare.
const NOTES_V1 = 'CREATE TABLE IF NOT EXISTS notes(id TEXT PRIMARY KEY, body TEXT NOT NULL)';
function notesFormat({ backfill = (db) => db.exec("UPDATE notes SET checked = 'yes'"), readableVersions = [] } = {}) {
  return sqliteFormat({
    store: 'notes', schema: NOTES_V1, readableVersions,
    migrations: [
      { id: 'notes/2-tags', summary: 'note tags', to: 2, kind: 'add-columns', table: 'notes', columns: { tags: 'TEXT' } },
      { id: 'notes/3-checked', summary: 'a checked mark on every note', to: 3, kind: 'backfill', table: 'notes',
        columns: { checked: 'TEXT' }, backfillKeys: (db) => db.prepare('SELECT id FROM notes ORDER BY id').all().map((row) => row.id),
        backfill }
    ]
  });
}

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-database-format-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, path: join(directory, 'notes.sqlite') };
}

function oldStore(path, sql) {
  const database = new DatabaseSync(path);
  database.exec(sql);
  database.close();
}

function inspect(path) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      version: database.prepare('PRAGMA user_version').get().user_version,
      columns: database.prepare('PRAGMA table_info(notes)').all().map((column) => column.name),
      tables: database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
        .map((row) => row.name),
      rows: database.prepare('SELECT * FROM notes ORDER BY id').all().map((row) => ({ ...row })),
      ledger: database.prepare("SELECT name FROM sqlite_master WHERE name = 'fuli_format_ledger'").get()
        ? database.prepare('SELECT migration_id, status, backup_ref FROM fuli_format_ledger ORDER BY seq').all()
          .map((row) => ({ ...row }))
        : []
    };
  } finally { database.close(); }
}

const backups = (directory) => existsSync(join(directory, 'format-backups'))
  ? readdirSync(join(directory, 'format-backups')) : [];

test('a fresh store is built at the current version without a backup', (t) => {
  const { directory, path } = fixture(t);
  openFormattedDatabase(path, notesFormat()).close();

  const state = inspect(path);
  assert.equal(state.version, 3);
  assert.deepEqual(state.columns, ['id', 'body', 'tags', 'checked']);
  assert.deepEqual(state.ledger.map((row) => [row.migration_id, row.status]), [['notes/created', 'created']]);
  assert.deepEqual(backups(directory), []);
});

test('an unversioned store is backed up with the online backup API, then detected and upgraded', (t) => {
  const { directory, path } = fixture(t);
  oldStore(path, `${NOTES_V1}; ALTER TABLE notes ADD COLUMN checked TEXT; INSERT INTO notes VALUES('n1', 'kept', 'no')`);

  openFormattedDatabase(path, notesFormat()).close();

  const state = inspect(path);
  assert.equal(state.version, 3);
  assert.deepEqual(state.rows, [{ id: 'n1', body: 'kept', checked: 'no', tags: null }]);
  assert.deepEqual(state.ledger.map((row) => [row.migration_id, row.status]), [
    ['notes/1-baseline', 'baseline_detected'], ['notes/2-tags', 'applied'], ['notes/3-checked', 'baseline_detected']]);
  const [backup] = backups(directory);
  assert.match(backup, /^notes\.sqlite\.v0-.*\.sqlite$/);
  assert.ok(state.ledger.every((row) => row.backup_ref === `format-backups/${backup}`));
  // The backup is the store before the upgrade, so restoring it undoes it.
  const before = inspect(join(directory, 'format-backups', backup));
  assert.deepEqual([before.version, before.columns, before.rows],
    [0, ['id', 'body', 'checked'], [{ id: 'n1', body: 'kept', checked: 'no' }]]);
});

test('earlier rows that need a backfill wait for a person and are backed up only once', (t) => {
  const { directory, path } = fixture(t);
  oldStore(path, `${NOTES_V1}; INSERT INTO notes VALUES('n1', 'earlier')`);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.throws(() => openFormattedDatabase(path, notesFormat()), { code: 'data_format_pending', store: 'notes',
      status: 503, message: /notes\/3-checked .*1 existing rows need a backfill.*until a person confirms/ });
  }

  const state = inspect(path);
  assert.equal(state.version, 2);
  assert.deepEqual(state.rows, [{ id: 'n1', body: 'earlier', tags: null }]);
  assert.deepEqual(state.ledger.map((row) => [row.migration_id, row.status]), [
    ['notes/1-baseline', 'baseline_detected'], ['notes/2-tags', 'applied'], ['notes/3-checked', 'pending_confirmation']]);
  assert.equal(backups(directory).length, 1);
});

test('a backfill with no earlier row is only a declaration and runs on its own', (t) => {
  const { path } = fixture(t);
  oldStore(path, `${NOTES_V1}; ALTER TABLE notes ADD COLUMN tags TEXT; PRAGMA user_version = 2`);

  openFormattedDatabase(path, notesFormat()).close();

  assert.equal(inspect(path).version, 3);
  assert.deepEqual(inspect(path).ledger.at(-1), { migration_id: 'notes/3-checked', status: 'applied',
    backup_ref: inspect(path).ledger.at(-1).backup_ref });
});

test('a failed backup changes nothing', (t) => {
  const { directory, path } = fixture(t);
  oldStore(path, NOTES_V1);

  assert.throws(() => openFormattedDatabase(path, notesFormat(), { backup: () => { throw new Error('disk full'); } }),
    { code: 'data_format_backup_failed', message: /backup before it failed \(disk full\); nothing was changed/ });

  const state = inspect(path);
  assert.deepEqual([state.version, state.columns, state.ledger], [0, ['id', 'body'], []]);
  assert.deepEqual(backups(directory), []);
});

test('an interrupted migration rolls back completely and runs again on the next open', (t) => {
  const { path } = fixture(t);
  oldStore(path, `${NOTES_V1}; ALTER TABLE notes ADD COLUMN tags TEXT; PRAGMA user_version = 2`);
  // Earlier rows exist only inside the interrupted transaction.
  const crashing = sqliteFormat({ ...notesFormat(), migrations: [notesFormat().migrations[0], {
    ...notesFormat().migrations[1], backfillKeys: () => [], backfill: () => { throw new Error('power cut'); } }] });

  assert.throws(() => openFormattedDatabase(path, crashing), /power cut/);
  const interrupted = inspect(path);
  assert.deepEqual([interrupted.version, interrupted.columns], [2, ['id', 'body', 'tags']]);
  assert.deepEqual(interrupted.ledger, []);

  openFormattedDatabase(path, notesFormat()).close();
  assert.equal(inspect(path).version, 3);
});

test('a newer store is refused before any schema change or write', (t) => {
  const { path } = fixture(t);
  oldStore(path, `${NOTES_V1}; PRAGMA user_version = 9`);

  assert.throws(() => openFormattedDatabase(path, notesFormat()), { code: 'data_format_blocked',
    message: /"notes" uses data format 9, newer than this FULI supports \(3\)\. Upgrade FULI, or restore/ });

  const state = inspect(path);
  assert.deepEqual([state.version, state.tables, state.columns], [9, ['notes'], ['id', 'body']]);
});

test('a newer store declared readable opens read-only', (t) => {
  const { path } = fixture(t);
  oldStore(path, `${NOTES_V1}; INSERT INTO notes VALUES('n1', 'future'); PRAGMA user_version = 4`);

  const database = openFormattedDatabase(path, notesFormat({ readableVersions: [4] }));
  try {
    assert.deepEqual({ ...database.prepare('SELECT body FROM notes').get() }, { body: 'future' });
    assert.throws(() => database.exec("INSERT INTO notes VALUES('n2', 'refused')"), /readonly/);
  } finally { database.close(); }
  assert.equal(inspect(path).version, 4);
});

test('a migration whose ledger says it never finished blocks the store', (t) => {
  const { path } = fixture(t);
  openFormattedDatabase(path, notesFormat()).close();
  const database = new DatabaseSync(path);
  database.prepare(`INSERT INTO fuli_format_ledger(migration_id, from_version, to_version, kind, status, recorded_at)
    VALUES('notes/4-split', 3, 4, 'rewrite', 'started', 'synthetic')`).run();
  database.close();

  assert.throws(() => openFormattedDatabase(path, notesFormat()), { code: 'data_format_interrupted',
    message: /notes\/4-split.*did not finish/ });
});

test('a baseline unique index that earlier rows violate waits for a person', (t) => {
  const { path } = fixture(t);
  oldStore(path, "CREATE TABLE notes(id TEXT, body TEXT NOT NULL); INSERT INTO notes VALUES('n1','a'),('n1','b')");
  const unique = sqliteFormat({ store: 'notes', schema: `CREATE TABLE IF NOT EXISTS notes(id TEXT, body TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS notes_id ON notes(id)` });

  assert.throws(() => openFormattedDatabase(path, unique), { code: 'data_format_pending',
    message: /notes\/1-baseline .*UNIQUE constraint failed/ });
  const state = inspect(path);
  assert.equal(state.rows.length, 2);
  assert.deepEqual(state.ledger.map((row) => row.status), ['pending_confirmation']);
});

test('a declaration that could break earlier rows is rejected when the store loads', () => {
  assert.throws(() => sqliteFormat({ store: 'notes', schema: NOTES_V1, migrations: [{ id: 'notes/2-x', summary: 'x',
    to: 2, kind: 'add-columns', table: 'notes', columns: { x: 'TEXT NOT NULL' } }] }), /NOT NULL column without a default/);
  assert.throws(() => sqliteFormat({ store: 'notes', schema: NOTES_V1, migrations: [{ id: 'notes/3-x', summary: 'x',
    to: 3, kind: 'add-columns', table: 'notes', columns: { x: 'TEXT' } }] }), /version 2/);
  assert.throws(() => sqliteFormat({ store: 'notes', schema: NOTES_V1, migrations: [{ id: 'notes/2-x', summary: 'x',
    to: 2, kind: 'rewrite', table: 'notes', columns: {} }] }), /unknown kind/);
});

test('two processes opening one old store migrate it once', async (t) => {
  const { directory, path } = fixture(t);
  oldStore(path, `${NOTES_V1}; INSERT INTO notes VALUES('n1', 'shared')`);
  const engine = new URL('../src/storage/database-format.js', import.meta.url).href;
  const script = `import { openFormattedDatabase, sqliteFormat } from ${JSON.stringify(engine)};
    const format = sqliteFormat({ store: 'notes', schema: ${JSON.stringify(NOTES_V1)}, migrations: [{ id: 'notes/2-tags',
      summary: 'note tags', to: 2, kind: 'add-columns', table: 'notes', columns: { tags: 'TEXT' } }] });
    openFormattedDatabase(process.argv[1], format).close();`;
  const run = () => new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, path], { stdio: 'inherit' });
    child.on('exit', resolve);
  });

  assert.deepEqual(await Promise.all([run(), run()]), [0, 0]);

  const state = inspect(path);
  assert.equal(state.version, 2);
  assert.deepEqual(state.ledger.map((row) => row.migration_id), ['notes/1-baseline', 'notes/2-tags']);
  assert.equal(backups(directory).length, 1);
});

test('a same-named table that means something else is a mismatch, never current', (t) => {
  const { directory, path } = fixture(t);
  // No primary key and a nullable body: duplicate IDs survive in this table.
  oldStore(path, "CREATE TABLE notes(id TEXT, body TEXT); INSERT INTO notes VALUES('n1','a'),('n1',NULL)");
  const before = readFileSync(path);

  const report = inspectSqliteStore(path, notesFormat());
  assert.equal(report.state, 'pending_confirmation');
  assert.match(report.steps[0].detail, /schema mismatch: notes.id is TEXT, declared TEXT PK1; notes.body is TEXT, declared TEXT NOT NULL/);
  assert.deepEqual(readFileSync(path), before);

  assert.throws(() => openFormattedDatabase(path, notesFormat()), { code: 'data_format_pending',
    steps: ['notes/1-baseline'], message: /schema mismatch: .*notes has keys none, declared pk unique \(id\)/ });
  assert.equal(inspect(path).version, 0);
  assert.equal(backups(directory).length, 1);
});

test('a same-named index over other columns is a mismatch', (t) => {
  const { path } = fixture(t);
  const indexed = sqliteFormat({ store: 'notes', schema: `${NOTES_V1}; CREATE INDEX IF NOT EXISTS notes_body ON notes(body)` });
  oldStore(path, `${NOTES_V1}; CREATE INDEX notes_body ON notes(id)`);

  assert.match(inspectSqliteStore(path, indexed).steps[0].detail, /index notes_body is \(id\), declared \(body\)/);
});
