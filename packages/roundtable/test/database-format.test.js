import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { inspectSqliteStore, openFormattedDatabase, sqliteFormat } from '../src/storage/database-format.js';
import { applyConfirmedSqliteMigration, previewSqliteMigration, rollbackSqliteMigration } from '../src/storage/database-migration.js';

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

test('an added table is created automatically for a fresh, a versioned and an unversioned store', (t) => {
  const LABELS = 'CREATE TABLE IF NOT EXISTS labels(note_id TEXT NOT NULL UNIQUE, label TEXT NOT NULL)';
  const withLabels = sqliteFormat({ store: 'notes', schema: NOTES_V1, migrations: [
    ...notesFormat().migrations,
    { id: 'notes/4-labels', summary: 'one label per note', to: 4, kind: 'add-table', table: 'labels', create: LABELS }
  ] });
  assert.throws(() => sqliteFormat({ store: 'notes', schema: NOTES_V1, migrations: [
    { id: 'notes/2-labels', summary: 'labels', to: 2, kind: 'add-table', table: 'labels' }] }), TypeError);
  const shapes = (path) => {
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      return database.prepare("SELECT name, sql FROM sqlite_master WHERE tbl_name = 'labels' ORDER BY name")
        .all().map((row) => [row.name, row.sql]);
    } finally { database.close(); }
  };
  const { directory } = fixture(t);
  const fresh = join(directory, 'fresh.sqlite');
  openFormattedDatabase(fresh, withLabels).close();
  const versioned = join(directory, 'versioned.sqlite');
  oldStore(versioned, `${NOTES_V1}; ALTER TABLE notes ADD COLUMN tags TEXT; ALTER TABLE notes ADD COLUMN checked TEXT;
    INSERT INTO notes VALUES('n1', 'kept', NULL, 'yes'); PRAGMA user_version = 3`);
  openFormattedDatabase(versioned, withLabels).close();
  const unversioned = join(directory, 'unversioned.sqlite');
  oldStore(unversioned, `${NOTES_V1}; ALTER TABLE notes ADD COLUMN checked TEXT`);
  openFormattedDatabase(unversioned, withLabels).close();

  for (const path of [fresh, versioned, unversioned]) {
    assert.equal(inspect(path).version, 4);
    assert.deepEqual(shapes(path), shapes(fresh));
  }
  assert.deepEqual(inspect(versioned).ledger.at(-1).migration_id, 'notes/4-labels');
  assert.deepEqual(inspect(versioned).rows, [{ id: 'n1', body: 'kept', tags: null, checked: 'yes' }]);
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

// replace-table: a table made again with another key; its rows are dropped, and the step says why.
const MARKS_V1 = 'CREATE TABLE IF NOT EXISTS marks(id TEXT PRIMARY KEY, note TEXT NOT NULL)';
const MARKS_V2 = 'CREATE TABLE marks(note TEXT NOT NULL, id TEXT NOT NULL, state TEXT, PRIMARY KEY(note, id))';
const replaceMarks = (create = MARKS_V2) => ({ id: 'notes/4-marks-per-note', summary: 'marks keyed per note', to: 4,
  kind: 'replace-table', table: 'marks', create, discardsRows: 'a mark only answers a repeated request' });
const withMarks = (step = replaceMarks()) => sqliteFormat({ store: 'notes', schema: `${NOTES_V1}; ${MARKS_V1}`,
  migrations: [...notesFormat().migrations, step] });
const markColumns = (path) => {
  const database = new DatabaseSync(path, { readOnly: true });
  try { return database.prepare('PRAGMA table_info(marks)').all().map((column) => column.name); } finally { database.close(); }
};

test('a replace-table step needs its CREATE statement and says why nothing needs the rows it drops', () => {
  const { create: _create, ...noCreate } = replaceMarks();
  assert.throws(() => withMarks(noCreate), /carries its CREATE statement/);
  const { discardsRows: _why, ...silent } = replaceMarks();
  assert.throws(() => withMarks(silent), /says in discardsRows why nothing needs the rows it drops/);
  assert.throws(() => withMarks({ ...replaceMarks(), discardsRows: ' ' }), /discardsRows/);
  assert.throws(() => sqliteFormat({ store: 'notes', schema: NOTES_V1, migrations: [{ id: 'notes/2-tags', summary: 'tags',
    to: 2, kind: 'add-columns', table: 'notes', columns: { tags: 'TEXT' }, discardsRows: 'not a replace' }] }), /discardsRows/);
});

test('a replace-table step makes the table again, keeps the other tables and records why it dropped the rows', (t) => {
  const { path } = fixture(t);
  oldStore(path, `${NOTES_V1}; ${MARKS_V1}; ALTER TABLE notes ADD COLUMN tags TEXT; ALTER TABLE notes ADD COLUMN checked TEXT;
    INSERT INTO notes VALUES('n1', 'kept', NULL, 'yes'); INSERT INTO marks VALUES('m1', 'n1'); PRAGMA user_version = 3`);

  openFormattedDatabase(path, withMarks()).close();

  const state = inspect(path);
  assert.equal(state.version, 4);
  assert.deepEqual(state.rows, [{ id: 'n1', body: 'kept', tags: null, checked: 'yes' }]);
  assert.deepEqual(markColumns(path), ['note', 'id', 'state']);
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM marks').get().count, 0);
    assert.equal(database.prepare("SELECT detail FROM fuli_format_ledger WHERE migration_id = 'notes/4-marks-per-note'").get().detail,
      'replaced marks; its earlier rows were not kept (a mark only answers a repeated request)');
  } finally { database.close(); }
});

