import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { hardDeleteLedger, HARD_DELETE_LEDGER_FILE } from '../src/knowledge-hard-delete/delete-ledger.js';
import { createKnowledgeRecoveryGate } from '../src/knowledge-hard-delete/recovery-gate.js';
import { HARD_DELETE_LEDGER_FINGERPRINT } from '../src/knowledge-hard-delete/ledger-format.js';

const SPACE = 'synthetic-space';
const AT = '2026-10-23T00:00:00Z';
function fixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'fuli-recovery-gate-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  let graph = { count: 0, latest_deleted_at: null }; let now = 0;
  const gate = createKnowledgeRecoveryGate({ dataDir, now: () => now,
    readWatermark: async () => { if (graph instanceof Error) throw graph; return graph; } });
  return { dataDir, gate, ledger: hardDeleteLedger(dataDir), file: join(dataDir, HARD_DELETE_LEDGER_FILE),
    graph: value => { graph = value; }, tick: () => { now += 60_001; } };
}
const state = f => f.gate.state(SPACE, 'judgment').state;

test('gate is read-only and missing ledger opens only after proof that graph has zero deletes', async t => {
  const f = fixture(t);
  assert.deepEqual(Object.keys(f.gate).sort(), ['refresh', 'state']);
  assert.equal(state(f), 'closed');
  await f.gate.refresh(SPACE);
  assert.equal(state(f), 'open');
  assert.throws(() => readFileSync(f.file), { code: 'ENOENT' });
  f.graph({ count: 1, latest_deleted_at: AT }); f.tick();
  assert.equal(state(f), 'closed');
  await f.gate.refresh(SPACE);
  assert.equal(state(f), 'closed');
});

test('v1 read does not migrate or invent a watermark; console proof upgrades without losing operations', async t => {
  const f = fixture(t);
  const old = JSON.stringify({ version: 1, operations: [] });
  writeFileSync(f.file, old);
  await f.gate.refresh(SPACE); assert.equal(state(f), 'closed');
  assert.equal(readFileSync(f.file, 'utf8'), old);
  f.ledger.recordWatermark(SPACE, { count: 0, latestDeletedAt: null });
  await f.gate.refresh(SPACE); assert.equal(state(f), 'open');
  const next = JSON.parse(readFileSync(f.file));
  assert.equal(next.version, 2); assert.deepEqual(next.operations, []);
  assert.equal(next.watermarks[SPACE].count, 0);
  const registered = JSON.parse(readFileSync(new URL('./fixtures/knowledge-hard-delete-format-fingerprint.json', import.meta.url)));
  assert.deepEqual({ version: next.version, fingerprint: next.schemaFingerprint }, registered);
  assert.equal(next.schemaFingerprint, HARD_DELETE_LEDGER_FINGERPRINT);
});

test('the v1 to v2 migration preserves old operations and accepts source targets only in the new format', async t => {
  const f = fixture(t);
  const legacy = { id: 'old-operation', spaceId: SPACE, itemKind: 'entity', itemId: 'old-item',
    previewId: null, itemIds: ['old-item'], state: 'complete', deletionId: 'old-delete', deletedAt: AT, createdAt: AT, updatedAt: AT };
  for (const itemKind of ['episode', 'session']) {
    writeFileSync(f.file, JSON.stringify({ version: 1, operations: [{ ...legacy, itemKind }] }));
    assert.throws(() => f.ledger.all(), { code: 'data_format_damaged' });
  }
  writeFileSync(f.file, JSON.stringify({ version: 1, operations: [legacy] }));
  f.ledger.recordWatermark(SPACE, { count: 1, latestDeletedAt: AT });
  assert.deepEqual(f.ledger.all(), [legacy]);
  for (const itemKind of ['episode', 'session']) {
    f.ledger.begin({ spaceId: SPACE, itemKind, itemId: `synthetic-${itemKind}`, previewId: 'preview', itemIds: [] });
  }
  assert.deepEqual(f.ledger.all().map(operation => operation.itemKind), ['entity', 'episode', 'session']);
  const next = JSON.parse(readFileSync(f.file)); next.schemaFingerprint = '0'.repeat(64);
  writeFileSync(f.file, JSON.stringify(next));
  await f.gate.refresh(SPACE); assert.equal(state(f), 'closed');
  assert.throws(() => f.ledger.recordWatermark(SPACE, { count: 1, latestDeletedAt: AT }), { code: 'data_format_damaged' });
});

