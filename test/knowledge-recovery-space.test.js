import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { JudgmentStore } from '../src/judgment/store.js';
import { RoleWorkStore } from '../src/model-backends/role-work-store.js';
import { deletedKnowledgeBeside, hardDeleteLedger } from '../src/knowledge-hard-delete/delete-ledger.js';

test('a pending delete fences only its space when two spaces share an opaque item ID', t => {
  const root = mkdtempSync(join(tmpdir(), 'fuli-recovery-space-'));
  const recoveryGate = { state: () => ({ state: 'open' }) };
  const judgment = new JudgmentStore(join(root, 'judgment.sqlite'), { recoveryGate });
  const role = new RoleWorkStore(join(root, 'role-work.sqlite'), { recoveryGate });
  t.after(() => { judgment.close(); role.close(); rmSync(root, { recursive: true, force: true }); });
  const at = new Date();
  const body = { itemId: 'same-opaque-id', content: 'Synthetic body retained in space B.' };
  const requests = {};
  const packages = {};
  const decisions = {};
  for (const space of ['space-a', 'space-b']) {
    decisions[space] = judgment.record(space, { ...body, target: 'entity:same-opaque-id' }, `request-${space}`);
    requests[space] = { ...body, role: 'bole', operation: 'synthetic', requestId: `role-${space}`,
      scope: { personalSpaceId: space, personalProjectId: null, sessionRef: null }, versions: { evidence: 'e', policy: 'p' } };
    packages[space] = role.create({ request: requests[space], resume: body, fallbackReceipt: body,
      reason: 'synthetic', at, ttlMs: 60000 });
  }
  const ledger = hardDeleteLedger(root);
  const operation = ledger.begin({ spaceId: 'space-a', itemKind: 'entity', itemId: 'same-opaque-id',
    itemIds: ['same-opaque-id'], previewId: 'synthetic-preview' });
  assert.equal(judgment.get('space-a', decisions['space-a'].id).content, null);
  assert.equal(judgment.get('space-b', decisions['space-b'].id).content, body.content);
  assert.equal(judgment.forgets('entity:same-opaque-id', 'space-a'), true);
  assert.equal(judgment.forgets('entity:same-opaque-id', 'space-b'), false);
  for (const read of [() => role.get(packages['space-b'].packageId), () => role.open(requests['space-b'], at),
    () => role.nextClaimable({ personalSpaceId: 'space-b', personalProjectId: null, sessionRef: null }, at)]) {
    assert.equal(read().request.content, body.content);
  }
  assert.equal(role.get(packages['space-a'].packageId).request.content, null);
  const saved = judgment.record('space-b', body, 'late-write-b');
  assert.equal(saved.content, body.content);
  judgment.execute('space-b', saved.id, 'applied', body);
  assert.equal(judgment.get('space-b', saved.id).execution.receipt.content, body.content);
  role.transition(packages['space-b'].packageId, ['pending'], { status: 'submitted', submission: body, result: body },
    { name: 'synthetic', detail: body }, at);
  role.startExecution(packages['space-b'].packageId, { at, until: new Date(+at + 30000) });
  const active = role.applyingWork(requests['space-b'], at);
  assert.equal(active.submission.content, body.content);
  assert.equal(active.result.content, body.content);
  const event = role.db.prepare("SELECT detail FROM role_work_events WHERE package_id = ? AND event = 'synthetic'")
    .get(packages['space-b'].packageId);
  assert.equal(JSON.parse(event.detail).content, body.content);

  const fence = deletedKnowledgeBeside(join(root, 'judgment.sqlite'));
  assert.equal(fence().names('same-opaque-id'), true); // Existing aggregate callers remain compatible.
  assert.equal(fence('space-b').names('same-opaque-id'), false);
  ledger.update(operation.id, { state: 'not_deleted' });
  assert.equal(fence('space-a').names('same-opaque-id'), false);
  assert.equal(fence().names('same-opaque-id'), false);
});
