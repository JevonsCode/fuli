import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { applyConfirmedSqliteMigration, previewSqliteMigration } from
  '../packages/roundtable/src/storage/database-migration.js';
import { backupRetentionPolicy, pruneFormatBackups } from '../src/data-format/backup-retention.js';
import { pruneFormatRetention, RETENTION_BUDGET_NOTICE, retentionLines } from '../src/data-format/format-retention.js';
import { dataFormatMigrations } from '../src/data-format/migration-operations.js';
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

test('a store whose ledger cannot be read keeps every backup', (t) => {
  const { root, backups } = migratedStore(t);
  const database = new DatabaseSync(join(root, 'task-schedules.sqlite'));
  database.exec('DROP TABLE fuli_format_ledger; CREATE TABLE fuli_format_ledger(garbage TEXT)');
  database.close();

  const result = pruneFormatBackups(root, { policy: { keep: 0, maxBytes: 1 } });

  assert.deepEqual(result.pruned, []);
  assert.equal(readdirSync(backups).length, 6);
});

const GIB = 1024 * 1024 * 1024;

test('local backups and graph undo journals share one size budget, oldest unprotected first', async (t) => {
  const { root, backups } = migratedStore(t);
  // keep=2 leaves two unprotected local backups, 0.4 GiB each (0.8 GiB); the
  // ones an undo or the current version needs are tiny.
  const large = new Set(['task-schedules.sqlite.v2-2026-03-01T00-00-00-000Z.sqlite',
    'task-schedules.sqlite.v2-2026-04-01T00-00-00-000Z.sqlite']);
  const sizeOf = (path) => (large.has(basename(path)) ? 0.4 * GIB : 1);
  // The graph: the journal an undo needs, and two unprotected ones of 0.4 GiB (0.8 GiB).
  const journals = [
    { applyId: 'j1', migrationId: 'graph/9-x', state: 'applied', recordedAt: '2026-06-01T00:00:00.123456789Z',
      bytes: 10, protected: true },
    { applyId: 'j2', migrationId: 'graph/8-x', state: 'applied', recordedAt: '2026-03-15T00:00:00Z',
      bytes: 0.4 * GIB, protected: false },
    { applyId: 'j3', migrationId: 'graph/7-x', state: 'applied', recordedAt: '2026-02-15T00:00:00Z',
      bytes: 0.4 * GIB, protected: false }];
  const requests = [];
  const graph = { prune: async (request) => {
    requests.push(request);
    if (request.dryRun) return { pruned: [], kept: 3, protected: 'j1', journals };
    return { pruned: request.applyIds.map((applyId) => ({ ...journals.find((j) => j.applyId === applyId),
      store: 'graph', reason: 'over the shared size budget' })), kept: 3 - request.applyIds.length };
  } };
  const policy = { keep: 2, maxBytes: GIB };

  const dry = await pruneFormatRetention({ dataDir: root, graph, policy, dryRun: true, sizeOf });
  assert.equal(readdirSync(backups).length, 6, 'a dry run removes nothing');
  const result = await pruneFormatRetention({ dataDir: root, graph, policy, sizeOf });

  // 1.6 GiB unprotected: j3 (Feb 15) and then the March 1 backup go, oldest
  // first across both, and 0.8 GiB stays.
  assert.deepEqual(requests.at(-1), { keep: 2, applyIds: ['j3'] });
  assert.deepEqual(result.graph.pruned.map((entry) => entry.backupRef), ['undo journal j3']);
  assert.deepEqual(dry.graph.pruned.map((entry) => entry.backupRef), ['undo journal j3']);
  const sized = result.local.pruned.filter((entry) => /use more than/.test(entry.reason));
  assert.deepEqual(sized.map((entry) => entry.backupRef),
    ['format-backups/task-schedules.sqlite.v2-2026-03-01T00-00-00-000Z.sqlite']);
  assert.deepEqual(dry.local.pruned.map((entry) => entry.backupRef), result.local.pruned.map((entry) => entry.backupRef));
  assert.ok(result.local.bytesKept <= GIB && result.local.bytesKept >= 0.8 * GIB);
  assert.equal(result.graph.pruned[0].reason, 'format backups and graph undo journals use more than 1024 MB');
  assert.ok(existsSync(join(backups, 'task-schedules.sqlite.v2-2026-04-01T00-00-00-000Z.sqlite')));
});

test('what an undo needs stays even when it alone is over the shared budget', async (t) => {
  const { root, applied, backups } = migratedStore(t);
  const graph = { prune: async (request) => (request.dryRun
    ? { pruned: [], kept: 1, protected: 'j1', journals: [{ applyId: 'j1', migrationId: 'graph/9-x',
      state: 'applied', recordedAt: '2026-06-01T00:00:00Z', bytes: 2 * GIB, protected: true }] }
    : { pruned: [], kept: 1 }) };

  const result = await pruneFormatRetention({ dataDir: root, graph, policy: { keep: 0, maxBytes: GIB } });

  assert.deepEqual(result.graph.pruned, []);
  assert.ok(existsSync(join(root, applied.backupRef)));
  assert.equal(readdirSync(backups).length, 2);
});

test('the console says the retention budget in exactly the CLI wording', () => {
  const messages = readFileSync(new URL('../web/src/i18n/messages/data-format.ts', import.meta.url), 'utf8');
  assert.ok(messages.includes(`retention: '${RETENTION_BUDGET_NOTICE.zh}'`), 'Chinese wording');
  assert.ok(messages.includes(`retention: '${RETENTION_BUDGET_NOTICE.en}'`), 'English wording');
  assert.deepEqual(retentionLines({ keep: 3, maxBytes: GIB }).map((line) => /\{/.test(line)), [false, false]);
  assert.match(retentionLines({ keep: 3, maxBytes: GIB })[1],
    /newest 3 format backups and the graph its newest 3 undo journals; backups and journals together use at most about 1024 MB/);
});

test('the console preview carries the budget it says', async (t) => {
  const { root } = migratedStore(t);
  const graph = { preview: async () => ({ plan: null, undoable: [] }) };

  const preview = await dataFormatMigrations(root, { graph }).preview();

  assert.deepEqual(preview.retention, backupRetentionPolicy());
});
