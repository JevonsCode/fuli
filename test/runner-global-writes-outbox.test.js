import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readGlobalCopyRecord, recordGlobalCopy, requestSyncSoon } from '../src/runner/global-copy-state.js';
import { createGlobalWritesOutbox } from '../src/runner/global-writes-outbox.js';
import { deliverOutbox } from '../src/runner/outbox-delivery.js';
import { RunnerStore } from '../src/runner/runner-store.js';

// A follower's writes to global on their way to the host (docs/runner-roles-design.md §12):
// one checkpoint, one entry; each op kept as the host answered it. Synthetic data only.
const HOST = { name: 'Host A', fingerprint: 'a'.repeat(64), certPem: 'synthetic', port: 2730, addresses: ['192.0.2.20'] };
const capture = { kind: 'capture', v: 1, input: { summary: 'a habit learned without a project' } };
const memory = { kind: 'agent_memory', v: 1, input: { agentId: 'agent-1', expectedRevision: 2, memory: { summary: 'x' } } };
const usage = { kind: 'knowledge_usage', v: 1,
  input: { taskId: 'task-1', sessionId: 'session-1', sourceApplication: 'codex', items: [{ itemKind: 'entity', itemId: 'e-1', useKind: 'applied' }] } };

function pairedStore() {
  const store = new RunnerStore(':memory:');
  store.saveHost(HOST);
  return store;
}

// A host that answers each replay with reply(body); away when reply returns null. Each fakeHost is
// one connection, so one hello: another fakeHost is the host answering a new hello.
function fakeHost({ globalWrites = 1, version = '0.29.0', reply }) {
  const posted = [];
  const host = { globalWrites, version };
  return { posted, host, connection: { get current() { return host; }, connect: async () => host,
    postJson: async (_path, body) => {
      posted.push(body);
      return reply(body) ?? { reachable: false };
    } } };
}

const answered = (...outcomes) => () => ({ reachable: true, status: 200, body: { result: { ops: outcomes } } });
const applied = (kind) => ({ kind, outcome: 'applied', code: null });
const refused = (kind, code) => ({ kind, outcome: 'refused', code });

function port(store, connection, { online = true, onWritesApplied } = {}) {
  return createGlobalWritesOutbox({ store, sourceApplication: 'codex', sessionId: 'session-1',
    waitForDelivery: async () => { if (online) await deliverOutbox({ store, connection, onWritesApplied }); } });
}

test('online, one checkpoint\'s writes are one entry, delivered op by op; the same key never queues twice', async () => {
  const store = pairedStore();
  const { connection, posted } = fakeHost({ reply: answered(applied('capture'), refused('agent_memory', 'capture_disabled'),
    applied('knowledge_usage')) });
  const writes = port(store, connection);
  const first = await writes.send({ key: 'task-1:global', ops: [capture, memory, usage] });
  assert.deepEqual(first, { delivered: 2, queued: 0, refused: [{ kind: 'agent_memory', code: 'capture_disabled' }] },
    'an FLA\'s memory the host did not keep is said as refused, the others as applied');
  assert.equal(posted.length, 1);
  assert.equal(posted[0].tool, 'global_writes');
  assert.equal(posted[0].input.ops[2].input.sourceApplication, 'codex', 'a use keeps the client it was made in');
  assert.deepEqual(await writes.send({ key: 'task-1:global', ops: [capture, memory, usage] }), first);
  assert.equal(posted.length, 1, 'a retried checkpoint reads what became of its entry');
  // One refused op is listed as refused; the entry itself is not failed.
  const failed = store.outbox().failed;
  assert.equal(failed.length, 1);
  assert.match(failed[0].id, /:refused$/);
  assert.match(failed[0].reason, /agent_memory capture_disabled/);
  store.close();
});

test('with the host away the writes are queued, and delivered once it answers', async () => {
  const store = pairedStore();
  let away = true;
  const { connection } = fakeHost({ reply: (body) => (away ? null : answered(...body.input.ops.map((op) => applied(op.kind)))()) });
  const writes = port(store, connection);
  assert.deepEqual(await writes.send({ key: 'task-2:global', ops: [capture] }), { delivered: 0, queued: 1, refused: [] });
  away = false;
  await deliverOutbox({ store, connection });
  assert.deepEqual(await writes.send({ key: 'task-2:global', ops: [capture] }), { delivered: 1, queued: 0, refused: [] });
  store.close();
});

