import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { agentInterfaceCatalog } from '../src/agent-tools/interface-catalog.js';
import { createJudgmentBackend } from '../src/judgment/backend.js';
import { createJudgmentEngine } from '../src/judgment/engine.js';
import { handleJudgmentApiRequest } from '../src/judgment/http.js';
import { undoAutomaticReview } from '../src/judgment/review-undo.js';
import { createJudgmentService } from '../src/judgment/service.js';
import { knowledgeReferences } from '../src/knowledge-hard-delete/forget-references.js';
import { readModelBackendConfig } from '../src/model-backends/config.js';
import { latestEvaluation, recordEvaluation } from '../src/model-backends/evaluation-record.js';
import { handleModelBackendApiRequest } from '../src/model-backends/http.js';
import { createModelBackendPort } from '../src/model-backends/port.js';
import { createRoleTrust } from '../src/model-backends/role-trust.js';
import { WARNING_VERSION } from './fixtures/model-trust.js';
import { ModelUsageLedger } from '../src/model-backends/usage-ledger.js';
import { reachableModules } from '../test-support/module-graph.js';
import { completePreferences } from './fixtures/collaboration-preferences.js';

// rec#10 D-36.5–D-36.12: a Tonborg knowledge review that Tonborg's own
// configured model approved applies by default, unless the person chose
// 「只给建议」 or has not acknowledged the warning; a current-session answer
// stays a suggestion. Trust relaxes no other check. Fake model answers, a
// synthetic Provider and synthetic settings only.

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const input = { personalSpaceId: 's', personalProjectId: 'p', requestId: 'trust-request', limit: 10 };
const BUDGET = { maxInputTokens: 50_000, maxOutputTokens: 800, timeoutMs: 30_000, windowHours: 24, maxTokensPerWindow: 1_000_000 };
const CONNECTIONS = {
  local: { protocol: 'openai_chat', endpoint: 'http://127.0.0.1:11434/v1', model: 'qwen-test', secretRef: null },
  cloud: { protocol: 'anthropic_messages', endpoint: 'https://models.cloud.test', model: 'cloud-test', secretRef: 'cloud-key' }
};
const tonborg = (connection = 'local', extra = {}) => ({ enabled: true, connection, allowedOperations: ['knowledge_review'],
  budget: BUDGET, egress: { approvedProjects: [{ personalSpaceId: 's', personalProjectId: 'p' }], allowUnassigned: false },
  fallbackToSession: true, ...extra });
const approval = { target: 'entity:one', outcome: 'approve', summary: 'Routine confirmed command', evidence: ['npm test'], confidence: 0.95 };

