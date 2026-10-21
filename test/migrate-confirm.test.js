import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { DataFormatError } from '../packages/roundtable/src/storage/data-format-error.js';
import { runMigrateCommand } from '../src/cli/migrate-command.js';
import {
  AUDIT_FAILED_NOTICE, GRAPH_PRUNE_UNVERIFIED_NOTICE, graphPruneUnverifiedLines, retentionLines
} from '../src/data-format/format-retention.js';
import { personalGraphFormat } from '../src/data-format/graph-format-client.js';
import { EXTERNAL_WRITERS_NOTICE } from '../src/data-format/external-writers.js';
import { dataFormatReceiptNotice } from '../src/data-format/format-notices.js';
import { holdDataDirectory } from '../src/data-format/maintenance-lock.js';
import { readFormatOperations } from '../src/data-format/operations-log.js';
import { createServer } from '../src/server.js';
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

// A data directory without a graph connection: the client finds no graph-runtime.json.
const noGraphSetUp = () => Object.assign(new Error('no graph here'), { code: 'ENOENT' });
const noGraph = { preview: async () => ({ plan: null, undoable: [] }),
  apply: async () => { throw new Error('no graph here'); }, rollback: async () => { throw new Error('no graph here'); },
  prune: async () => { throw noGraphSetUp(); } };

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
  const operations = readFormatOperations(root).filter((event) => event.kind === 'applied');
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

test('retrying a completed apply whose answer was lost returns its result, not a stale preview', async (t) => {
  const root = dataDir(t);
  legacyDataDir(root);
  const { plan } = await migrate(root, ['preview', '--json']);
  await migrate(root, ['apply', '--digest', plan.digest]);
  const before = snapshot(root);

  const retried = await migrate(root, ['apply', '--digest', plan.digest]);

  assert.equal(retried.exitCode, 0);
  assert.deepEqual(retried.results.map((result) => [result.label, result.status]), [
    ['task-schedules.sqlite', 'already_applied'], ['external-knowledge/bindings.json', 'already_applied']]);
  const changed = Object.keys(snapshot(root)).filter((name) => snapshot(root)[name] !== before[name]
    && name !== 'format-operations.json');
  assert.deepEqual(changed, []);
});

test('a console started while the restore question is open is refused, and so is a restore while it runs', async (t) => {
  const root = dataDir(t);
  legacyDataDir(root);
  const { plan } = await migrate(root, ['preview', '--json']);
  const applied = await migrate(root, ['apply', '--digest', plan.digest]);
  const backupRef = applied.results[0].backupRef;
  writeFileSync(join(root, 'graph-runtime.json'), JSON.stringify({ version: 1, personal: {
    providerUrl: 'http://127.0.0.1:1', accessToken: 'synthetic-token', principalId: 'p', spaceId: 's' }, workspaces: [] }));
  let consoleStart = null;

  const restored = await migrate(root, ['restore', '--store', 'task-schedules.sqlite', '--backup', backupRef], {
    confirm: async () => {
      // The person reads the warning; meanwhile FULI is started.
      consoleStart = await createServer({ port: 0, runtimeConfigPath: join(root, 'graph-runtime.json') })
        .then((server) => { server.server.close(); return 'started'; }, (error) => error.code);
      return true;
    } });

  assert.equal(consoleStart, 'data_format_maintenance');
  assert.equal(restored.status, 'restored');
  const release = holdDataDirectory(root);
  try {
    const refused = await migrate(root, ['restore', '--store', 'task-schedules.sqlite', '--backup', backupRef]);
    assert.deepEqual([refused.exitCode, refused.status], [1, 'console_running']);
    assert.equal(refused.questions.length, 0);
  } finally { release(); }
});

