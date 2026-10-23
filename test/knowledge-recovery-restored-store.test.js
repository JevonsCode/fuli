import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { JudgmentStore } from '../src/judgment/store.js';
import { knowledgeHardDelete } from '../src/knowledge-hard-delete/console-port.js';
import { hardDeleteLedger } from '../src/knowledge-hard-delete/delete-ledger.js';
import { syntheticGraph, PREVIEW_ID } from '../test-support/hard-delete-graph.js';

test('reconciliation erases a restored old body store even when its deletion ledger is already complete', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-restored-knowledge-'));
  const path = join(directory, 'judgment.sqlite');
  const backup = join(directory, 'fixture-before-delete.sqlite');
  const secret = 'SYNTHETIC-RESTORED-COMPLETE-LEDGER-BODY';
  try {
    const store = new JudgmentStore(path, { recoveryGate: { state: () => ({ state: 'open' }) } });
    try {
      store.record('personal-space', { kind: 'review', target: 'entity:item-2', title: secret, evidence: [] }, 'fixture');
    } finally { store.close(); }
    copyFileSync(path, backup);
    const graph = syntheticGraph();
    const port = knowledgeHardDelete(directory, { send: graph.send, personalSpaceId: () => 'personal-space' });
    const result = await port.confirm({ personalSpaceId: 'personal-space', itemKind: 'entity', itemId: 'item-2',
      previewId: PREVIEW_ID, confirmation: '删除' });
    assert.equal(result.outcome, 'complete');
    assert.equal(hardDeleteLedger(directory).all()[0].state, 'complete');
    assert.equal(readFileSync(path).includes(Buffer.from(secret)), false);

    // The graph and current ledger remain intact; only an older database is
    // restored. A known completed deletion still has to erase this new copy.
    copyFileSync(backup, path);
    assert.equal(readFileSync(path).includes(Buffer.from(secret)), true);
    await port.reconcile();
    assert.equal(readFileSync(path).includes(Buffer.from(secret)), false);
    assert.equal(hardDeleteLedger(directory).all().length, 1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
