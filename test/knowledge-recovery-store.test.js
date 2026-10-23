import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JudgmentStore } from '../src/judgment/store.js';
import { RoleWorkStore } from '../src/model-backends/role-work-store.js';
import { knowledgeReferences } from '../src/knowledge-hard-delete/forget-references.js';
import { hardDeleteLedger } from '../src/knowledge-hard-delete/delete-ledger.js';

const SECRET = 'synthetic body that must not escape a closed gate';
const at = new Date('2026-10-23T00:00:00Z');
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'fuli-recovery-store-'));
  let open = true;
  const calls = [];
  const recoveryGate = { state(space, store) { calls.push({ space, store }); return { state: open ? 'open' : 'closed', reason: SECRET }; } };
  const judgment = new JudgmentStore(join(root, 'judgment.sqlite'), { recoveryGate });
  const role = new RoleWorkStore(join(root, 'role-work.sqlite'), { recoveryGate });
  t.after(() => { judgment.close(); role.close(); rmSync(root, { recursive: true, force: true }); });
  const decision = judgment.record('space', { kind: 'acceptance', agentId: 'agent', target: 'item', content: SECRET,
    outcome: 'completed', evidenceFingerprint: 'e', policyVersion: 'p' }, 'request:one');
  const token = judgment.claim('space', '');
  const request = { role: 'assistant', operation: 'decide', requestId: 'request', scope: {
    personalSpaceId: 'space', personalProjectId: null, sessionRef: 'session' }, versions: { evidence: 'e', policy: 'p' },
    itemId: 'item', content: SECRET };
  const pkg = role.create({ request, resume: { itemId: 'item', content: SECRET }, reason: 'synthetic',
    fallbackReceipt: { itemId: 'item', content: SECRET }, at, ttlMs: 60000 });
  return { root, judgment, role, decision, token, request, pkg, calls, closeGate: () => { open = false; }, openGate: () => { open = true; } };
}
function pending(work) {
  assert.throws(work, error => {
    assert.equal(error.code, 'knowledge_recovery_pending'); assert.equal(error.status, 503);
    assert.match(error.message, /等待/); assert.match(error.message, /console/i);
    assert.match(error.message, /fuli migrate reconcile-knowledge/);
    assert.ok(!JSON.stringify(error).includes(SECRET)); assert.ok(!error.message.includes(SECRET));
    return true;
  });
}
test('closed JudgmentStore rejects all body reads and business writes; metadata remains available', t => {
  const f = fixture(t); f.closeGate();
  const before = f.judgment.db.prepare('SELECT total_changes() AS count').get().count;
  const reads = [() => f.judgment.setting('space', 'anything'), () => f.judgment.policy('space'),
    () => f.judgment.get('space', f.decision.id), () => f.judgment.records('space'),
    () => f.judgment.acceptances('space', 'agent'), () => f.judgment.requestRecords('space', 'request')];
  const writes = [() => f.judgment.writeSetting('space', 'x', SECRET, 0), () => f.judgment.pin('space', 'agent', true, 0),
    () => f.judgment.setPolicy('space', '', { mode: 'manual' }, 0), () => f.judgment.record('space', { content: SECRET }, 'new'),
    () => f.judgment.feedback('space', f.decision.id, 'up', SECRET, 0),
    () => f.judgment.execute('space', f.decision.id, 'applied', { content: SECRET }),
    () => f.judgment.claim('space', 'new-project'), () => f.judgment.release('space', '', f.token)];
  for (const method of [...reads, ...writes]) pending(method);
  assert.ok(f.judgment.pins('space').agentIds.length);
  assert.equal(f.judgment.owns('space', '', f.token), true);
  assert.equal(f.judgment.hasAutomaticPolicy('space'), false);
  assert.equal(f.judgment.reviewed('space', '', 'item', 'e', 'p'), true);
  assert.equal(f.judgment.db.prepare('SELECT total_changes() AS count').get().count, before);
  assert.ok(f.calls.every(call => ['judgment', 'role-work'].includes(call.store)));
});
test('closed RoleWorkStore rejects body reads and every business transition, including leases and expiry', t => {
  const f = fixture(t);
  const session = { personalSpaceId: 'space', personalProjectId: null, sessionRef: 'session', sourceApplication: 'codex' };
  f.role.claim(f.pkg.packageId, session, { leaseToken: 'lease', leaseExpiresAt: new Date(+at + 30000), at });
  f.role.startExecution(f.pkg.packageId, { submission: { content: SECRET }, at, until: new Date(+at + 30000) });
  f.closeGate();
  const before = f.role.db.prepare('SELECT total_changes() AS count').get().count;
  for (const method of [() => f.role.get(f.pkg.packageId), () => f.role.open(f.request, at), () => f.role.applyingWork(f.request, at),
    () => f.role.applying('assistant', 'request'), () => f.role.nextClaimable(session, at),
    () => f.role.create({ request: f.request, reason: 'synthetic', at, ttlMs: 60000 }),
    () => f.role.claim(f.pkg.packageId, session, { leaseToken: 'next', leaseExpiresAt: new Date(+at + 30000), at }),
    () => f.role.transition(f.pkg.packageId, ['applying'], { status: 'completed' }, { name: 'completed' }, at),
    () => f.role.startExecution(f.pkg.packageId, { at, until: new Date(+at + 30000) }),
    () => f.role.transitionExecution(f.pkg.packageId, 'old-token', {}, { name: 'late' }, at),
    () => f.role.finish(f.pkg.packageId, 'old-token', { content: SECRET }, at),
    () => f.role.recordStale(f.pkg.packageId, SECRET, at)]) pending(method);
  assert.deepEqual(f.role.counts(), [{ role: 'assistant', status: 'applying', count: 1 }]);
  assert.equal(f.role.db.prepare('SELECT total_changes() AS count').get().count, before);
  f.openGate();
  f.role.transition(f.pkg.packageId, ['applying'], { status: 'pending' }, { name: 'retry' }, at);
  f.closeGate(); pending(() => f.role.expire(new Date(+at + 120000)));
  assert.deepEqual(f.role.counts(), [{ role: 'assistant', status: 'pending', count: 1 }]);
});
test('disk stores without a gate fail closed; memory stores are exempt', t => {
  const f = fixture(t);
  const disk = new JudgmentStore(join(f.root, 'ungated.sqlite'));
  const work = new RoleWorkStore(join(f.root, 'ungated-work.sqlite'));
  try {
    pending(() => disk.record('space', {}, 'request'));
    pending(() => work.create({ request: f.request, reason: 'synthetic', at, ttlMs: 60000 }));
  } finally { disk.close(); work.close(); }
  const memory = new JudgmentStore(); const memoryWork = new RoleWorkStore();
  t.after(() => { memory.close(); memoryWork.close(); });
  assert.ok(memory.record('space', {}, 'request').id);
  assert.ok(memoryWork.create({ request: f.request, reason: 'synthetic', at, ttlMs: 60000 }).packageId);
});

