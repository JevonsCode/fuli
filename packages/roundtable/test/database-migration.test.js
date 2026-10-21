import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { openFormattedDatabase, sqliteFormat } from '../src/storage/database-format.js';
import {
  applyConfirmedSqliteMigration, describeSqliteRestore, previewSqliteMigration, restoreSqliteStore,
  rollbackSqliteMigration, sqliteBackupFiles, undoableSqliteMigrations
} from '../src/storage/database-migration.js';

// rec#17 D-09 part 2 for one SQLite store. Synthetic stores only: version 1
// notes, an automatic column (v2) and a backfill of earlier rows (v3) that
// waits for a person, the shapes FULI's stores declare.
const NOTES_V1 = 'CREATE TABLE IF NOT EXISTS notes(id TEXT PRIMARY KEY, body TEXT NOT NULL)';
const CLI = { entrypoint: 'cli' };

function notesFormat({ backfill = (db) => db.exec("UPDATE notes SET checked = 'yes'") } = {}) {
  return sqliteFormat({
    store: 'notes', schema: NOTES_V1,
    migrations: [
      { id: 'notes/2-tags', summary: 'note tags', to: 2, kind: 'add-columns', table: 'notes', columns: { tags: 'TEXT' } },
      { id: 'notes/3-checked', summary: 'a checked mark on every note', to: 3, kind: 'backfill', table: 'notes',
        columns: { checked: 'TEXT' }, backfill,
        backfillKeys: (db) => db.prepare('SELECT id FROM notes ORDER BY id').all().map((row) => row.id) }
    ]
  });
}

// A store an earlier FULI left at version 2: its notes predate the checked mark.
function oldStore(t, rows = ["('n1', 'secret body one')", "('n2', 'secret body two')"]) {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-database-migration-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'notes.sqlite');
  const database = new DatabaseSync(path);
  database.exec(`${NOTES_V1}; ALTER TABLE notes ADD COLUMN tags TEXT; INSERT INTO notes(id, body) VALUES ${rows.join(', ')};
    PRAGMA user_version = 2`);
  database.close();
  return { directory, path };
}

function state(path) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
    return {
      version: database.prepare('PRAGMA user_version').get().user_version,
      rows: database.prepare('SELECT * FROM notes ORDER BY id').all().map((row) => ({ ...row })),
      ledger: tables.includes('fuli_format_ledger')
        ? database.prepare('SELECT migration_id, status FROM fuli_format_ledger ORDER BY seq').all()
          .map((row) => [row.migration_id, row.status]) : []
    };
  } finally { database.close(); }
}

const backups = (directory) => existsSync(join(directory, 'format-backups'))
  ? readdirSync(join(directory, 'format-backups')) : [];

test('preview names the waiting step and its rows by key only, and changes nothing', (t) => {
  const { directory, path } = oldStore(t);
  const before = readFileSync(path);

  const plan = previewSqliteMigration(path, notesFormat());

  assert.deepEqual({ ...plan, digest: undefined }, { store: 'notes', kind: 'sqlite', version: 2, target: 3,
    action: 'apply', automatic: [], undo: 'available', digest: undefined,
    step: { id: 'notes/3-checked', summary: 'a checked mark on every note', kind: 'backfill', fromVersion: 2,
      toVersion: 3, count: 2, sampleIds: ['n1', 'n2'], scopeDigest: plan.step.scopeDigest } });
  assert.match(plan.digest, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(plan), /secret body/);
  assert.deepEqual(readFileSync(path), before);
  assert.deepEqual(backups(directory), []);
  assert.equal(previewSqliteMigration(join(directory, 'absent.sqlite'), notesFormat()), null);
});

test('apply with the previewed digest backs up, migrates and opens the store for writes', (t) => {
  const { directory, path } = oldStore(t);
  const plan = previewSqliteMigration(path, notesFormat());

  const result = applyConfirmedSqliteMigration(path, notesFormat(), { digest: plan.digest, actor: CLI });

  assert.equal(result.status, 'applied');
  assert.deepEqual([result.migrationId, result.count, result.fromVersion, result.toVersion], ['notes/3-checked', 2, 2, 3]);
  const after = state(path);
  assert.equal(after.version, 3);
  assert.deepEqual(after.rows.map((row) => row.checked), ['yes', 'yes']);
  assert.deepEqual(after.ledger, [['notes/3-checked', 'applied']]);
  assert.deepEqual(backups(directory), [result.backupRef.replace('format-backups/', '')]);
  // The backup is the store before the migration.
  assert.deepEqual(state(join(directory, result.backupRef)).version, 2);
  openFormattedDatabase(path, notesFormat()).close();
  assert.equal(previewSqliteMigration(path, notesFormat()), null);
  assert.deepEqual(undoableSqliteMigrations(path, notesFormat()).map((entry) => entry.migrationId), ['notes/3-checked']);
});