test('the terminal says what a deleting graph step loses before it asks', async (t) => {
  const root = dataDir(t);
  const warning = 'deletes the older duplicate learning-cache projections; the undo journal cannot restore deleted '
    + 'records (1 records deleted)';
  const graph = { ...noGraph, preview: async () => ({ undoable: [], plan: { store: 'graph', kind: 'neo4j', version: 1,
    target: 10, action: 'apply', automatic: [], undo: 'restore_only', warning, digest: 'e'.repeat(64),
    step: { id: 'graph/2-learning-bucket-ids', summary: 'stable IDs', kind: 'rewrite', fromVersion: 1, toVersion: 2,
      count: 2, sampleIds: ['keep:4:1', 'delete:4:2'], scopeDigest: 'd'.repeat(64) } } }) };
  const { plan } = await migrate(root, ['preview', '--json'], { graph });
  let shownBeforeQuestion = null;
  const lines = [];
  await runMigrateCommand(['apply', '--digest', plan.digest, '--data-dir', root], { env: {}, interactive: true, graph,
    write: (line) => lines.push(line),
    confirm: async () => { shownBeforeQuestion = lines.join('\n'); return false; } });

  assert.match(shownBeforeQuestion, /undo: only a whole restore/);
  assert.match(shownBeforeQuestion, /WARNING: deletes the older duplicate learning-cache projections; the undo journal cannot restore/);
});

test('a retry still finds its receipt after the same apply pruned hundreds of backups', async (t) => {
  const root = dataDir(t);
  legacyDataDir(root);
  const { plan } = await migrate(root, ['preview', '--json']);
  const applied = await migrate(root, ['apply', '--digest', plan.digest]);
  // An earlier FULI left 210 backups of earlier versions; pruning logs one event each.
  const source = join(root, applied.results[0].backupRef);
  for (let index = 0; index < 210; index += 1) {
    const stamp = `2025-01-01T00-00-${String(Math.floor(index / 10)).padStart(2, '0')}-${String(index % 10).padStart(3, '0')}Z`;
    copyFileSync(source, join(root, 'format-backups', `task-schedules.sqlite.v1-${stamp}.sqlite`));
  }
  const pruned = await migrate(root, ['prune', '--keep', '1']);
  assert.ok(pruned.pruned.length >= 200);
  assert.ok(!readFormatOperations(root).some((event) => event.kind === 'applied'), 'display events rolled over');

  const retried = await migrate(root, ['apply', '--digest', plan.digest]);

  assert.equal(retried.exitCode, 0);
  assert.deepEqual(retried.results.map((result) => result.status), ['already_applied', 'already_applied']);
});

test('prune keeps graph undo journals to the same target and logs what went, content-free', async (t) => {
  const root = dataDir(t);
  const requests = [];
  const j5 = { store: 'graph', applyId: 'j5', migrationId: 'graph/5-x', state: 'rolled_back', bytes: 812,
    reason: 'more than 3 undo journals' };
  const journals = ['j1', 'j2', 'j3', 'j4'].map((applyId, index) => ({ applyId, migrationId: 'graph/5-x',
    state: 'applied', recordedAt: `2026-10-0${5 - index}T00:00:00Z`, bytes: 100, protected: applyId === 'j1' }));
  const graph = { ...noGraph, prune: async (request) => {
    requests.push(request);
    return { kept: 4, protected: 'j1', pruned: [j5], journals };
  } };

  const dry = await migrate(root, ['prune', '--keep', '3', '--max-mb', '64', '--dry-run'], { graph });
  assert.equal(readFormatOperations(root).length, 0, 'a dry run logs nothing');
  const pruned = await migrate(root, ['prune', '--keep', '3', '--max-mb', '64'], { graph });

  // A dry run plans; a prune plans, then names the journals the shared size budget chose (none here).
  assert.deepEqual(requests, [{ keep: 3, dryRun: true }, { keep: 3, dryRun: true }, { keep: 3, applyIds: [] }]);
  assert.match(dry.output, /Would prune 1 graph undo journals; 4 kept/);
  for (const line of retentionLines({ keep: 3, maxBytes: 64 * 1024 * 1024 })) assert.ok(pruned.output.includes(line));
  assert.match(pruned.output, /at most about 64 MB/);
  assert.match(pruned.output, /graph \(personal\): undo journal j5 \(graph\/5-x, 812 bytes\) — more than 3 undo journals/);
  assert.match(pruned.output, /always kept, even beyond the budget/);
  assert.deepEqual(readFormatOperations(root).map((event) => [event.kind, event.store, event.backupRef]),
    [['pruned', 'graph', 'undo journal j5']]);
});