test('writes recheck the gate inside the final transaction after a successful read', t => {
  const f = fixture(t);
  f.judgment.recoveryGate = { state() { return { state: f.judgment.db.isTransaction ? 'closed' : 'open' }; } };
  f.role.recoveryGate = { state() { return { state: f.role.db.isTransaction ? 'closed' : 'open' }; } };
  assert.equal(f.judgment.pins('space').revision, 0);
  assert.equal(f.role.get(f.pkg.packageId).status, 'pending');
  pending(() => f.judgment.pin('space', 'agent', true, 0));
  pending(() => f.judgment.release('space', '', f.token));
  pending(() => f.role.transition(f.pkg.packageId, ['pending'], { status: 'completed' }, { name: 'completed' }, at));
  pending(() => f.role.recordStale(f.pkg.packageId, SECRET, at));
  assert.equal(f.judgment.pins('space').revision, 0);
  assert.equal(f.judgment.owns('space', '', f.token), true);
  assert.equal(f.role.get(f.pkg.packageId).status, 'pending');
});

test('a closed space blocks an all-space expiry atomically without blocking other-space body reads', t => {
  const f = fixture(t);
  const other = f.role.create({ request: { ...f.request, scope: { ...f.request.scope, personalSpaceId: 'other' } },
    reason: 'synthetic', at, ttlMs: 60000 });
  const recoveryGate = { state(space) { return { state: space === 'space' ? 'closed' : 'open' }; } };
  f.role.recoveryGate = recoveryGate;
  f.judgment.recoveryGate = recoveryGate;
  assert.equal(f.role.get(other.packageId).status, 'pending');
  assert.deepEqual(f.judgment.records('other'), []);
  pending(() => f.judgment.records('space'));
  pending(() => f.role.get(f.pkg.packageId));
  pending(() => f.role.expire(new Date(+at + 120000)));
  assert.deepEqual(f.role.counts(), [{ role: 'assistant', status: 'pending', count: 2 }]);
});
test('privileged forgetting remains available while closed and body access only resumes when opened', t => {
  const f = fixture(t); f.closeGate();
  const references = knowledgeReferences({ itemIds: ['item'] });
  assert.ok(f.judgment.forgetKnowledgeItems('space', references) > 0);
  assert.ok(f.role.forgetKnowledgeItems('space', references) > 0);
  pending(() => f.judgment.get('space', f.decision.id)); pending(() => f.role.get(f.pkg.packageId));
  f.openGate();
  assert.ok(!JSON.stringify(f.judgment.get('space', f.decision.id)).includes(SECRET));
  assert.ok(!JSON.stringify(f.role.get(f.pkg.packageId)).includes(SECRET));
});

test('an unknown pending delete fences body reads without mutating stores or hiding unrelated items', t => {
  const f = fixture(t);
  f.judgment.feedback('space', f.decision.id, 'up', SECRET, 0);
  f.judgment.execute('space', f.decision.id, 'applied', { itemId: 'item', content: SECRET });
  const unrelated = f.judgment.record('space', { target: 'other', content: 'still visible' }, 'other');
  const otherWork = f.role.create({ request: { ...f.request, itemId: 'other', content: 'still visible',
    versions: { evidence: 'other', policy: 'p' } }, reason: 'synthetic', at, ttlMs: 60000 });
  const beforeJudgment = f.judgment.db.prepare('SELECT total_changes() AS count').get().count;
  const beforeRole = f.role.db.prepare('SELECT total_changes() AS count').get().count;
  hardDeleteLedger(f.root).begin({ spaceId: 'space', itemKind: 'entity', itemId: 'item', itemIds: ['item'], previewId: 'preview' });
  for (const value of [f.judgment.get('space', f.decision.id), f.judgment.records('space'),
    f.judgment.acceptances('space', 'agent'), f.judgment.requestRecords('space', 'request'),
    f.role.get(f.pkg.packageId), f.role.open(f.request, at)]) assert.ok(!JSON.stringify(value).includes(SECRET));
  assert.equal(f.judgment.get('space', unrelated.id).content, 'still visible');
  assert.equal(f.role.get(otherWork.packageId).request.content, 'still visible');
  assert.equal(f.judgment.db.prepare('SELECT total_changes() AS count').get().count, beforeJudgment);
  assert.equal(f.role.db.prepare('SELECT total_changes() AS count').get().count, beforeRole);
});
