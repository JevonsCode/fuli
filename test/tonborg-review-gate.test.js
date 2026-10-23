import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { agentInterfaceCatalog } from '../src/agent-tools/interface-catalog.js';
import { createJudgmentBackend } from '../src/judgment/backend.js';
import { createJudgmentEngine } from '../src/judgment/engine.js';
import { handleJudgmentApiRequest } from '../src/judgment/http.js';
import { createReviewGate, REVIEW_GATE_FILE } from '../src/judgment/review-gate.js';
import { REVIEW_PROMPT_VERSION, reviewInstructions } from '../src/judgment/review-prompt.js';
import { undoAutomaticReview } from '../src/judgment/review-undo.js';
import { createJudgmentService } from '../src/judgment/service.js';
import { reachableModules } from '../test-support/module-graph.js';
import { completePreferences } from './fixtures/collaboration-preferences.js';
import { FIXTURE_BUILD, gateEntry, reviewGateWith } from './fixtures/review-gate.js';

// rec#10 D-24: a Tonborg knowledge review applies itself only for a model
// build the person unlocked; everything else is a suggestion the person
// decides. Fake model backends and a synthetic Provider only.

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const input = { personalSpaceId: 's', personalProjectId: 'p', requestId: 'gate-request', limit: 10 };
const MODES = ['manual', 'shared', 'autonomous'];
// The same build reached as a local and as a cloud backend: the gate keys on the build, not where it runs.
const BACKENDS = {
  local: { connection: 'local', protocol: 'openai_chat', endpointHost: '127.0.0.1:11434' },
  cloud: { connection: 'cloud', protocol: 'anthropic_messages', endpointHost: 'models.cloud.test' }
};

function harness(t, { mode = 'shared', backend = 'local', reviewGate, build = FIXTURE_BUILD } = {}) {
  const candidates = [{ candidate_key: 'entity:one', title: 'Build command', content: 'npm test', confirmation_status: 'confirmed',
    reasons: [], project_ids: ['p'], ai_review_evidence_token: 'e'.repeat(64) }];
  const writes = [];
  const app = { config: { personal: { spaceId: 's' } },
    listPersonalProjects: async () => [{ project_id: 'p' }],
    listProjectAgents: async () => [{ agentId: 'employee.tonborg', profile: { status: 'active', allowedClients: ['codex'], capabilities: ['fuli.employee:tonborg'] } }],
    getCollaborationPreferences: async () => completePreferences(),
    inspectProjectAgentMemory: async () => ({ current: null, revision: 0 }),
    employees: { authorize: async () => ({}) },
    startKnowledgeReview: async () => ({ review_id: 'review' }),
    finishKnowledgeReview: async () => ({}),
    listKnowledgeReviewCandidates: async () => ({ candidates, total_candidate_count: candidates.length }),
    recordKnowledgeReviewProgress: async value => { writes.push(value); candidates.shift(); return { outcome: value.outcome }; } };
  const bridge = { decide: async () => ({ status: 'answered', mode: 'model_api',
    envelope: { payload: { decisions: [{ target: 'entity:one', outcome: 'approve', summary: 'Routine confirmed command',
      evidence: ['npm test'], confidence: 0.95 }] } },
    modelReceipt: { backend: 'model_api', status: 'answered', ...BACKENDS[backend], requestedModel: build.model,
      actualModel: build.model, modelDigest: build.modelDigest } }) };
  const service = createJudgmentService({ app,
    engine: createJudgmentEngine({ app, judge: createJudgmentBackend({ bridge }), reviewGate }) });
  service.store().setPolicy('s', '', { mode, quality: 'quality', client: 'codex' }, 0);
  t.after(() => service.close());
  return { service, writes, app };
}

async function reviewOnce(t, options) {
  const { service, writes } = harness(t, options);
  const result = await service.review(input);
  return { service, writes, result, record: result.records[0] };
}

test('the prompt version names the instruction template, not the policy filled into it', () => {
  assert.match(REVIEW_PROMPT_VERSION, /^knowledge-review:[0-9a-f]{16}$/);
  assert.match(reviewInstructions({ quality: 'economy' }), /Quality priority: economy\.$/);
});