test('prune still prunes local backups when the graph cannot be reached', async (t) => {
  const root = dataDir(t);
  const graph = { ...noGraph, prune: async () => { throw new Error('its provider is not answering'); } };

  const result = await migrate(root, ['prune'], { graph });

  assert.equal(result.exitCode, 0);
  assert.match(result.output, /Graph undo journals were not pruned: its provider is not answering\. No delete was sent to the graph; local backups alone were held to the budget\./);
  assert.equal(result.status, 'unreached');
});

test('apply and undo say who must be stopped before they ask', async (t) => {
  const root = dataDir(t);
  legacyDataDir(root);
  const { plan } = await migrate(root, ['preview', '--json']);
  const asked = [];
  const capture = async (args) => {
    const lines = [];
    await runMigrateCommand([...args, '--data-dir', root], { env: {}, interactive: true, graph: noGraph,
      write: (line) => lines.push(line), confirm: async () => { asked.push(lines.join('\n')); return false; } });
  };
  await capture(['apply', '--digest', plan.digest]);
  await capture(['rollback', '--store', 'task-schedules.sqlite', '--migration', 'task-schedules/3-run-recovery']);

  assert.equal(asked.length, 2);
  for (const shown of asked) {
    assert.ok(shown.includes(EXTERNAL_WRITERS_NOTICE.zh) && shown.includes(EXTERNAL_WRITERS_NOTICE.en), shown);
  }
});

// A provider through the real graph client: it answers the dry run, then
// commits the delete and its answer is lost (a timeout on the way back).
function providerThatLosesTheDeleteAnswer(root) {
  writeFileSync(join(root, 'graph-runtime.json'), JSON.stringify({ personal: {
    providerUrl: 'http://127.0.0.1:9', accessToken: 'synthetic-access-token' } }));
  writeFileSync(join(root, 'graph-provider.env'), 'FULI_PERSONAL_HUMAN_REVIEW_TOKEN=synthetic-review-token\n');
  const journals = new Map([['j1', { applyId: 'j1', migrationId: 'graph/9-x', state: 'applied',
    recordedAt: '2026-10-05T00:00:00Z', bytes: 10, protected: true }],
  ['j5', { applyId: 'j5', migrationId: 'graph/5-x', state: 'rolled_back', recordedAt: '2026-10-01T00:00:00Z',
    bytes: 20, protected: false }]]);
  const fetchImpl = async (url, { body }) => {
    const request = JSON.parse(body);
    assert.ok(url.endsWith('/v1/data-format/prune'));
    if (request.dry_run) {
      return { ok: true, json: async () => ({ pruned: [{ ...journals.get('j5'), reason: 'more than 1 undo journals' }],
        kept: 1, protected: 'j1', journals: [journals.get('j1')] }) };
    }
    journals.delete('j5');
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  };
  return { graph: { ...noGraph, prune: personalGraphFormat(root, { fetchImpl }).prune }, journals };
}

test('a graph prune whose answer is lost after the provider committed is reported unverified, not as nothing pruned', async (t) => {
  const root = dataDir(t);
  const { graph, journals } = providerThatLosesTheDeleteAnswer(root);

  const result = await migrate(root, ['prune', '--keep', '1'], { graph });

  assert.ok(!journals.has('j5'), 'the provider did delete it');
  assert.equal(result.exitCode, 1);
  assert.equal(result.status, 'unverified');
  for (const line of graphPruneUnverifiedLines()) assert.ok(result.output.includes(line), result.output);
  assert.doesNotMatch(result.output, /Graph undo journals were not pruned|graph undo journals; \d+ kept/);
  assert.equal(result.graph.pruned, undefined, 'no count is claimed');
  assert.deepEqual(readFormatOperations(root).filter((event) => event.store === 'graph').map((event) => event.kind),
    ['prune_unverified']);
});