test('an older host is never sent them: they are held, said as such, and sent once it runs another version', async () => {
  const store = pairedStore();
  const old = fakeHost({ globalWrites: 0, version: '0.28.0', reply: answered(applied('capture')) });
  const writes = port(store, old.connection);
  assert.deepEqual(await writes.send({ key: 'task-3:global', ops: [capture] }), { delivered: 0, queued: 1, refused: [] });
  assert.equal(old.posted.length, 0, 'not sent to be refused as an unknown entry');
  assert.match(store.outbox().failed[0].reason, /^host_too_old:0\.28\.0$/);
  // A checkpoint queued behind it is not held up.
  store.enqueue({ id: 'checkpoint-1', tool: 'checkpoint_task_knowledge', input: {}, sourceApplication: 'codex' });
  const plain = { ...old.connection, postJson: async () => ({ reachable: true, status: 200, body: { result: {} } }) };
  await deliverOutbox({ store, connection: plain });
  assert.equal(store.entryState('checkpoint-1'), null);

  const updated = fakeHost({ version: '0.29.0', reply: answered(applied('capture')) });
  await deliverOutbox({ store, connection: updated.connection });
  assert.equal(updated.posted.length, 1);
  assert.deepEqual(await writes.send({ key: 'task-3:global', ops: [capture] }), { delivered: 1, queued: 0, refused: [] });
  store.close();
});

test('an op the host cannot take yet waits for its next version; its other refusals and skips are its answer', async () => {
  const store = pairedStore();
  const recruit = { kind: 'recruit', v: 1, input: { recruitmentId: 'r-1' } };
  const first = fakeHost({ reply: answered(refused('recruit', 'host_too_old'), { ...applied('knowledge_usage'), skipped: [{ itemId: 'x' }] },
    refused('capture', 'no_global_items'), refused('capture', 'capture_disabled'), refused('capture', 'invalid_input')) });
  const writes = port(store, first.connection);
  const ops = [recruit, usage, capture, capture, capture];
  const said = await writes.send({ key: 'task-4:global', ops });
  assert.equal(said.delivered, 1);
  assert.equal(said.queued, 1, 'host_too_old is not a refusal for good');
  assert.deepEqual(said.refused.map(({ code }) => code), ['no_global_items', 'capture_disabled', 'invalid_input']);
  await deliverOutbox({ store, connection: first.connection });
  assert.equal(first.posted.length, 1, 'nothing is sent again to the same version');
  const next = fakeHost({ version: '0.29.1', reply: answered(applied('recruit')) });
  await deliverOutbox({ store, connection: next.connection });
  assert.deepEqual(next.posted.map((body) => body.input.ops.map((op) => op.kind)), [['recruit']], 'only the op held');
  assert.notEqual(next.posted[0].id, first.posted[0].id, 'under an id the host never applied');
  assert.deepEqual(await writes.send({ key: 'task-4:global', ops }),
    { delivered: 2, queued: 0, refused: said.refused });
  store.close();
});

test('an op larger than the host takes is refused here, listed, and never sent', async () => {
  const store = pairedStore();
  const { connection, posted } = fakeHost({ reply: answered(applied('capture')) });
  const large = { kind: 'capture', v: 1, input: { summary: 'x'.repeat(1024 * 1024) } };
  const said = await port(store, connection).send({ key: 'task-5:global', ops: [large] });
  assert.deepEqual(said, { delivered: 0, queued: 0, refused: [{ kind: 'capture', code: 'entry_too_large' }] });
  assert.equal(posted.length, 0);
  assert.equal(store.outbox().failed[0].reason, 'entry_too_large', 'kept, not dropped');
  store.close();
});

test('writes too large together go one op an entry, each under an id its key and place decide', async () => {
  const store = pairedStore();
  const { connection, posted } = fakeHost({ reply: (body) => answered(...body.input.ops.map((op) => applied(op.kind)))() });
  const half = { kind: 'capture', v: 1, input: { summary: 'x'.repeat(600 * 1024) } };
  const longMemory = { ...memory, input: { ...memory.input, memory: { summary: 'y'.repeat(600 * 1024) } } };
  const writes = port(store, connection);
  const ops = [half, longMemory, usage];
  assert.deepEqual(await writes.send({ key: 'task-10:global', ops }), { delivered: 3, queued: 0, refused: [] });
  assert.deepEqual(posted.map((body) => body.input.ops.map((op) => op.kind)), [['capture'], ['agent_memory'], ['knowledge_usage']]);
  assert.equal(new Set(posted.map((body) => body.id)).size, 3);
  // Retried under the same key: the same entries, nothing sent again.
  assert.deepEqual(await writes.send({ key: 'task-10:global', ops }), { delivered: 3, queued: 0, refused: [] });
  assert.equal(posted.length, 3);
  // Too large on its own as well: that op alone is kept as refused, the others go.
  const huge = { kind: 'capture', v: 1, input: { summary: 'x'.repeat(1024 * 1024) } };
  assert.deepEqual(await writes.send({ key: 'task-11:global', ops: [huge, memory] }),
    { delivered: 1, queued: 0, refused: [{ kind: 'capture', code: 'entry_too_large' }] });
  store.close();
});

