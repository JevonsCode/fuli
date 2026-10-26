import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createJudgmentBackend } from '../src/judgment/backend.js';
import { reviewInstructions } from '../src/judgment/review-prompt.js';
import { createRoleWorkBridge } from '../src/model-backends/role-work.js';
import { RoleWorkStore } from '../src/model-backends/role-work-store.js';
import { hardDeleteLedger } from '../src/knowledge-hard-delete/delete-ledger.js';
import { knowledgeReferences } from '../src/knowledge-hard-delete/forget-references.js';

const SECRET = 'SYNTHETIC_TONBORG_DELETED_WORDS_4711';
const KEEP = 'Synthetic unrelated evidence stays visible';

test('real Tonborg JSON evidence is fenced before claim and durably scrubbed without losing unrelated candidates', async t => {
  const root = mkdtempSync(join(tmpdir(), 'fuli-tonborg-evidence-'));
  const path = join(root, 'role-work.sqlite');
  const store = new RoleWorkStore(path, { recoveryGate: { state: () => ({ state: 'open' }) } });
  const bridge = createRoleWorkBridge({ store, port: { decide: async () => ({
    modelReceipt: { status: 'not_configured', reason: 'no_config' } }) }, resumers: {},
  verifySession: async () => ({ personalSpaceId: 'space', personalProjectId: null,
    sessionRef: 'synthetic-session', sourceApplication: 'other' }) });
  t.after(() => { bridge.close(); rmSync(root, { recursive: true, force: true }); });
  const judge = createJudgmentBackend({ bridge });
  const policy = { quality: 'balanced' };
  const call = { policy, operation: 'knowledge_review', requestId: 'synthetic-request',
    scope: { personalSpaceId: 'space' }, evidenceVersion: 'e1', policyVersion: 'p1',
    instructions: reviewInstructions(policy), resume: { personalSpaceId: 'space', requestId: 'synthetic-request' },
    schema: { type: 'object', additionalProperties: false,
      properties: { target: { type: 'string', enum: ['entity:item', 'entity:other'] } }, required: ['target'] },
    data: { candidates: [{ candidate_key: 'entity:item', title: SECRET, content: SECRET },
      { candidate_key: 'entity:other', title: KEEP, content: KEEP }] } };
  const pending = await judge(call);
  const packageId = pending.workPackage.packageId;
  assert.ok(store.db.prepare('SELECT request FROM role_work WHERE package_id = ?').get(packageId).request.includes(SECRET));
  hardDeleteLedger(root).begin({ spaceId: 'space', itemKind: 'entity', itemId: 'item', itemIds: ['item'], previewId: 'preview' });
  const read = store.get(packageId);
  assert.ok(!JSON.stringify(read).includes(SECRET));
  assert.ok(JSON.stringify(read).includes(KEEP));
  const claimed = await bridge.claim({ taskContextToken: 'synthetic-token' });
  assert.ok(!JSON.stringify(claimed).includes(SECRET));
  const candidates = JSON.parse(claimed.workPackage.evidence.find(item => item.id === 'candidates').text);
  assert.equal(candidates[0].hard_deleted, true);
  assert.equal(candidates[1].content, KEEP);
  assert.equal(claimed.workPackage.instructions, call.instructions);

  assert.ok(store.forgetKnowledgeItems('space', knowledgeReferences({ itemIds: ['item'], candidateKeys: ['entity:item'] })) > 0);
  assert.ok(!store.db.prepare('SELECT request FROM role_work WHERE package_id = ?').get(packageId).request.includes(SECRET));
  // Late new work passes through the same serialization and write fence.
  const late = await judge({ ...call, requestId: 'late-request', evidenceVersion: 'e2' });
  assert.ok(!store.db.prepare('SELECT request FROM role_work WHERE package_id = ?').get(late.workPackage.packageId).request.includes(SECRET));
  bridge.close();
  assert.ok(!readFileSync(path).includes(Buffer.from(SECRET)));
});

test('ordinary evidence strings are preserved; malformed Tonborg JSON cannot cross an active fence', t => {
  const root = mkdtempSync(join(tmpdir(), 'fuli-evidence-envelope-'));
  const store = new RoleWorkStore(join(root, 'role-work.sqlite'), { recoveryGate: { state: () => ({ state: 'open' }) } });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  hardDeleteLedger(root).begin({ spaceId: 'space', itemKind: 'entity', itemId: 'item', itemIds: ['item'], previewId: 'preview' });
  const text = JSON.stringify({ candidate_key: 'entity:item', title: 'Ordinary JSON-looking text' });
  const base = { operation: 'knowledge_review', scope: { personalSpaceId: 'space', personalProjectId: null, sessionRef: null },
    versions: { evidence: 'e1', policy: 'p1' }, instructions: text, output: { type: 'structured', schema: {} } };
  const ordinary = store.create({ request: { ...base, role: 'assistant', requestId: 'ordinary',
    evidence: [{ id: 'plain', personalProjectId: null, text }] }, reason: 'synthetic', at: new Date(), ttlMs: 60000 });
  assert.equal(ordinary.request.evidence[0].text, text);
  const malformed = store.create({ request: { ...base, role: 'tonborg', requestId: 'malformed',
    evidence: [{ id: 'candidates', personalProjectId: null, text: '{malformed JSON' }] },
  reason: 'synthetic', at: new Date(), ttlMs: 60000 });
  assert.equal(malformed.request.evidence[0].text, 'null');
  assert.equal(malformed.request.instructions, text);
});