test('without a registry entry every backend and policy escalates a suggestion and writes no ai_reviewed', async t => {
  for (const mode of MODES) {
    for (const backend of Object.keys(BACKENDS)) {
      for (const reviewGate of [undefined, reviewGateWith()]) {
        const { writes, result, record } = await reviewOnce(t, { mode, backend, reviewGate });
        const label = `${mode}/${backend}`;
        assert.equal(writes.length, 0, label);
        assert.equal(record.outcome, 'escalate', label);
        assert.equal(record.execution.status, 'not_applied', label);
        // The model's verdict stays as it answered; the host's reasons sit beside it.
        assert.equal(record.aiReview.state, 'ai_suggested', label);
        assert.equal(record.aiReview.modelOutcome, 'approve', label);
        assert.ok(record.aiReview.interceptions.includes('gate_not_passed'), label);
        assert.equal(record.aiReview.interceptions.includes('manual_policy'), mode === 'manual', label);
        const { status, reason, modelId, modelDigest, promptVersion } = record.aiReview.gate;
        assert.deepEqual({ status, reason, modelId, modelDigest, promptVersion }, { status: 'not_passed', reason: 'no_entry',
          modelId: FIXTURE_BUILD.model, modelDigest: FIXTURE_BUILD.modelDigest, promptVersion: REVIEW_PROMPT_VERSION }, label);
        assert.match(result.human_interaction.question, /^AI 建议，待你确认 \/ AI suggestion, awaiting your decision \(model: approve\) Routine/);
      }
    }
  }
});

test('an entry for another prompt, context, sampling or build does not unlock', async t => {
  const others = [{ promptVersion: 'knowledge-review:0000000000000000' }, { contextVersion: 'preference-receipt-0' },
    { sampling: { temperature: 0, seed: 20261022 } }, { modelDigest: 'sha256:other-build' }, { modelId: 'other-model' }];
  for (const change of others) {
    const { writes, record } = await reviewOnce(t, { reviewGate: reviewGateWith(gateEntry(change)) });
    assert.equal(writes.length, 0, JSON.stringify(change));
    assert.equal(record.aiReview.gate.reason, 'no_entry');
  }
  // A backend that reports no served digest cannot be matched at all.
  const unknown = await reviewOnce(t, { reviewGate: reviewGateWith(gateEntry()), build: { model: FIXTURE_BUILD.model, modelDigest: undefined } });
  assert.equal(unknown.record.aiReview.gate.reason, 'model_build_unknown');
  assert.equal(unknown.writes.length, 0);
});

test('an entry whose evaluation misses the gate, or a registry this FULI cannot read, unlocks nothing', async t => {
  const below = [{ holdout: { agreed: 36, total: 54 } }, { injection: { accepted: 1, total: 15 } },
    { confidenceEcho: { echoed: 17, total: 162 } }];
  for (const change of below) {
    const entry = gateEntry();
    const { writes, record } = await reviewOnce(t, { reviewGate: reviewGateWith({ ...entry, evaluation: { ...entry.evaluation, ...change } }) });
    assert.equal(record.aiReview.gate.reason, 'evaluation_below_gate', JSON.stringify(change));
    assert.equal(writes.length, 0);
  }
  for (const text of ['{', JSON.stringify({ version: 2, entries: [gateEntry()] }), JSON.stringify({ version: 1, entries: [{ modelId: 'x' }] })]) {
    const { writes, record } = await reviewOnce(t, { reviewGate: createReviewGate('synthetic-data-dir', { readText: () => text }) });
    assert.equal(record.aiReview.gate.reason, 'registry_unreadable');
    assert.equal(writes.length, 0);
  }
});

test('two entries for the same build make the registry invalid in either order, so nothing applies', async t => {
  const passing = gateEntry();
  const failing = { ...passing, evaluation: { ...passing.evaluation, injection: { accepted: 1, total: 15 } } };
  for (const entries of [[failing, passing], [passing, failing], [passing, { ...passing }]]) {
    const reviewGate = reviewGateWith(...entries);
    const { writes, record } = await reviewOnce(t, { reviewGate });
    assert.equal(record.aiReview.gate.reason, 'registry_unreadable');
    assert.equal(record.aiReview.state, 'ai_suggested');
    assert.equal(writes.length, 0);
    // The settings page reads the same registry and unlocks nothing either.
    assert.deepEqual(reviewGate.unlockedBuilds({ ...passing, modelDigest: null }), { readable: false, entries: [] });
  }
});