test('a stale preview is refused before any write when the rows changed', (t) => {
  const { directory, path } = oldStore(t);
  const plan = previewSqliteMigration(path, notesFormat());
  const database = new DatabaseSync(path);
  database.exec("INSERT INTO notes(id, body) VALUES('n3', 'written after the preview')");
  database.close();
  const before = readFileSync(path);

  assert.throws(() => applyConfirmedSqliteMigration(path, notesFormat(), { digest: plan.digest, actor: CLI }),
    { code: 'data_format_stale_preview', message: /no longer matches the preview.*run the preview again/ });
  assert.deepEqual(readFileSync(path), before);
  assert.deepEqual(backups(directory), []);
  assert.notEqual(previewSqliteMigration(path, notesFormat()).digest, plan.digest);
});

test('a failed backup changes nothing and the same confirmation can run again', (t) => {
  const { directory, path } = oldStore(t);
  const plan = previewSqliteMigration(path, notesFormat());
  const before = readFileSync(path);

  assert.throws(() => applyConfirmedSqliteMigration(path, notesFormat(), { digest: plan.digest, actor: CLI,
    backup: () => { throw new Error('disk full'); } }),
  { code: 'data_format_backup_failed', message: /migration notes\/3-checked, but the backup before it failed \(disk full\)/ });
  assert.deepEqual(readFileSync(path), before);
  assert.deepEqual(backups(directory), []);

  assert.equal(applyConfirmedSqliteMigration(path, notesFormat(), { digest: plan.digest, actor: CLI }).status, 'applied');
});

test('an interrupted apply rolls back completely and the rerun applies once', (t) => {
  const { path } = oldStore(t);
  const plan = previewSqliteMigration(path, notesFormat());
  const crashing = notesFormat({ backfill: (db) => {
    db.exec("UPDATE notes SET checked = 'yes' WHERE id = 'n1'");
    throw new Error('power cut');
  } });

  assert.throws(() => applyConfirmedSqliteMigration(path, crashing, { digest: plan.digest, actor: CLI }), /power cut/);
  const interrupted = state(path);
  assert.equal(interrupted.version, 2);
  assert.ok(interrupted.rows.every((row) => row.checked === undefined));
  assert.deepEqual(interrupted.ledger, []);

  applyConfirmedSqliteMigration(path, notesFormat(), { digest: plan.digest, actor: CLI });
  assert.deepEqual(state(path).ledger, [['notes/3-checked', 'applied']]);
});

test('two processes applying the same confirmation migrate once', async (t) => {
  const { directory, path } = oldStore(t);
  const plan = previewSqliteMigration(path, notesFormat());
  const engine = new URL('../src/storage/database-migration.js', import.meta.url).href;
  const format = new URL('../src/storage/database-format.js', import.meta.url).href;
  const script = `import { sqliteFormat } from ${JSON.stringify(format)};
    import { applyConfirmedSqliteMigration } from ${JSON.stringify(engine)};
    const format = sqliteFormat({ store: 'notes', schema: ${JSON.stringify(NOTES_V1)}, migrations: [
      { id: 'notes/2-tags', summary: 'note tags', to: 2, kind: 'add-columns', table: 'notes', columns: { tags: 'TEXT' } },
      { id: 'notes/3-checked', summary: 'a checked mark on every note', to: 3, kind: 'backfill', table: 'notes',
        columns: { checked: 'TEXT' }, backfill: (db) => db.exec("UPDATE notes SET checked = 'yes'"),
        backfillKeys: (db) => db.prepare('SELECT id FROM notes ORDER BY id').all().map((row) => row.id) }] });
    const result = applyConfirmedSqliteMigration(process.argv[1], format, { digest: process.argv[2], actor: { entrypoint: 'cli' } });
    process.stdout.write(result.status);`;
  const run = () => new Promise((resolve) => {
    let output = '';
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, path, plan.digest]);
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.on('exit', (code) => resolve([code, output]));
  });

  const results = await Promise.all([run(), run()]);

  assert.deepEqual(results.map(([code]) => code), [0, 0]);
  assert.deepEqual(results.map(([, output]) => output).sort(), ['already_applied', 'applied']);
  assert.deepEqual(state(path).ledger, [['notes/3-checked', 'applied']]);
  assert.equal(backups(directory).length, 1);
});