// answeredBy: who the stand-in bridge reports answered; answering: awaited
// while the model "answers", so a test can act during an in-flight review.
function harness(t, { mode = 'shared', connection = 'local', roles, acknowledged = true, answeredBy = 'model_api',
  capture = { enabled: true }, answering = async () => {}, candidateCount = 1 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fuli-model-trust-'));
  const config = { version: 1, connections: CONNECTIONS, roles: roles ?? { tonborg: tonborg(connection) } };
  const ledger = new ModelUsageLedger(':memory:');
  const port = createModelBackendPort({ readConfig: () => readModelBackendConfig('inline', { read: () => config }),
    secrets: { read: async () => { throw new Error('no secret is read: the bridge is a stand-in'); } }, ledger });
  const trustPath = join(dir, 'model-trust.sqlite');
  const trust = createRoleTrust({ path: trustPath, modelBackends: port });
  if (acknowledged) trust.acknowledgeWarning('tonborg', WARNING_VERSION, 0);
  const candidates = Array.from({ length: candidateCount }, (_, index) => ({ candidate_key: `entity:${index ? `n${index}` : 'one'}`,
    title: 'Build command', content: 'npm test', confirmation_status: 'confirmed', reasons: [], project_ids: ['p'],
    ai_review_evidence_token: `${index}`.repeat(64) }));
  const writes = [];
  const app = { config: { personal: { spaceId: 's' } }, getCapturePolicy: () => capture,
    listPersonalProjects: async () => [{ project_id: 'p' }],
    listProjectAgents: async () => [{ agentId: 'employee.tonborg', profile: { status: 'active', allowedClients: ['codex'], capabilities: ['fuli.employee:tonborg'] } }],
    getCollaborationPreferences: async () => completePreferences(),
    inspectProjectAgentMemory: async () => ({ current: null, revision: 0 }),
    employees: { authorize: async () => ({}) },
    startKnowledgeReview: async () => ({ review_id: 'review' }),
    finishKnowledgeReview: async () => ({}),
    listKnowledgeReviewCandidates: async () => ({ candidates, total_candidate_count: candidates.length }),
    recordKnowledgeReviewProgress: async value => { writes.push(value); return { outcome: value.outcome }; } };
  const model = CONNECTIONS[connection].model;
  const bridge = { decide: async () => {
    await answering();
    const envelope = { payload: { decisions: candidates.map(candidate => ({ ...approval, target: candidate.candidate_key })) } };
    return answeredBy === 'model_api'
      ? { status: 'answered', mode: 'model_api', envelope,
        modelReceipt: { backend: 'model_api', status: 'answered', requestedModel: model, actualModel: `${model}-served` } }
      : { status: 'answered', mode: 'current_session', envelope, session: { sourceApplication: 'codex', sessionRef: 'session-1' },
        modelReceipt: { backend: 'current_session', status: 'answered', requestedModel: null, actualModel: null }, workPackageId: 'work-1' };
  } };
  const service = createJudgmentService({ app, engine: createJudgmentEngine({ app, judge: createJudgmentBackend({ bridge }), trust }) });
  service.store().setPolicy('s', '', { mode, quality: 'quality', client: 'codex' }, 0);
  t.after(() => { service.close(); trust.close(); ledger.close(); rmSync(dir, { recursive: true, force: true }); });
  // The next review offers a different item: one already judged with unchanged evidence is not asked again.
  const nextItem = () => candidates.splice(0, candidates.length, { ...candidates[0], candidate_key: 'entity:next', ai_review_evidence_token: 'f'.repeat(64) });
  return { service, writes, app, trust, trustPath, port, config, nextItem };
}

async function reviewOnce(t, options) {
  const h = harness(t, options);
  const result = await h.service.review(input);
  return { ...h, result, record: result.records[0] };
}

// Another process changing the same role: its own connection to the same store.
const otherProcess = h => {
  const trust = createRoleTrust({ path: h.trustPath, modelBackends: h.port });
  return { trust, done: () => trust.close() };
};

test('a configured model applies its review by default on local and cloud connections, named in the receipt', async t => {
  for (const connection of Object.keys(CONNECTIONS)) {
    const { writes, record } = await reviewOnce(t, { connection });
    assert.deepEqual([record.outcome, record.execution.status], ['approve', 'applied'], connection);
    assert.deepEqual(record.aiReview.gate, { status: 'passed', reason: null, modelId: CONNECTIONS[connection].model });
    assert.deepEqual(record.aiReview.interceptions, []);
    assert.equal(writes[0].outcome, 'ai_reviewed');
  }
});

test('before the person acknowledges the warning the first execution is a suggestion; reading settings never acknowledges it', async t => {
  const h = harness(t, { acknowledged: false });
  const [record] = (await h.service.review(input)).records;
  assert.deepEqual([record.aiReview.state, record.aiReview.gate.reason, record.execution.status], ['ai_suggested', 'warning_not_seen', 'not_applied']);
  assert.equal(h.writes.length, 0);
  // The settings page and a receipt read the state; only the acknowledgement route changes it.
  const read = await call(h, 'GET', '/api/model-backends/roles');
  const tonborgRole = read.body.roles.find(role => role.role === 'tonborg');
  assert.deepEqual([tonborgRole.trust.status, tonborgRole.trust.reason, tonborgRole.trust.warningSeen], ['suggestion', 'warning_not_seen', false]);
  assert.equal(h.trust.view('tonborg', 'knowledge_review').warningSeen, false);
  const remote = await call(h, 'PUT', '/api/model-backends/roles/tonborg/trust', { expectedRevision: 0, acknowledgeWarning: WARNING_VERSION }, '192.168.1.20');
  assert.deepEqual([remote.status, remote.body.code], [403, 'local_user_only']);
  const seen = await call(h, 'PUT', '/api/model-backends/roles/tonborg/trust', { expectedRevision: 0, acknowledgeWarning: WARNING_VERSION });
  const view = seen.body.roles.find(role => role.role === 'tonborg').trust;
  assert.deepEqual([view.status, view.warningSeen, view.revision], ['automatic', true, 1]);
  h.nextItem();
  const [next] = (await h.service.review({ ...input, requestId: 'after-ack' })).records;
  assert.equal(next.execution.status, 'applied');
});

test('「只给建议」 keeps every answer a suggestion until the person switches it off', async t => {
  const h = harness(t);
  h.trust.setSuggestionsOnly('tonborg', true, 1);
  const [held] = (await h.service.review(input)).records;
  assert.deepEqual([held.aiReview.state, held.aiReview.gate.reason, held.execution.status], ['ai_suggested', 'suggestions_only', 'not_applied']);
  assert.equal(h.writes.length, 0);
  h.trust.setSuggestionsOnly('tonborg', false, 2);
  h.nextItem();
  const [applied] = (await h.service.review({ ...input, requestId: 'switched-back' })).records;
  assert.equal(applied.execution.status, 'applied');
  // A change from a page that read an older state is refused and saves nothing.
  assert.throws(() => h.trust.setSuggestionsOnly('tonborg', true, 2), { code: 'model_trust_changed' });
});

test('an unconfigured role, a disabled role and a session fallback keep today\'s behavior: a session answer is a suggestion', async t => {
  for (const roles of [{}, { tonborg: tonborg('local', { enabled: false }) }, undefined]) {
    const { writes, record } = await reviewOnce(t, { roles, answeredBy: 'current_session' });
    assert.deepEqual([record.aiReview.state, record.aiReview.gate.reason], ['ai_suggested', 'session_answer']);
    assert.equal(writes.length, 0);
  }
  // Settings shows the same for a role without a model.
  const h = harness(t, { roles: {} });
  assert.deepEqual(pick(h.trust.view('tonborg', 'knowledge_review'), ['status', 'reason']), { status: 'suggestion', reason: 'session_answer' });
});

test('an upgrade resets no choice: a stored 「只给建议」, a manual policy and the model settings stay as they were', async t => {
  const h = harness(t, { mode: 'manual' });
  const settingsBefore = structuredClone(h.config);
  const policyBefore = h.service.store().policy('s', '');
  // A manual policy is the person's own rule: a trusted model still only suggests.
  const [manual] = (await h.service.review(input)).records;
  assert.deepEqual([manual.aiReview.state, manual.aiReview.interceptions, manual.aiReview.gate.status], ['ai_suggested', ['manual_policy'], 'passed']);
  h.trust.setSuggestionsOnly('tonborg', true, 1);
  h.trust.close();
  // The next FULI opens the same store: the choice and the acknowledgement are kept.
  const reopened = createRoleTrust({ path: h.trustPath, modelBackends: h.port });
  const kept = reopened.view('tonborg', 'knowledge_review');
  reopened.close();
  assert.deepEqual(pick(kept, ['suggestionsOnly', 'warningSeen', 'revision', 'reason']),
    { suggestionsOnly: true, warningSeen: true, revision: 2, reason: 'suggestions_only' });
  assert.deepEqual(h.config, settingsBefore);
  assert.deepEqual(h.service.store().policy('s', ''), policyBefore);
  assert.equal(h.writes.length, 0);
});

test('a switch to 「只给建议」 while a review is in flight stops its write (race regression)', async t => {
  // During the model's answer: the answer is used under the new mode.
  let other;
  const during = harness(t, { answering: async () => { other = otherProcess(during); other.trust.setSuggestionsOnly('tonborg', true, 1); } });
  const [held] = (await during.service.review(input)).records;
  other.done();
  assert.deepEqual([held.aiReview.gate.reason, held.execution.status], ['suggestions_only', 'not_applied']);
  assert.equal(during.writes.length, 0);

  // After the gate was read and before the write: the commit reads the mode again under the store's lock.
  const late = harness(t, { candidateCount: 2 });
  const list = late.app.listKnowledgeReviewCandidates;
  let listings = 0;
  const switcher = otherProcess(late);
  // Listing 2 is the recheck before the first write, listing 3 before the second.
  late.app.listKnowledgeReviewCandidates = async value => { if (++listings === 3) switcher.trust.setSuggestionsOnly('tonborg', true, 1); return list(value); };
  const [first, second] = (await late.service.review(input)).records;
  switcher.done();
  assert.equal(first.execution.status, 'applied');
  assert.equal(first.aiReview.state, 'ai_reviewed');
  assert.deepEqual([second.execution.status, second.execution.receipt.reason], ['stale', 'suggestions_only']);
  assert.equal(late.writes.length, 1);
  // The stopped item has no stored intent, so no restart or recovery writes it later.
  assert.equal(second.executionHistory.some(entry => entry.status === 'applying'), false);
});

test('trust relaxes no other check: egress, the capture switch and the person\'s policy still stop a write', async t => {
  // Egress approval withdrawn after the answer: the write is not made.
  const egress = harness(t);
  const list = egress.app.listKnowledgeReviewCandidates;
  let calls = 0;
  egress.app.listKnowledgeReviewCandidates = async value => {
    if (++calls === 2) egress.config.roles.tonborg = { ...egress.config.roles.tonborg, egress: { approvedProjects: [], allowUnassigned: false } };
    return list(value);
  };
  const [stopped] = (await egress.service.review(input)).records;
  assert.deepEqual([stopped.execution.status, stopped.execution.receipt.reason], ['stale', 'egress_not_approved']);
  assert.equal(egress.writes.length, 0);

  // The model is replaced in settings while it answers: the old model's answer is not trusted.
  const replaced = harness(t, { answering: async () => { replaced.config.connections = { ...CONNECTIONS, local: { ...CONNECTIONS.local, model: 'other-model' } }; } });
  const [other] = (await replaced.service.review(input)).records;
  assert.deepEqual([other.aiReview.gate.reason, replaced.writes.length], ['model_changed', 0]);

  // Recording off, globally or for this project: a suggestion, never a write.
  for (const capture of [{ enabled: false }, { enabled: true, projectMode: 'all_except', excludedProjectIds: ['p'] }]) {
    const { writes, record } = await reviewOnce(t, { capture });
    assert.deepEqual([record.aiReview.state, record.aiReview.gate.reason], ['ai_suggested', 'capture_off'], JSON.stringify(capture));
    assert.equal(writes.length, 0);
  }
  // Recording switched off after the gate was read: the commit checks it again.
  const late = harness(t);
  let listings = 0;
  const original = late.app.listKnowledgeReviewCandidates;
  late.app.getCapturePolicy = () => (listings >= 2 ? { enabled: false } : { enabled: true });
  late.app.listKnowledgeReviewCandidates = async value => { listings += 1; return original(value); };
  const [off] = (await late.service.review(input)).records;
  assert.deepEqual([off.execution.status, off.execution.receipt.reason], ['stale', 'capture_off']);
  assert.equal(late.writes.length, 0);
});

test('undo takes back an applied review and never overwrites a later edit or a permanent delete', async t => {
  const { service, record } = await reviewOnce(t);
  const sent = [];
  const undoConsole = { withdrawAiReview: async body => { sent.push(body); return { decision_id: 'decision-1' }; } };
  const undone = await undoAutomaticReview({ judgment: service, undoConsole, input: { personalSpaceId: 's', decisionId: record.id } });
  assert.equal(undone.execution.status, 'undone');
  assert.deepEqual(sent, [{ personal_space_id: 's', review_id: 'review', candidate_key: 'entity:one', ai_review_evidence_token: '0'.repeat(64) }]);
  await assert.rejects(undoAutomaticReview({ judgment: service, undoConsole, input: { personalSpaceId: 's', decisionId: record.id } }),
    { code: 'judgment_not_undoable' });

  // The person edited the item since: the Provider refuses and nothing changes or is recorded here.
  const edited = await reviewOnce(t);
  const changed = Object.assign(new Error('the item changed after this AI review; it was left as it is'), { status: 409, code: 'ai_review_changed' });
  await assert.rejects(undoAutomaticReview({ judgment: edited.service, undoConsole: { withdrawAiReview: async () => { throw changed; } },
    input: { personalSpaceId: 's', decisionId: edited.record.id } }), { code: 'ai_review_changed' });
  assert.equal(edited.service.store().get('s', edited.record.id).execution.status, 'applied');

  // The person permanently deleted it: refused before anything is sent, and nothing comes back.
  const deleted = await reviewOnce(t);
  deleted.service.store().forgetKnowledgeItems('s', knowledgeReferences({ candidateKeys: ['entity:one'] }));
  const untouched = { withdrawAiReview: async () => assert.fail('a deleted item must not be sent') };
  await assert.rejects(undoAutomaticReview({ judgment: deleted.service, undoConsole: untouched,
    input: { personalSpaceId: 's', decisionId: deleted.record.id } }), { code: 'ai_review_deleted' });
  assert.equal(deleted.service.store().get('s', deleted.record.id).execution.status, 'applied');
});

test('only the local console can undo, and no Agent tool reaches the undo channel or a trust change', async () => {
  const entry = agentInterfaceCatalog().uiMutationParity.find(item => item.route === 'POST /api/judgment/undo');
  assert.equal(entry.access, 'local_user_only');
  const trustEntry = agentInterfaceCatalog().uiMutationParity.find(item => item.route === 'PUT /api/model-backends/roles/:role/trust');
  assert.equal(trustEntry.access, 'local_user_only');
  const request = Object.assign(Readable.from([Buffer.from('{}')]), { method: 'POST',
    headers: { 'content-type': 'application/json' }, socket: { remoteAddress: '192.168.1.20' } });
  const sent = {};
  const response = { setHeader() {}, writeHead(status) { sent.status = status; }, end(text) { sent.body = JSON.parse(text); } };
  await handleJudgmentApiRequest({ request, response, url: new URL('http://127.0.0.1/api/judgment/undo'),
    app: { judgment: {} }, undoConsole: { withdrawAiReview: () => assert.fail('a remote undo must not be sent') } });
  assert.equal(sent.status, 403);
  assert.equal(sent.body.code, 'local_user_only');
  for (const module of ['src/judgment/review-undo.js', 'src/model-backends/http.js']) {
    for (const path of ['src/mcp-server.js', 'src/agent-tools.js', 'src/mcp/create-mcp-server.js']) {
      assert.equal(reachableModules(join(ROOT, path)).has(join(ROOT, module)), false, `${path} -> ${module}`);
    }
  }
});

test('the settings page shows the latest local evaluation of the configured model only', async t => {
  const h = harness(t);
  const path = join(mkdtempSync(join(tmpdir(), 'fuli-model-eval-')), 'model-evaluations.json');
  t.after(() => rmSync(join(path, '..'), { recursive: true, force: true }));
  const key = { role: 'tonborg', operation: 'knowledge_review', model: 'qwen-test' };
  const readEvaluation = evaluation => latestEvaluation(path, evaluation);
  const shown = async () => (await call(h, 'GET', '/api/model-backends/roles', null, '127.0.0.1', { readEvaluation }))
    .body.roles.find(role => role.role === 'tonborg').trust.evaluation;
  assert.equal(await shown(), null);
  const result = { ...key, set: 'tonborg-review-eval/holdout', evaluatedAt: '2026-10-22T08:00:00.000Z', agreed: 71, total: 162 };
  recordEvaluation(path, { ...result, model: 'another-model' });
  assert.equal(await shown(), null);
  recordEvaluation(path, result);
  recordEvaluation(path, { ...result, evaluatedAt: '2026-10-21T08:00:00.000Z', agreed: 1 });
  assert.deepEqual(await shown(), result);
  assert.throws(() => recordEvaluation(path, { ...result, agreed: 200 }));
});

// A request to the model settings routes from address (loopback by default).
async function call(h, method, pathname, body = null, address = '127.0.0.1', extra = {}) {
  const request = Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []), { method,
    headers: { 'content-type': 'application/json' }, socket: { remoteAddress: address } });
  const sent = {};
  const response = { setHeader() {}, writeHead(status) { sent.status = status; }, end(text) { sent.body = JSON.parse(text); } };
  await handleModelBackendApiRequest({ request, response, url: new URL(`http://127.0.0.1${pathname}`), modelBackends: h.port,
    operations: { tonborg: ['knowledge_review'] }, automaticOperations: { tonborg: 'knowledge_review' }, modelTrust: h.trust, ...extra });
  return sent;
}

const pick = (value, keys) => Object.fromEntries(keys.map(key => [key, value[key]]));
