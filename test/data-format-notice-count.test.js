import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { dataFormatReceiptNotice } from '../src/data-format/format-notices.js';
import { readFormatOperations, recordFormatOperations } from '../src/data-format/operations-log.js';
import { trackFormatOperationNotices } from '../src/data-format/notice-delivery.js';
import { dataFormatMigrations } from '../src/data-format/migration-operations.js';
import { receiptFormatNotices } from '../src/data-format/format-notices.js';
import { entryAgentReceipt } from '../src/graphiti/turn-receipt-delivery.js';

const NOW = Date.parse('2026-10-28T11:40:00.000Z');
const event = (migrationId = 'graph/12-builtin-occupations', at = '2026-10-28T11:37:00.000Z') => ({
  kind: 'applied', store: 'graph', label: 'graph (personal)', migrationId, at
});

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'fuli-notice-count-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('a completed migration appears in seven distinct task receipts, counting down and surviving restarts', async (t) => {
  const root = fixture(t);
  recordFormatOperations(root, [event()]);
  const create = () => dataFormatReceiptNotice(root, { notices: () => [], now: () => NOW });
  let notice = create();

  for (let number = 1; number <= 7; number += 1) {
    const expected = `数据格式已迁移：graph/12-builtin-occupations（本次后还提示 ${7 - number} 次）`;
    const shown = await notice({ taskId: `task-${number}` });
    assert.equal(shown, expected);
    assert.equal(await notice({ taskId: `task-${number}` }), expected, 'a checkpoint/retry must reuse its task claim');
    notice = create();
  }
  assert.equal(await notice({ taskId: 'task-8' }), null);
  assert.match(await notice({ taskId: 'task-7' }), /本次后还提示 0 次/, 'the seventh task can still finish');
});

test('pending migrations stay visible after the completed-notice budget is exhausted', async (t) => {
  const root = fixture(t);
  recordFormatOperations(root, [event()]);
  const notice = dataFormatReceiptNotice(root, { now: () => NOW, notices: () => [{
    store: 'graph', state: 'pending_confirmation', steps: ['graph/15-next']
  }] });
  for (let number = 1; number <= 7; number += 1) await notice({ taskId: `task-${number}` });
  assert.equal(await notice({ taskId: 'task-8' }), '数据格式待确认：graph/15-next（fuli migrate preview）');
});

test('a newly recorded migration keeps its seven reminders even when no task starts for more than a day', async (t) => {
  const root = fixture(t);
  recordFormatOperations(root, [event('graph/13-example', '2026-10-20T10:00:00.000Z')]);
  const notice = dataFormatReceiptNotice(root, { notices: () => [], now: () => NOW });
  assert.match(await notice({ taskId: 'first-task' }), /graph\/13-example.*本次后还提示 6 次/);
});

test('a newer notice store cannot block an unrelated pending migration or be overwritten', async (t) => {
  const root = fixture(t);
  recordFormatOperations(root, [event()]);
  const path = join(root, 'format-notice-delivery.json');
  const future = JSON.stringify({ version: 99, entries: {} });
  writeFileSync(path, future);
  const notice = dataFormatReceiptNotice(root, { now: () => NOW, notices: () => [{
    store: 'graph', state: 'pending_confirmation', steps: ['graph/15-next']
  }] });
  assert.equal(await notice({ taskId: 'task-1' }), '数据格式待确认：graph/15-next（fuli migrate preview）');
  assert.equal(readFileSync(path, 'utf8'), future);
});

test('the person can dismiss only the current notices; a later migration still gets seven reminders', async (t) => {
  const root = fixture(t);
  const now = () => new Date(NOW);
  recordFormatOperations(root, [event()]);
  const port = dataFormatMigrations(root, { now, graph: { preview: async () => ({ plan: null, undoable: [] }) } });
  const before = (await port.preview()).notice.active;
  assert.equal(before.length, 1);
  assert.equal(before[0].remaining, 7);
  assert.equal((await port.preview()).notice.active[0].remaining, 7, 'reading the page is not a delivery');
  recordFormatOperations(root, [event('graph/13-example', '2026-10-28T11:39:00.000Z')]);
  const dismissed = await port.dismissNotices(before.map((item) => item.id));
  assert.deepEqual(dismissed.notice.active.map((item) => item.migrationId), ['graph/13-example']);
  const notice = dataFormatReceiptNotice(root, { notices: () => [], now: () => NOW });
  const shown = await notice({ taskId: 'task-1' });
  assert.doesNotMatch(shown, /graph\/12-builtin-occupations/);
  assert.match(shown, /graph\/13-example.*本次后还提示 6 次/);
});