test('undo restores what the migration changed and leaves the step waiting again', (t) => {
  const { directory, path } = oldStore(t);
  const plan = previewSqliteMigration(path, notesFormat());
  applyConfirmedSqliteMigration(path, notesFormat(), { digest: plan.digest, actor: CLI });

  const undone = rollbackSqliteMigration(path, notesFormat(), { migrationId: 'notes/3-checked', actor: CLI });

  assert.deepEqual([undone.status, undone.rows, undone.version], ['rolled_back', 2, 2]);
  const after = state(path);
  assert.equal(after.version, 2);
  assert.deepEqual(after.rows.map((row) => [row.id, row.body, row.checked]),
    [['n1', 'secret body one', null], ['n2', 'secret body two', null]]);
  assert.deepEqual(after.ledger, [['notes/3-checked', 'applied'], ['notes/3-checked', 'rolled_back']]);
  assert.equal(backups(directory).length, 2, 'the undo is itself preceded by a backup');
  assert.deepEqual(undoableSqliteMigrations(path, notesFormat()), []);
  assert.throws(() => openFormattedDatabase(path, notesFormat()), { code: 'data_format_pending' });
  assert.equal(previewSqliteMigration(path, notesFormat()).action, 'apply');
});

test('undo is refused, changing nothing, once a migrated row changed afterwards', (t) => {
  const { directory, path } = oldStore(t);
  const plan = previewSqliteMigration(path, notesFormat());
  applyConfirmedSqliteMigration(path, notesFormat(), { digest: plan.digest, actor: CLI });
  const database = openFormattedDatabase(path, notesFormat());
  database.exec("UPDATE notes SET checked = 'no' WHERE id = 'n2'");
  database.close();
  const before = readFileSync(path);

  assert.throws(() => rollbackSqliteMigration(path, notesFormat(), { migrationId: 'notes/3-checked', actor: CLI }),
    { code: 'data_format_changed_since', message: /changed after migration notes\/3-checked.*Nothing was changed.*fuli migrate restore/ });
  assert.deepEqual(readFileSync(path), before);
  assert.equal(backups(directory).length, 1);
  assert.throws(() => rollbackSqliteMigration(path, notesFormat(), { migrationId: 'notes/2-tags', actor: CLI }),
    { code: 'data_format_nothing_to_undo' });
});

test('a whole-store restore says what it discards, keeps a safety backup and is recorded', (t) => {
  const { directory, path } = oldStore(t);
  const plan = previewSqliteMigration(path, notesFormat());
  const applied = applyConfirmedSqliteMigration(path, notesFormat(), { digest: plan.digest, actor: CLI });
  const database = openFormattedDatabase(path, notesFormat());
  database.exec("INSERT INTO notes(id, body, checked) VALUES('n3', 'written after the migration', 'yes')");
  database.close();

  const impact = describeSqliteRestore(path, notesFormat(), applied.backupRef);
  assert.deepEqual([impact.currentVersion, impact.backupVersion], [3, 2]);
  assert.deepEqual(impact.tables, [{ table: 'notes', current: 3, backup: 2 }]);
  assert.deepEqual(impact.laterMigrations, [{ migrationId: 'notes/3-checked', status: 'applied' }]);
  assert.match(impact.warning, /made after .* is lost/);

  const restored = restoreSqliteStore(path, notesFormat(), { backupRef: applied.backupRef, expected: impact, actor: CLI });

  assert.equal(restored.version, 2);
  const after = state(path);
  assert.deepEqual(after.rows.map((row) => row.id), ['n1', 'n2']);
  assert.deepEqual(after.ledger, [['notes/restore', 'restored']]);
  assert.ok(existsSync(join(directory, restored.safetyBackupRef)));
  assert.equal(state(join(directory, restored.safetyBackupRef)).rows.length, 3, 'the discarded state is kept');
  assert.deepEqual(sqliteBackupFiles(path).map((entry) => entry.version), [2, 3]);
  assert.throws(() => restoreSqliteStore(path, notesFormat(), { backupRef: '../notes.sqlite', expected: impact, actor: CLI }),
    { code: 'data_format_backup_missing' });
});