test('a successful proof is cached for at most sixty seconds and a changed ledger invalidates it immediately', async t => {
  const f = fixture(t); let reads = 0, now = 0;
  const gate = createKnowledgeRecoveryGate({ dataDir: f.dataDir, now: () => now,
    readWatermark: async () => { reads++; return { count: 0, latest_deleted_at: null }; } });
  await gate.refresh(SPACE); await gate.refresh(SPACE);
  assert.equal(reads, 1);
  now = 60_000; assert.equal(gate.state(SPACE, 'judgment').state, 'closed');
  await gate.refresh(SPACE); assert.equal(reads, 2);
  f.ledger.recordWatermark(SPACE, { count: 0, latestDeletedAt: null });
  assert.equal(gate.state(SPACE, 'judgment').state, 'closed');
  await gate.refresh(SPACE); assert.equal(reads, 3);
  await gate.refresh(SPACE, { force: true }); assert.equal(reads, 4);
});

test('old restored proof, provider failures, malformed aggregates and damage never open the gate', async t => {
  const f = fixture(t);
  f.ledger.recordWatermark(SPACE, { count: 0, latestDeletedAt: null });
  const old = readFileSync(f.file);
  f.graph({ count: 1, latest_deleted_at: AT });
  await f.gate.refresh(SPACE); assert.equal(state(f), 'closed');
  f.ledger.recordWatermark(SPACE, { count: 1, latestDeletedAt: AT });
  await f.gate.refresh(SPACE); assert.equal(state(f), 'open');
  writeFileSync(f.file, old);
  assert.equal(state(f), 'closed'); await f.gate.refresh(SPACE); assert.equal(state(f), 'closed');
  for (const response of [new Error('offline'), new Error('offline again'), { count: 0, latest_deleted_at: null, ids: ['not-allowed'] }]) {
    f.graph(response); f.tick(); await f.gate.refresh(SPACE); assert.equal(state(f), 'closed');
  }
  f.graph({ count: 0, latest_deleted_at: null });
  writeFileSync(f.file, '{broken'); await f.gate.refresh(SPACE); assert.equal(state(f), 'closed');
  writeFileSync(f.file, JSON.stringify({ version: 999, operations: [] }));
  await f.gate.refresh(SPACE); assert.equal(state(f), 'closed');
});

test('unknown only fences items; unfinished cleanup closes both body stores and only its own space', async t => {
  const f = fixture(t);
  f.ledger.recordWatermark(SPACE, { count: 0, latestDeletedAt: null });
  const operation = f.ledger.begin({ spaceId: SPACE, itemKind: 'entity', itemId: 'synthetic', previewId: 'preview', itemIds: ['synthetic'] });
  await f.gate.refresh(SPACE); assert.equal(state(f), 'open');
  f.ledger.update(operation.id, { state: 'graph_deleted' });
  await f.gate.refresh(SPACE);
  for (const store of ['judgment', 'role-work']) assert.equal(f.gate.state(SPACE, store).state, 'closed');
  f.ledger.recordWatermark('other-space', { count: 0, latestDeletedAt: null });
  await f.gate.refresh('other-space'); assert.equal(f.gate.state('other-space', 'judgment').state, 'open');
  f.ledger.update(operation.id, { state: 'complete' });
  await f.gate.refresh(SPACE); assert.equal(state(f), 'open');
});

test('ledger replaced during a graph request cannot borrow an earlier proof', async t => {
  const f = fixture(t); let release;
  f.ledger.recordWatermark(SPACE, { count: 0, latestDeletedAt: null });
  const gate = createKnowledgeRecoveryGate({ dataDir: f.dataDir,
    readWatermark: () => new Promise(resolve => { release = resolve; }) });
  const pending = gate.refresh(SPACE);
  writeFileSync(f.file, JSON.stringify({ version: 1, operations: [] }));
  release({ count: 0, latest_deleted_at: null });
  assert.equal((await pending).state, 'closed');
  assert.equal(gate.state(SPACE, 'judgment').state, 'closed');
});