test('entry and checkpoint reuse one claim and link to the local dismissal control', async (t) => {
  const root = fixture(t);
  recordFormatOperations(root, [event()]);
  const application = { runtimeConfigPath: join(root, 'graph-runtime.json'), consoleUrl: 'http://127.0.0.1:2727',
    personal: { health: async () => ({ data_format: { state: 'current' } }) } };
  const task = { token: 'fuli-task-1', unreadTurnReceipts: [] };
  const entry = await entryAgentReceipt(application, task, { markdown: 'FULI Agent：示例' });
  assert.match(entry.markdown, /本次后还提示 6 次/);
  // A client that drops the link still shows where to close the reminder.
  assert.match(entry.markdown, /关闭提醒：\[设置 → 数据格式迁移\]\(<http:\/\/127\.0\.0\.1:2727\/settings\/data-format>\)/);
  const checkpoint = await receiptFormatNotices(application, { taskId: task.token });
  assert.match(checkpoint[0], /本次后还提示 6 次/);
  assert.match((await receiptFormatNotices(application, { taskId: 'fuli-task-2' }))[0], /本次后还提示 5 次/);
  const port = dataFormatMigrations(root, { graph: { preview: async () => ({ plan: null, undoable: [] }) } });
  const active = (await port.preview()).notice.active;
  await port.dismissNotices(active.map((item) => item.id));
  assert.deepEqual(await receiptFormatNotices(application, { taskId: task.token }), [],
    'closing a reminder also removes it from a later checkpoint of the same task');
});

test('different MCP processes cannot collectively claim more than seven reminders', async (t) => {
  const root = fixture(t);
  recordFormatOperations(root, [event()]);
  const moduleUrl = pathToFileURL(join(process.cwd(), 'src/data-format/format-notices.js')).href;
  const script = `import { dataFormatReceiptNotice } from ${JSON.stringify(moduleUrl)};
    const notice = dataFormatReceiptNotice(process.argv[1], { notices: () => [], now: () => ${NOW} });
    process.stdout.write(JSON.stringify(await notice({ taskId: process.argv[2] })));`;
  const call = (task) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, root, task]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (part) => { stdout += part; });
    child.stderr.on('data', (part) => { stderr += part; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr)));
  });
  const responses = await Promise.all(Array.from({ length: 12 }, (_, index) => call(`task-${index}`)));
  const remaining = responses.filter(Boolean).map((line) => Number(line.match(/还提示 (\d+) 次/)[1])).sort();
  assert.deepEqual(remaining, [0, 1, 2, 3, 4, 5, 6]);
});

test('undoing a migration removes its old completion reminder; a later apply starts a new count', async (t) => {
  const root = fixture(t);
  recordFormatOperations(root, [event()]);
  const notice = dataFormatReceiptNotice(root, { notices: () => [], now: () => NOW });
  assert.match(await notice({ taskId: 'task-1' }), /还提示 6 次/);
  recordFormatOperations(root, [{ ...event(), kind: 'rolled_back', at: '2026-10-28T11:38:00.000Z' }]);
  assert.equal(await notice({ taskId: 'task-2' }), null);
  recordFormatOperations(root, [event('graph/12-builtin-occupations', '2026-10-28T11:39:00.000Z')]);
  assert.match(await notice({ taskId: 'task-3' }), /还提示 6 次/);
});

test('an old unshown migration is not revived, while a recent legacy reminder keeps its count after a day', async (t) => {
  const root = fixture(t);
  writeFileSync(join(root, 'format-operations.json'), JSON.stringify({ version: 1, events: [
    event('graph/old', '2026-10-20T10:00:00.000Z'), event()
  ] }));
  const first = dataFormatReceiptNotice(root, { notices: () => [], now: () => NOW });
  const shown = await first({ taskId: 'task-1' });
  assert.doesNotMatch(shown, /graph\/old/);
  assert.match(shown, /graph\/12-builtin-occupations.*还提示 6 次/);
  const later = dataFormatReceiptNotice(root, { notices: () => [], now: () => NOW + 48 * 60 * 60 * 1000 });
  assert.match(await later({ taskId: 'task-2' }), /graph\/12-builtin-occupations.*还提示 5 次/);
});

test('operation-log retention does not lose an undelivered notice or revive an undone one', async (t) => {
  const root = fixture(t);
  recordFormatOperations(root, [event()]);
  const pruneEvents = Array.from({ length: 205 }, (_, index) => ({ kind: 'pruned', store: 'graph',
    at: `2026-10-28T11:40:${String(index % 60).padStart(2, '0')}.000Z` }));
  recordFormatOperations(root, pruneEvents);
  const notice = dataFormatReceiptNotice(root, { notices: () => [], now: () => NOW });
  assert.match(await notice({ taskId: 'task-1' }), /graph\/12-builtin-occupations.*还提示 6 次/);

  recordFormatOperations(root, [{ ...event(), kind: 'rolled_back', at: '2026-10-28T11:41:00.000Z' }]);
  recordFormatOperations(root, pruneEvents);
  assert.equal(await notice({ taskId: 'task-2' }), null);
});

test('an apply queued after a concurrent undo never resurfaces after log retention', async (t) => {
  const root = fixture(t);
  const applied = { ...event(), noticeEligible: true };
  const undone = { ...event(), kind: 'rolled_back', at: '2026-10-28T11:38:00.000Z' };
  writeFileSync(join(root, 'format-operations.json'), JSON.stringify({ version: 1, events: [applied, undone] }));
  trackFormatOperationNotices(root, [applied], () => readFormatOperations(root));
  recordFormatOperations(root, Array.from({ length: 205 }, () => ({ kind: 'pruned', store: 'graph' })));
  const notice = dataFormatReceiptNotice(root, { notices: () => [], now: () => NOW });
  assert.equal(await notice({ taskId: 'task-1' }), null);
});
