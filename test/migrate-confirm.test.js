import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { DataFormatError } from '../packages/roundtable/src/storage/data-format-error.js';
import { runMigrateCommand } from '../src/cli/migrate-command.js';
import { dataFormatReceiptNotice } from '../src/data-format/format-notices.js';
import { readFormatOperations } from '../src/data-format/operations-log.js';
import { TaskScheduleStore } from '../src/task-schedules/store.js';

// rec#17 D-09 part 2: `fuli migrate preview|apply|rollback|restore` on a data
// directory an earlier FULI left behind. Synthetic stores only; the graph is a
// stub provider port (its real behavior is graph-provider/tests/
// test_graph_format_confirm_neo4j.py).

function dataDir(t) {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-migrate-confirm-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function legacyDataDir(root) {
  // Unversioned, from before run recovery: two runs need the backfill.
  const database = new DatabaseSync(join(root, 'task-schedules.sqlite'));
  database.exec(`CREATE TABLE task_schedules(id TEXT PRIMARY KEY, space TEXT NOT NULL, project TEXT NOT NULL,
      revision INTEGER NOT NULL, enabled INTEGER NOT NULL, body TEXT NOT NULL, next_run_at TEXT NOT NULL,
      paused_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE task_schedule_runs(schedule TEXT NOT NULL, slot TEXT NOT NULL, task_id TEXT, status TEXT NOT NULL,
      created_at TEXT NOT NULL, PRIMARY KEY(schedule, slot));
    INSERT INTO task_schedule_runs VALUES('s1', 'sentinel-slot-content', NULL, 'claimed', '2026-01-01T00:00:00Z'),
      ('s1', 'sentinel-slot-two', 'task-1', 'dispatched', '2026-01-02T00:00:00Z');`);
  database.close();
  mkdirSync(join(root, 'external-knowledge'), { recursive: true });
  writeFileSync(join(root, 'external-knowledge', 'bindings.json'), JSON.stringify({ version: 1, bindings: [{
    id: 'binding-1', name: 'Sentinel secret wiki', connectorType: 'mcp', connectorConfig: {}, source: {},
    target: { personalSpaceId: 'space', personalProjectId: 'project' }, mode: 'live', status: 'ready' }] }));
}

function snapshot(root) {
  const files = {};
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else files[relative(root, path)] = createHash('sha256').update(readFileSync(path)).digest('hex');
    }
  };
  walk(root);
  return files;
}

const noGraph = { preview: async () => ({ plan: null, undoable: [] }),
  apply: async () => { throw new Error('no graph here'); }, rollback: async () => { throw new Error('no graph here'); } };

async function migrate(root, args, { confirm = async () => true, graph = noGraph, interactive = true,
  consoleRunning = async () => false } = {}) {
  const lines = [];
  const questions = [];
  const result = await runMigrateCommand([...args, '--data-dir', root], { env: {}, interactive, graph, consoleRunning,
    write: (line) => lines.push(line), confirm: async (question) => { questions.push(question); return confirm(); } });
  return { ...result, output: lines.join('\n'), questions };
}

test('preview lists every waiting step by ID and count only, and changes nothing', async (t) => {
  const root = dataDir(t);
  legacyDataDir(root);
  const before = snapshot(root);

  const { plan, exitCode } = await migrate(root, ['preview', '--json']);
  const text = await migrate(root, ['preview']);

  assert.equal(exitCode, 0);
  assert.deepEqual(snapshot(root), before);
  assert.deepEqual(plan.stores.map((store) => [store.label, store.step.id, store.step.count]), [
    ['task-schedules.sqlite', 'task-schedules/3-run-recovery', 2],
    ['external-knowledge/bindings.json', 'external-knowledge/2-binding-targets', 1]]);
  assert.deepEqual(plan.stores[0].automatic, ['task-schedules/2-breaker-reset']);
  assert.deepEqual(plan.stores[0].step.sampleIds, ['s1#1', 's1#2']);
  assert.match(plan.digest, /^[0-9a-f]{64}$/);
  assert.match(text.output, /fuli migrate apply --digest [0-9a-f]{64}/);
  assert.match(text.output, /the digest is not a permission/);
  assert.doesNotMatch(JSON.stringify(plan) + text.output, /sentinel|Sentinel/, 'no record content');
});

test('changing data needs an interactive terminal and an exact, confirmed digest', async (t) => {
  const root = dataDir(t);
  legacyDataDir(root);
  const { plan } = await migrate(root, ['preview', '--json']);
  const before = snapshot(root);

  await assert.rejects(migrate(root, ['apply', '--digest', plan.digest], { interactive: false }),
    /asks you to confirm, so run it in an interactive terminal/);
  const wrong = await migrate(root, ['apply', '--digest', '0'.repeat(64)]);
  assert.deepEqual([wrong.exitCode, wrong.status], [1, 'stale']);
  assert.equal(wrong.questions.length, 0);
  const declined = await migrate(root, ['apply', '--digest', plan.digest], { confirm: async () => false });
  assert.equal(declined.status, 'cancelled');
  assert.match(declined.output, /task-schedules\/3-run-recovery[\s\S]*Cancelled\. Nothing was changed\./);
  assert.deepEqual(snapshot(root), before);
});