test('an apply whose graph prune answer is lost says the prune is unverified and keeps its own result', async (t) => {
  const root = dataDir(t);
  legacyDataDir(root);
  const { graph } = providerThatLosesTheDeleteAnswer(root);
  const { plan } = await migrate(root, ['preview', '--json']);

  const applied = await migrate(root, ['apply', '--digest', plan.digest], { graph });

  assert.equal(applied.status, 'applied');
  assert.ok(applied.pruned.some((entry) => entry.kind === 'prune_unverified'));
  assert.ok(applied.output.includes(GRAPH_PRUNE_UNVERIFIED_NOTICE.en), applied.output);
});

test('the console says an unverified graph prune in exactly the CLI wording', () => {
  const messages = readFileSync(new URL('../web/src/i18n/messages/data-format.ts', import.meta.url), 'utf8');
  assert.ok(messages.includes(`pruneUnverified: '${GRAPH_PRUNE_UNVERIFIED_NOTICE.zh}'`), 'Chinese wording');
  assert.ok(messages.includes(`pruneUnverified: '${GRAPH_PRUNE_UNVERIFIED_NOTICE.en}'`), 'English wording');
});

// As above, and the disk then refuses the local audit log: the operations
// log becomes unwritable just as the delete's answer is lost.
function providerThatLosesTheAnswerAndTheLog(root) {
  const provider = providerThatLosesTheDeleteAnswer(root);
  const prune = provider.graph.prune;
  provider.graph.prune = async (request) => {
    if (!request.dryRun) {
      rmSync(join(root, 'format-operations.json'), { force: true });
      mkdirSync(join(root, 'format-operations.json'));
    }
    return prune(request);
  };
  return provider;
}

test('a lost prune answer stays unverified when the audit log cannot be written either', async (t) => {
  const root = dataDir(t);
  const { graph, journals } = providerThatLosesTheAnswerAndTheLog(root);

  const result = await migrate(root, ['prune', '--keep', '1'], { graph });

  assert.ok(!journals.has('j5'), 'the provider did delete it');
  assert.equal(result.exitCode, 1);
  assert.equal(result.status, 'unverified');
  assert.equal(result.graph.status, 'unverified');
  assert.deepEqual(Object.keys(result.graph.auditError).sort(), ['code', 'message']);
  for (const line of graphPruneUnverifiedLines()) assert.ok(result.output.includes(line), result.output);
  assert.ok(result.output.includes('could not be written'), result.output);
});

test('an apply and an undo keep their result and the unverified prune when the audit log cannot be written', async (t) => {
  const root = dataDir(t);
  legacyDataDir(root);
  const { plan } = await migrate(root, ['preview', '--json']);
  const applied = await migrate(root, ['apply', '--digest', plan.digest],
    { graph: providerThatLosesTheAnswerAndTheLog(root).graph });

  assert.equal(applied.status, 'applied');
  assert.equal(applied.exitCode, 0);
  const unverified = applied.pruned.find((entry) => entry.kind === 'prune_unverified');
  assert.ok(unverified?.auditError?.code, JSON.stringify(applied.pruned));
  assert.ok(applied.output.includes(GRAPH_PRUNE_UNVERIFIED_NOTICE.en) && applied.output.includes('could not be written'));

  rmSync(join(root, 'format-operations.json'), { recursive: true, force: true });
  const undone = await migrate(root, ['rollback', '--store', 'task-schedules.sqlite',
    '--migration', 'task-schedules/3-run-recovery'], { graph: providerThatLosesTheAnswerAndTheLog(root).graph });

  assert.equal(undone.exitCode, 0);
  assert.equal(undone.status, 'rolled_back');
  assert.ok(undone.pruned.find((entry) => entry.kind === 'prune_unverified')?.auditError);
  assert.ok(undone.output.includes(GRAPH_PRUNE_UNVERIFIED_NOTICE.zh) && undone.output.includes('没有写成'));
});

test('the console says a failed audit write in exactly the CLI wording', () => {
  const messages = readFileSync(new URL('../web/src/i18n/messages/data-format.ts', import.meta.url), 'utf8');
  assert.ok(messages.includes(`auditFailed: '${AUDIT_FAILED_NOTICE.zh}'`), 'Chinese wording');
  assert.ok(messages.includes(`auditFailed: '${AUDIT_FAILED_NOTICE.en}'`), 'English wording');
});