test('a replace-table step whose CREATE fails rolls back: the old table and its rows stay', (t) => {
  const { path } = fixture(t);
  oldStore(path, `${NOTES_V1}; ${MARKS_V1}; ALTER TABLE notes ADD COLUMN tags TEXT; ALTER TABLE notes ADD COLUMN checked TEXT;
    INSERT INTO marks VALUES('m1', 'n1'); PRAGMA user_version = 3`);

  assert.throws(() => openFormattedDatabase(path, withMarks(replaceMarks('CREATE TABLE marks(note TEXT, state TEXT, BROKEN SYNTAX('))));

  assert.equal(inspect(path).version, 3);
  assert.deepEqual(markColumns(path), ['id', 'note']);
  const database = new DatabaseSync(path, { readOnly: true });
  try { assert.equal(database.prepare('SELECT COUNT(*) AS count FROM marks').get().count, 1); } finally { database.close(); }
});

test('a confirmed migration before a replace-table step can no longer be undone', (t) => {
  const { path } = fixture(t);
  oldStore(path, `${NOTES_V1}; ${MARKS_V1}; ALTER TABLE notes ADD COLUMN tags TEXT; INSERT INTO notes VALUES('n1', 'earlier', NULL);
    PRAGMA user_version = 2`);
  assert.throws(() => openFormattedDatabase(path, withMarks()), { code: 'data_format_pending' });
  const plan = previewSqliteMigration(path, withMarks());
  applyConfirmedSqliteMigration(path, withMarks(), { digest: plan.digest, actor: { entrypoint: 'cli' } });
  openFormattedDatabase(path, withMarks()).close();
  assert.equal(inspect(path).version, 4);

  assert.throws(() => rollbackSqliteMigration(path, withMarks(), { migrationId: 'notes/3-checked', actor: { entrypoint: 'cli' } }),
    { code: 'data_format_undo_blocked' });
  assert.equal(inspect(path).version, 4);
});

test('an unversioned store whose table already has the replaced shape is detected; one with the old shape waits for a person', (t) => {
  const { directory } = fixture(t);
  const current = join(directory, 'current.sqlite');
  oldStore(current, `${NOTES_V1}; ALTER TABLE notes ADD COLUMN tags TEXT; ALTER TABLE notes ADD COLUMN checked TEXT;
    ${MARKS_V2}; INSERT INTO marks VALUES('n1', 'm1', NULL)`);
  openFormattedDatabase(current, withMarks()).close();
  assert.equal(inspect(current).version, 4);
  const database = new DatabaseSync(current, { readOnly: true });
  try { assert.equal(database.prepare('SELECT COUNT(*) AS count FROM marks').get().count, 1, 'an unversioned store in effect keeps its rows'); }
  finally { database.close(); }

  const old = join(directory, 'old.sqlite');
  oldStore(old, `${NOTES_V1}; ${MARKS_V1}; INSERT INTO marks VALUES('m1', 'n1')`);
  assert.throws(() => openFormattedDatabase(old, withMarks()), { code: 'data_format_pending' });
  assert.deepEqual(markColumns(old), ['id', 'note'], 'nothing is dropped from a store FULI cannot place');
});