test('apply migrates both stores after a backup, logs it, and the receipt names it', async (t) => {
  const root = dataDir(t);
  legacyDataDir(root);
  const { plan } = await migrate(root, ['preview', '--json']);
  const pending = await dataFormatReceiptNotice(root)();
  assert.equal(pending, '数据格式待确认：task-schedules/3-run-recovery 等 2 项（fuli migrate preview）');

  const applied = await migrate(root, ['apply', '--digest', plan.digest]);

  assert.equal(applied.exitCode, 0);
  assert.deepEqual(applied.results.map((result) => [result.label, result.status]), [
    ['task-schedules.sqlite', 'applied'], ['external-knowledge/bindings.json', 'applied']]);
  assert.match(applied.questions[0], /presence unverified/);
  const store = new TaskScheduleStore(join(root, 'task-schedules.sqlite'));
  store.close();
  assert.equal(JSON.parse(readFileSync(join(root, 'external-knowledge', 'bindings.json'), 'utf8')).version, 2);
  assert.ok(readdirSync(join(root, 'format-backups')).some((name) => name.startsWith('task-schedules.sqlite.v0-')));
  assert.ok(readdirSync(join(root, 'external-knowledge', 'format-backups')).length === 1);
  const operations = readFormatOperations(root);
  assert.deepEqual(operations.map((event) => [event.kind, event.migrationId, event.entrypoint]), [
    ['applied', 'task-schedules/3-run-recovery', 'cli'], ['applied', 'external-knowledge/2-binding-targets', 'cli']]);
  assert.doesNotMatch(JSON.stringify(operations), /sentinel|Sentinel/);
  assert.equal((await migrate(root, ['preview', '--json'])).plan.digest, null);
  assert.equal(await dataFormatReceiptNotice(root)(),
    '数据格式已迁移：external-knowledge/2-binding-targets 等 2 项');
  assert.equal(await dataFormatReceiptNotice(root, { now: () => Date.now() + 25 * 3600 * 1000 })(), null);

  const undone = await migrate(root, ['rollback', '--store', 'task-schedules.sqlite',
    '--migration', 'task-schedules/3-run-recovery']);
  assert.equal(undone.version, 2);
  assert.throws(() => new TaskScheduleStore(join(root, 'task-schedules.sqlite')), { code: 'data_format_pending' });
  assert.equal(readFormatOperations(root).at(-1).kind, 'rolled_back');
});

test('a whole-store restore is separate, lists backups and refuses while FULI runs', async (t) => {
  const root = dataDir(t);
  legacyDataDir(root);
  const { plan } = await migrate(root, ['preview', '--json']);
  const applied = await migrate(root, ['apply', '--digest', plan.digest]);
  const backupRef = applied.results[0].backupRef;

  const listed = await migrate(root, ['restore', '--store', 'task-schedules.sqlite']);
  assert.ok(listed.backups.some((backup) => backup.ref === backupRef));
  const running = await migrate(root, ['restore', '--store', 'task-schedules.sqlite', '--backup', backupRef],
    { consoleRunning: async () => true });
  assert.deepEqual([running.exitCode, running.status], [1, 'console_running']);
  const restored = await migrate(root, ['restore', '--store', 'task-schedules.sqlite', '--backup', backupRef]);

  assert.match(restored.output, /Every change to "task-schedules" made after .* is lost/);
  assert.equal(restored.status, 'restored');
  assert.equal(restored.version, 0);
  assert.equal(readFormatOperations(root).at(-1).kind, 'restored');
  await assert.rejects(migrate(root, ['restore', '--store', 'graph (personal)', '--backup', 'x']),
    /offline: fuli graph import/);
});

test('apply checks the plan again and stops at a store that fails, keeping what applied', async (t) => {
  const root = dataDir(t);
  legacyDataDir(root);
  const graphPlan = { store: 'graph', kind: 'neo4j', version: 8, target: 10, action: 'apply', automatic: [],
    step: { id: 'graph/9-group-id-separators', summary: 'group IDs', kind: 'rewrite', fromVersion: 8, toVersion: 9,
      count: 1, sampleIds: ['space-1'], scopeDigest: 'd'.repeat(64) }, undo: 'available', digest: 'e'.repeat(64) };
  const calls = [];
  const graph = { preview: async () => ({ plan: graphPlan, undoable: [] }), rollback: async () => ({}),
    apply: async (digest, entrypoint) => {
      calls.push([digest, entrypoint]);
      throw new DataFormatError('graph', 'data_format_stale_preview', 'The graph no longer matches the preview.');
    } };
  const { plan } = await migrate(root, ['preview', '--json'], { graph });
  assert.equal(plan.stores.at(-1).label, 'graph (personal)');

  const result = await migrate(root, ['apply', '--digest', plan.digest], { graph });

  assert.equal(result.exitCode, 1);
  assert.equal(result.status, 'partial');
  assert.deepEqual(calls, [['e'.repeat(64), 'cli']]);
  assert.deepEqual(result.results.map((entry) => entry.status), ['applied', 'applied', 'failed']);
  assert.match(result.output, /graph \(personal\): not applied \(data_format_stale_preview\)/);
});
