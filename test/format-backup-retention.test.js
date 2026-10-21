import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { applyConfirmedSqliteMigration, previewSqliteMigration } from
  '../packages/roundtable/src/storage/database-migration.js';
import { backupRetentionPolicy, pruneFormatBackups } from '../src/data-format/backup-retention.js';
import { readFormatOperations } from '../src/data-format/operations-log.js';
import { TASK_SCHEDULE_FORMAT } from '../src/task-schedules/store.js';

// rec#17 D-11 §5 / D-09 part 2: format backups are bounded, but never the one
// an undo needs, the latest ledger entry's, or the newest of the current version.

function migratedStore(t) {
  const root = mkdtempSync(join(tmpdir(), 'fuli-backup-retention-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'task-schedules.sqlite');
  const database = new DatabaseSync(path);
  database.exec(`CREATE TABLE task_schedules(id TEXT PRIMARY KEY, space TEXT NOT NULL, project TEXT NOT NULL,
      revision INTEGER NOT NULL, enabled INTEGER NOT NULL, body TEXT NOT NULL, next_run_at TEXT NOT NULL,
      paused_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE task_schedule_runs(schedule TEXT NOT NULL, slot TEXT NOT NULL, task_id TEXT, status TEXT NOT NULL,
      created_at TEXT NOT NULL, PRIMARY KEY(schedule, slot));
    INSERT INTO task_schedule_runs VALUES('s1', 'slot', NULL, 'claimed', '2026-01-01T00:00:00Z');`);
  database.close();
  const plan = previewSqliteMigration(path, TASK_SCHEDULE_FORMAT);
  const applied = applyConfirmedSqliteMigration(path, TASK_SCHEDULE_FORMAT, { digest: plan.digest,
    actor: { entrypoint: 'cli' } });
  // Older backups of earlier versions an earlier FULI left, oldest first.
  const backups = join(root, 'format-backups');
  const source = join(root, applied.backupRef);
  for (const [version, stamp] of [[0, '2026-01-01T00-00-00-000Z'], [1, '2026-02-01T00-00-00-000Z'],
    [2, '2026-03-01T00-00-00-000Z'], [2, '2026-04-01T00-00-00-000Z'], [3, '2026-05-01T00-00-00-000Z']]) {
    copyFileSync(source, join(backups, `task-schedules.sqlite.v${version}-${stamp}.sqlite`));
  }
  return { root, applied, backups };
}

test('pruning keeps what undo, the last applied version and the current version need', (t) => {
  const { root, applied, backups } = migratedStore(t);
  const undoBackup = applied.backupRef.replace('format-backups/', '');

  const dryRun = pruneFormatBackups(root, { policy: { keep: 0, maxBytes: 1 }, dryRun: true });
  assert.equal(readdirSync(backups).length, 6);
  const result = pruneFormatBackups(root, { policy: { keep: 0, maxBytes: 1 } });

  assert.deepEqual(result.pruned.map((entry) => entry.backupRef), dryRun.pruned.map((entry) => entry.backupRef));
  const left = readdirSync(backups).sort();
  assert.deepEqual(left, [undoBackup, 'task-schedules.sqlite.v3-2026-05-01T00-00-00-000Z.sqlite'].sort());
  assert.equal(result.pruned.length, 4);
  const logged = readFormatOperations(root).filter((event) => event.kind === 'pruned');
  assert.deepEqual(logged.map((event) => event.backupRef).sort(), result.pruned.map((entry) => entry.backupRef).sort());
  for (const event of logged) {
    assert.deepEqual(Object.keys(event).sort(), ['at', 'backupRef', 'bytes', 'kind', 'label', 'reason', 'store', 'version']);
  }
});

test('the newest backups within the count are kept and size is bounded next', (t) => {
  const { root, backups } = migratedStore(t);

  const result = pruneFormatBackups(root, { policy: { keep: 2, maxBytes: 10 * 1024 * 1024 } });

  assert.equal(result.pruned.length, 2);
  assert.ok(result.pruned.every((entry) => /more than 2 backups/.test(entry.reason)));
  assert.ok(!existsSync(join(backups, 'task-schedules.sqlite.v0-2026-01-01T00-00-00-000Z.sqlite')));
  assert.ok(existsSync(join(backups, 'task-schedules.sqlite.v2-2026-04-01T00-00-00-000Z.sqlite')));
});

test('the policy is configurable and rejects nonsense', () => {
  assert.deepEqual(backupRetentionPolicy({}), { keep: 3, maxBytes: 1024 * 1024 * 1024 });
  assert.deepEqual(backupRetentionPolicy({ FULI_FORMAT_BACKUP_KEEP: '5', FULI_FORMAT_BACKUP_MAX_MB: '64' }),
    { keep: 5, maxBytes: 64 * 1024 * 1024 });
  assert.deepEqual(backupRetentionPolicy({ FULI_FORMAT_BACKUP_KEEP: '5' }, { keep: 1 }).keep, 1);
  assert.throws(() => backupRetentionPolicy({ FULI_FORMAT_BACKUP_KEEP: '-1' }), /positive whole number/);
});