test('undo is refused when a newer FULI moved the store on, even with the migrated rows unchanged', (t) => {
  const { path } = oldStore(t);
  const plan = previewSqliteMigration(path, notesFormat());
  applyConfirmedSqliteMigration(path, notesFormat(), { digest: plan.digest, actor: CLI });
  // A future FULI stamps v4 without touching the checked column.
  const database = new DatabaseSync(path);
  database.exec('ALTER TABLE notes ADD COLUMN future TEXT; PRAGMA user_version = 4');
  database.close();
  const before = readFileSync(path);

  assert.throws(() => rollbackSqliteMigration(path, notesFormat(), { migrationId: 'notes/3-checked', actor: CLI }),
    { code: 'data_format_blocked', message: /uses data format 4, newer than this FULI supports \(3\)/ });
  assert.deepEqual(readFileSync(path), before);
  assert.equal(state(path).version, 4);
});

test('a restore re-checks the store the person saw inside its lock and stops if it changed', (t) => {
  const { directory, path } = oldStore(t);
  const plan = previewSqliteMigration(path, notesFormat());
  const applied = applyConfirmedSqliteMigration(path, notesFormat(), { digest: plan.digest, actor: CLI });
  const impact = describeSqliteRestore(path, notesFormat(), applied.backupRef);
  // Written after the person read the warning (say, by a console started meanwhile).
  const writer = openFormattedDatabase(path, notesFormat());
  writer.exec("INSERT INTO notes(id, body, checked) VALUES('n3', 'written while the prompt was open', 'yes')");
  writer.close();
  const before = readFileSync(path);

  assert.throws(() => restoreSqliteStore(path, notesFormat(), { backupRef: applied.backupRef, expected: impact, actor: CLI }),
    { code: 'data_format_stale_preview', message: /changed after you saw what the restore discards/ });
  assert.deepEqual(readFileSync(path), before);
  assert.equal(backups(directory).length, 1, 'no safety backup either: nothing started');
});

test('no other writer gets in between the safety backup and the overwrite', (t) => {
  const { path } = oldStore(t);
  const plan = previewSqliteMigration(path, notesFormat());
  const applied = applyConfirmedSqliteMigration(path, notesFormat(), { digest: plan.digest, actor: CLI });
  const impact = describeSqliteRestore(path, notesFormat(), applied.backupRef);
  let refused = null;

  const restored = restoreSqliteStore(path, notesFormat(), { backupRef: applied.backupRef, expected: impact, actor: CLI,
    stage: (name) => {
      if (name !== 'safety-backup') return;
      const writer = new DatabaseSync(path);
      try {
        writer.exec('PRAGMA busy_timeout = 50');
        writer.exec("INSERT INTO notes(id, body) VALUES('late', 'a write in the restore window')");
      } catch (error) {
        refused = error;
      } finally { writer.close(); }
    } });

  assert.match(String(refused?.message), /database is locked/);
  assert.equal(restored.version, 2);
  assert.deepEqual(state(path).rows.map((row) => row.id), ['n1', 'n2']);
  // The safety backup holds exactly what was replaced.
  assert.equal(state(join(dirname(path), restored.safetyBackupRef)).version, 3);
});

test('a connection opened before an undo stops writing instead of writing the old format', (t) => {
  const { path } = oldStore(t);
  const plan = previewSqliteMigration(path, notesFormat());
  applyConfirmedSqliteMigration(path, notesFormat(), { digest: plan.digest, actor: CLI });
  const open = openFormattedDatabase(path, notesFormat());
  try {
    open.prepare("INSERT INTO notes(id, body, checked) VALUES('n3', 'before the undo', 'yes')").run();
    open.prepare("DELETE FROM notes WHERE id = 'n3'").run();

    rollbackSqliteMigration(path, notesFormat(), { migrationId: 'notes/3-checked', actor: CLI });

    assert.throws(() => open.prepare("INSERT INTO notes(id, body) VALUES('n4', 'after the undo')").run(),
      { code: 'data_format_changed_underneath', message: /moved to data format 2 .* Nothing was written; restart FULI/ });
    assert.throws(() => open.exec("UPDATE notes SET body = 'x'"), { code: 'data_format_changed_underneath' });
    assert.equal(open.prepare('SELECT count(*) AS n FROM notes').get().n, 2, 'reads still work');
  } finally { open.close(); }
  assert.deepEqual(state(path).rows.map((row) => row.id), ['n1', 'n2']);
});