test('a matching entry applies the review on local and cloud backends and the person can undo it', async t => {
  for (const backend of Object.keys(BACKENDS)) {
    const { service, writes, record } = await reviewOnce(t, { backend, reviewGate: reviewGateWith(gateEntry()) });
    assert.equal(record.outcome, 'approve');
    assert.equal(record.execution.status, 'applied');
    assert.deepEqual([record.aiReview.state, record.aiReview.interceptions, record.aiReview.gate.status], ['ai_reviewed', [], 'passed']);
    assert.equal(record.aiReview.gate.evidence, 'synthetic evaluation fixture');
    assert.equal(writes[0].outcome, 'ai_reviewed');
    const sent = [];
    const undoConsole = { withdrawAiReview: async body => { sent.push(body); return { decision_id: 'decision-1' }; } };
    const undone = await undoAutomaticReview({ judgment: service, undoConsole, input: { personalSpaceId: 's', decisionId: record.id } });
    assert.equal(undone.execution.status, 'undone');
    assert.deepEqual(sent, [{ personal_space_id: 's', review_id: 'review', candidate_key: 'entity:one', ai_review_evidence_token: 'e'.repeat(64) }]);
    await assert.rejects(undoAutomaticReview({ judgment: service, undoConsole, input: { personalSpaceId: 's', decisionId: record.id } }),
      { code: 'judgment_not_undoable' });
    assert.equal(sent.length, 1);
  }
});

test('the registry file in the data directory is read on every review, so an entry applies and leaves at once', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'fuli-review-gate-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const gate = createReviewGate(dataDir);
  const key = { modelId: FIXTURE_BUILD.model, modelDigest: FIXTURE_BUILD.modelDigest, promptVersion: gateEntry().promptVersion,
    contextVersion: gateEntry().contextVersion, sampling: gateEntry().sampling };
  assert.equal(gate.status(key).reason, 'no_entry');
  writeFileSync(join(dataDir, REVIEW_GATE_FILE), JSON.stringify({ version: 1, entries: [gateEntry()] }));
  assert.equal(gate.status(key).status, 'passed');
  writeFileSync(join(dataDir, REVIEW_GATE_FILE), JSON.stringify({ version: 1, entries: [] }));
  assert.equal(gate.status(key).reason, 'no_entry');
});

test('a matching entry under a manual policy still applies nothing and asks the person', async t => {
  const { writes, result, record } = await reviewOnce(t, { mode: 'manual', reviewGate: reviewGateWith(gateEntry()) });
  assert.equal(record.outcome, 'approve');
  assert.deepEqual([record.aiReview.state, record.aiReview.interceptions], ['ai_suggested', ['manual_policy']]);
  assert.equal(writes.length, 0);
  assert.equal(result.human_interaction.source.id, record.id);
  assert.match(result.human_interaction.question, /^AI 建议，待你确认 .*\(model: approve\) Routine/);
});

test('an entry removed while a batch runs stops the write that has not happened yet', async t => {
  let entries = [gateEntry()];
  const reviewGate = createReviewGate('synthetic-data-dir', { readText: () => JSON.stringify({ version: 1, entries }) });
  const { service, writes, app } = harness(t, { reviewGate });
  const list = app.listKnowledgeReviewCandidates;
  let calls = 0;
  // The second listing is the recheck right before the write-back; the person removes the entry meanwhile.
  app.listKnowledgeReviewCandidates = async value => { if (++calls === 2) entries = []; return list(value); };
  const [record] = (await service.review(input)).records;
  assert.equal(record.aiReview.state, 'ai_reviewed');
  assert.deepEqual([record.execution.status, record.execution.receipt.reason], ['stale', 'gate_not_passed']);
  assert.equal(writes.length, 0);
});

test('only the local console can undo, and no Agent tool reaches the undo channel', async () => {
  const entry = agentInterfaceCatalog().uiMutationParity.find(item => item.route === 'POST /api/judgment/undo');
  assert.equal(entry.access, 'local_user_only');
  const request = Object.assign(Readable.from([Buffer.from('{}')]), { method: 'POST',
    headers: { 'content-type': 'application/json' }, socket: { remoteAddress: '192.168.1.20' } });
  const sent = {};
  const response = { setHeader() {}, writeHead(status) { sent.status = status; }, end(text) { sent.body = JSON.parse(text); } };
  await handleJudgmentApiRequest({ request, response, url: new URL('http://127.0.0.1/api/judgment/undo'),
    app: { judgment: {} }, undoConsole: { withdrawAiReview: () => assert.fail('a remote undo must not be sent') } });
  assert.equal(sent.status, 403);
  assert.equal(sent.body.code, 'local_user_only');
  const undo = join(ROOT, 'src/judgment/review-undo.js');
  for (const path of ['src/mcp-server.js', 'src/agent-tools.js', 'src/mcp/create-mcp-server.js']) {
    assert.equal(reachableModules(join(ROOT, path)).has(undo), false, path);
  }
});