test('the same writes queued by two processes at once are one entry, and neither fails', async () => {
  const store = pairedStore();
  const entry = { id: 'global:same', tool: 'global_writes', input: { ops: [capture] }, sourceApplication: 'codex' };
  assert.equal(store.enqueue(entry), true);
  assert.equal(store.enqueue(entry), false, 'the second is left as it is, not an error');
  assert.equal(store.outbox().queued, 1);
  store.close();
});

test('a 413 is kept as refused; a host that keeps failing has the entry held, and sent again at its next hello', async () => {
  const store = pairedStore();
  const big = fakeHost({ reply: () => ({ reachable: true, status: 413, body: { error: 'payload_too_large' } }) });
  assert.deepEqual(await port(store, big.connection).send({ key: 'task-6:global', ops: [capture] }),
    { delivered: 0, queued: 0, refused: [{ kind: 'capture', code: 'payload_too_large' }] });

  const failing = fakeHost({ reply: () => ({ reachable: true, status: 500, body: { error: 'provider_http_5xx' } }) });
  const writes = port(store, failing.connection, { online: false });
  await writes.send({ key: 'task-7:global', ops: [capture] });
  for (let round = 0; round < 9; round += 1) await deliverOutbox({ store, connection: failing.connection });
  assert.equal(store.outbox().queued, 1, 'nine failures: still queued');
  await deliverOutbox({ store, connection: failing.connection });
  assert.equal(store.outbox().queued, 0, 'held, so the outbox is not tried every round');
  assert.match(store.outbox().failed.at(0).reason, /^host_keeps_failing:0\.29\.0$/);
  assert.deepEqual(await writes.send({ key: 'task-7:global', ops: [capture] }), { delivered: 0, queued: 1, refused: [] },
    'held, never refused for good');
  await deliverOutbox({ store, connection: failing.connection });
  assert.equal(failing.posted.length, 10, 'the same hello: not sent again');

  // A new hello: queued again and sent.
  const back = fakeHost({ reply: answered(applied('capture')) });
  await deliverOutbox({ store, connection: back.connection });
  assert.equal(back.posted.length, 1);
  assert.deepEqual(await writes.send({ key: 'task-7:global', ops: [capture] }), { delivered: 1, queued: 0, refused: [] });
  store.close();
});

test('once the host applied them, the next sync of the copy is asked for', async (t) => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'fuli-copy-soon-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const store = pairedStore();
  const { connection } = fakeHost({ reply: answered(applied('capture')) });
  recordGlobalCopy(dataDir, { digest: 'synthetic-digest', checkedAt: '2026-11-24T08:00:00.000Z', last: { outcome: 'synced' } });
  await port(store, connection, { onWritesApplied: () => requestSyncSoon(dataDir, { now: () => Date.parse('2026-11-24T09:00:00Z') }) })
    .send({ key: 'task-8:global', ops: [capture] });
  assert.equal(readGlobalCopyRecord(dataDir).dueSoon, '2026-11-24T09:00:00.000Z');
  assert.equal(readGlobalCopyRecord(dataDir).digest, 'synthetic-digest', 'the rest of the record kept');
  // Nothing applied (all refused): no sync asked for.
  const none = fakeHost({ reply: answered(refused('capture', 'capture_disabled')) });
  let asked = 0;
  await port(store, none.connection, { onWritesApplied: () => { asked += 1; } }).send({ key: 'task-9:global', ops: [capture] });
  assert.equal(asked, 0);
  store.close();
});

test('delivery rechecks a queued hire and proceeds to later entries once its local outcome is known', async t => {
  const store = pairedStore();
  t.after(() => store.close());
  const { connection, posted } = fakeHost({ reply: answered(applied('capture')) });
  for (const state of ['withdrawn', 'fulfilled']) {
    store.enqueue({ id: 'recruit:' + state, tool: 'global_writes', sourceApplication: 'codex',
      input: { ops: [{ kind: 'recruit', input: { recruitmentId: state } }] } });
  }
  store.enqueue({ id: 'global:next', tool: 'global_writes', sourceApplication: 'codex', input: { ops: [capture] } });
  const unavailable = await deliverOutbox({ store, connection, recruitmentState: async () => { throw Error('offline'); } });
  assert.equal(unavailable.queued, 3);
  assert.equal(posted.length, 0);
  const ready = await deliverOutbox({ store, connection, recruitmentState: async input => input.recruitmentId });
  assert.equal(ready.queued, 0);
  assert.equal(ready.withdrawnCount, 1);
  assert.equal(store.entry('recruit:fulfilled').state, 'delivered');
  assert.deepEqual(posted.map(body => body.id), ['global:next']);
});
