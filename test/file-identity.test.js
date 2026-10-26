import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CapturePolicyStore } from '../src/graphiti/capture-policy.js';
import { deletedKnowledgeBeside, hardDeleteLedger } from '../src/knowledge-hard-delete/delete-ledger.js';
import { createKnowledgeRecoveryGate } from '../src/knowledge-hard-delete/recovery-gate.js';
import { fileIdentity } from '../src/system/file-identity.js';

// rec#49: Windows file IDs exceed 2^53. These two are different files whose
// IDs are the same once rounded to a Number.
const FIRST_ID = 2n ** 60n + 1n;
const SECOND_ID = 2n ** 60n + 2n;
const SPACE = 'synthetic-space';

function dataDirectory(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'fuli-file-identity-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
}

// Everything but the file ID stays the same, so only an exact ID tells the files apart.
const statWith = (ino) => ({ dev: 7n, ino, size: 100n, mtimeNs: 5n, ctimeNs: 5n });

test('two file IDs equal as Numbers are different identities, and a Number stat is refused', () => {
  assert.equal(Number(FIRST_ID), Number(SECOND_ID));
  assert.notEqual(fileIdentity(statWith(FIRST_ID)), fileIdentity(statWith(SECOND_ID)));
  assert.equal(fileIdentity(statWith(FIRST_ID)), `7:${FIRST_ID}`);
  assert.throws(() => fileIdentity({ dev: 7, ino: Number(FIRST_ID) }), TypeError);
});

test('the deleted-knowledge fence reads a ledger again when only its exact file ID changed', (t) => {
  const dataDir = dataDirectory(t);
  const ledger = hardDeleteLedger(dataDir);
  ledger.recordWatermark(SPACE, { count: 0, latestDeletedAt: null });
  let ino = FIRST_ID;
  const fence = deletedKnowledgeBeside(join(dataDir, 'judgment.sqlite'), { statFile: () => statWith(ino) });
  assert.equal(fence().names('entity:synthetic'), false);
  ledger.begin({ spaceId: SPACE, itemKind: 'entity', itemId: 'synthetic', previewId: 'preview', itemIds: ['synthetic'] });
  assert.equal(fence().names('entity:synthetic'), false, 'an unchanged stamp serves the cached read');
  ino = SECOND_ID;
  assert.equal(fence().names('entity:synthetic'), true);
});

test('a Number stat of the ledger fails closed: the fence refuses instead of trusting a rounded stamp', (t) => {
  const dataDir = dataDirectory(t);
  hardDeleteLedger(dataDir).recordWatermark(SPACE, { count: 0, latestDeletedAt: null });
  const fence = deletedKnowledgeBeside(join(dataDir, 'judgment.sqlite'),
    { statFile: () => ({ dev: 7, ino: Number(FIRST_ID), size: 100, mtimeNs: 5n, ctimeNs: 5n }) });
  assert.throws(() => fence(), TypeError);
});

test('a recovery proof is not reused when the ledger differs only in its exact file ID', async (t) => {
  const dataDir = dataDirectory(t);
  hardDeleteLedger(dataDir).recordWatermark(SPACE, { count: 0, latestDeletedAt: null });
  let ino = FIRST_ID;
  let reads = 0;
  const gate = createKnowledgeRecoveryGate({ dataDir, now: () => 0, statFile: () => statWith(ino),
    readWatermark: async () => { reads += 1; return { count: 0, latest_deleted_at: null }; } });
  await gate.refresh(SPACE);
  assert.equal(gate.state(SPACE, 'judgment').state, 'open');
  ino = SECOND_ID;
  assert.equal(gate.state(SPACE, 'judgment').state, 'closed');
  await gate.refresh(SPACE);
  assert.equal(reads, 2);
});

test('a Number stat of the ledger closes the recovery gate', async (t) => {
  const dataDir = dataDirectory(t);
  hardDeleteLedger(dataDir).recordWatermark(SPACE, { count: 0, latestDeletedAt: null });
  const gate = createKnowledgeRecoveryGate({ dataDir, now: () => 0,
    statFile: () => ({ dev: 7, ino: Number(FIRST_ID), size: 100, mtimeNs: 5n, ctimeNs: 5n }),
    readWatermark: async () => ({ count: 0, latest_deleted_at: null }) });
  assert.equal((await gate.refresh(SPACE)).state, 'closed');
  assert.equal(gate.state(SPACE, 'judgment').state, 'closed');
});

// The capture policy already reads its file with { bigint: true }; its key is
// stored in capture-settings-generation.json, so it keeps its own format.
test('the capture policy is parsed again when only its exact file ID changed', () => {
  const policy = (enabled) => JSON.stringify({ version: 1, enabled, disabledSources: [], projectMode: 'all',
    excludedProjectIds: [], selectedProjectIds: [], unregisteredDirectories: 'capture', projectsOffSince: {},
    unlistedProjectsOffSince: null, updatedAt: '2026-10-25T00:00:00.000Z' });
  let ino = FIRST_ID;
  let text = policy(false);
  const store = new CapturePolicyStore('synthetic-capture-policy.json',
    { statFile: () => statWith(ino), readText: () => text });
  assert.equal(store.read().enabled, false);
  text = policy(true);
  assert.equal(store.read().enabled, false, 'an unchanged key serves the cached parse');
  ino = SECOND_ID;
  assert.equal(store.read().enabled, true);
});
