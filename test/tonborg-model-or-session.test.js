import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { callAgentTool } from '../src/agent-tools.js';
import { roleWorkSessions } from '../src/graphiti/role-work-sessions.js';
import { createJudgmentBackend } from '../src/judgment/backend.js';
import { createJudgmentEngine } from '../src/judgment/engine.js';
import { createJudgmentService } from '../src/judgment/service.js';
import { JudgmentStore } from '../src/judgment/store.js';
import { readModelBackendConfig } from '../src/model-backends/config.js';
import { createModelBackendPort } from '../src/model-backends/port.js';
import { createRoleTrust } from '../src/model-backends/role-trust.js';
import { WARNING_VERSION } from './fixtures/model-trust.js';
import { createRoleWorkBridge } from '../src/model-backends/role-work.js';
import { RoleWorkStore } from '../src/model-backends/role-work-store.js';
import { ModelUsageLedger } from '../src/model-backends/usage-ledger.js';
import { completePreferences } from './fixtures/collaboration-preferences.js';
import { openAiStream } from './fixtures/model-transport.js';

// rec#8 T1-T5 and C1-C13 for Tonborg through its production interfaces:
// the judgment service, the model port with a fake transport, and the
// role_work tool answered by fake MCP sessions. No real model or CLI runs.

const OPERATIONS = ['knowledge_review', 'executor_routing', 'task_acceptance'];
const BUDGET = { maxInputTokens: 50_000, maxOutputTokens: 800, timeoutMs: 30_000, windowHours: 24, maxTokensPerWindow: 1_000_000 };
const tonborg = (extra = {}) => ({ enabled: true, connection: 'local', allowedOperations: OPERATIONS, budget: BUDGET,
  egress: { approvedProjects: [{ personalSpaceId: 's', personalProjectId: 'p' }], allowUnassigned: false },
  fallbackToSession: true, ...extra });
const SESSIONS = {
  'token-a': { sessionId: 'session-a', personalProjectId: 'p', projectAgentId: 'lead', sourceApplication: 'claude_code' },
  'token-b': { sessionId: 'session-b', personalProjectId: 'p', projectAgentId: 'lead', sourceApplication: 'codex' },
  'token-q': { sessionId: 'session-q', personalProjectId: 'q', projectAgentId: 'lead', sourceApplication: 'codex' }
};
// These tests are about who answers and how a write survives retries and
// restarts, so the trust gate (rec#10 D-36, test/tonborg-model-trust.test.js)
// lets every answer apply unless a test asks for the production gate.
const UNGATED = () => ({ status: key => ({ status: 'passed', reason: null, modelId: key.model }), commit: (key, write) => write() });
// The production gate over the harness's model port; acknowledged: the person saw the warning.
const productionTrust = ({ acknowledged }) => port => {
  const trust = createRoleTrust({ modelBackends: port });
  if (acknowledged) trust.acknowledgeWarning('tonborg', WARNING_VERSION, 0);
  return trust;
};
const reviewInput = { personalSpaceId: 's', personalProjectId: 'p', requestId: 'review-1', limit: 10 };
const verdict = (extra = {}) => ({ target: 'entity:one', outcome: 'approve', summary: 'Confirmed routine command', evidence: ['npm test'], confidence: 0.95, ...extra });
// evidenceIds name parts of the judgment data: candidates for a review,
// eligible for routing, gate for an acceptance.
const answer = (payload, evidenceIds = ['candidates']) => ({ decision: 'propose', payload, reason: 'Supported by the evidence.', evidenceIds, uncertainty: null });
const reply = (payload, evidenceIds) => openAiStream(JSON.stringify(answer(payload, evidenceIds)));

// tags: what the fake local Ollama lists at /api/tags; without it the route is missing.
function harness(t, { roles = {}, replies = () => reply({ decisions: [verdict()] }), policy = {}, trust = UNGATED, tags = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fuli-tonborg-'));
  const clock = { at: Date.parse('2026-10-20T12:00:00.000Z') };
  const now = () => new Date(clock.at);
  const config = { version: 1, roles,
    connections: { local: { protocol: 'openai_chat', endpoint: 'http://127.0.0.1:11434/v1', model: 'qwen-test', secretRef: null } } };
  const calls = [], writes = [], legacyRuns = [], completions = [];
  const candidates = [{ candidate_key: 'entity:one', title: 'Build command', content: 'npm test', confirmation_status: 'confirmed',
    changed_at: '2026-01-01', reasons: [], project_ids: ['p'], ai_review_evidence_token: 'evidence-token' }];
  const task = { taskId: 't', personalProjectId: 'p', leadAgentId: 'lead', status: 'awaiting_review', revision: 2, title: 'Synthetic task', objective: 'Verify a change' };
  const ledger = new ModelUsageLedger(join(dir, 'model-usage.sqlite'));
  const port = createModelBackendPort({ readConfig: () => readModelBackendConfig('x', { read: () => config }),
    secrets: { read: async () => null }, ledger, wait: async () => {}, now,
    fetchImpl: async (url, init) => {
      if (new URL(url).pathname === '/api/tags') return tags ? Response.json(tags) : new Response('', { status: 404 });
      calls.push(JSON.parse(init.body));
      return replies(calls.length);
    } });
  const app = { config: { personal: { spaceId: 's' } }, getCapturePolicy: () => ({ enabled: true }),
    listPersonalProjects: async () => [{ project_id: 'p' }],
    listProjectAgents: async () => [{ agentId: 'employee.tonborg', profile: { status: 'active', allowedClients: ['codex'], capabilities: ['fuli.employee:tonborg'] } }],
    getCollaborationPreferences: async () => completePreferences(),
    inspectProjectAgentMemory: async () => ({ current: null, revision: 0 }),
    employees: { authorize: async () => ({}) },
    // Every synthetic item stays visible to the session reading Tonborg's result (rec#50).
    personal: { readVisibleKnowledgeItems: async ({ items }) => ({ items }) },
    startKnowledgeReview: async () => ({ review_id: 'review' }),
    finishKnowledgeReview: async () => ({}),
    listKnowledgeReviewCandidates: async () => ({ candidates, total_candidate_count: candidates.length }),
    recordKnowledgeReviewProgress: async input => { writes.push(input); candidates.shift(); return { outcome: input.outcome }; },
    // The Provider keys a review decision by run and candidate.
    readKnowledgeReviewDecision: async ({ reviewId, candidateKey }) => {
      const write = writes.findLast(item => item.reviewId === reviewId && item.candidateKey === candidateKey);
      return { decision: write ? { decision_id: `decision:${candidateKey}`, review_id: reviewId, candidate_key: candidateKey,
        outcome: write.outcome, ai_review_evidence_token: write.aiReviewEvidenceToken } : null };
    },
    listExecutors: async () => [],
    // The fake MCP session: a task-context token names one durable session.
    taskContextRegistry: { context: async token => {
      if (!SESSIONS[token]) throw Object.assign(new Error('Unknown task context'), { status: 404 });
      return { token, ...SESSIONS[token] };
    } },
    viewProjectAgentTask: async () => task,
    agentVerification: async () => ({ status: 'passed', artifact_revision: 'artifact-a', verified_attempt_id: 'attempt',
      verified_attempt: { attempt_id: 'attempt', artifact_revision: 'artifact-a', outcome: 'pass', verifier_id: 'reviewer', run_id: 'run', evidence_refs: ['report'] } }),
    recordProjectAgentTaskActivity: async value => { completions.push(value); task.status = 'completed'; return { ...task }; }
  };
  const roleTrust = trust(port);
  const open = () => {
    const bridge = createRoleWorkBridge({ port, store: new RoleWorkStore(join(dir, 'role-work.sqlite'), { recoveryGate: { state: () => ({ state: 'open' }) } }),
      verifySession: roleWorkSessions(app), resumers: { tonborg: work => app.judgment.resumeWork(work) },
      views: { tonborg: (result, session) => app.judgment.agent.workResult(result, session) }, now });
    const legacy = async input => {
      legacyRuns.push(input);
      return { client: 'codex', model: 'cli-model', body: JSON.stringify({ decisions: [verdict()] }) };
    };
    app.roleWork = bridge;
    app.judgment = createJudgmentService({ app, openStore: () => new JudgmentStore(join(dir, 'judgment.sqlite'), { recoveryGate: { state: () => ({ state: 'open' }) } }),
      engine: createJudgmentEngine({ app, judge: createJudgmentBackend({ bridge, legacy }), trust: roleTrust }) });
  };
  const close = () => { app.judgment.close(); app.roleWork.close(); };
  open();
  app.judgment.store().setPolicy('s', '', { mode: 'shared', quality: 'quality', client: 'codex', ...policy }, 0);
  t.after(() => { close(); ledger.close(); rmSync(dir, { recursive: true, force: true }); });
  const work = (action, input) => callAgentTool(app, 'role_work', { action, ...input });
  return { app, config, calls, writes, legacyRuns, completions, candidates, task, ledger, clock, work,
    restart() { close(); open(); } };
}

// Pauses the nth next call of one app method until released, so a test can
// interleave a second request at an exact point of the first.
function holdCall(app, name, nth = 1) {
  const original = app[name];
  let calls = 0, release, reached;
  const gate = new Promise(resolve => { release = resolve; });
  const arrived = new Promise(resolve => { reached = resolve; });
  app[name] = async (...args) => {
    if (++calls < nth) return original(...args);
    app[name] = original;
    reached();
    await gate;
    return original(...args);
  };
  return { arrived, release };
}

// Counts the reruns of Tonborg's operation with a session answer.
function countResumes(app) {
  const resume = app.judgment.resumeWork;
  const runs = { count: 0 };
  app.judgment.resumeWork = work => { runs.count += 1; return resume(work); };
  return runs;
}

const submitAgain = (h, token, workPackage) => h.work('submit', { taskContextToken: token, packageId: workPackage.packageId,
  leaseToken: workPackage.lease.token, answer: answer({ decisions: [verdict()] }) });

const claimAndSubmit = async (h, token, payload, evidenceIds) => {
  const { workPackage } = await h.work('claim', { taskContextToken: token, sourceApplication: 'codex' });
  return { workPackage, result: await h.work('submit', { taskContextToken: token, sourceApplication: 'codex', packageId: workPackage.packageId,
    leaseToken: workPackage.lease.token, answer: answer(payload, evidenceIds), usage: { inputTokens: 900, outputTokens: 40 } }) };
};

test('T1: a configured model gives a bounded decision on exact candidate keys; before the person saw the warning it is only a suggestion', async t => {
  const h = harness(t, { roles: { tonborg: tonborg() }, trust: productionTrust({ acknowledged: false }) });
  const [record] = (await h.app.judgment.review(reviewInput)).records;
  assert.equal(h.calls.length, 1);
  assert.equal(record.outcome, 'escalate');
  assert.deepEqual([record.aiReview.state, record.aiReview.modelOutcome], ['ai_suggested', 'approve']);
  // rec#10 D-36.11: until the warning is acknowledged on the settings page, the first execution is a suggestion.
  assert.deepEqual([record.aiReview.gate.reason, record.aiReview.gate.modelId], ['warning_not_seen', 'qwen-test']);
  assert.equal(record.execution.status, 'not_applied');
  assert.deepEqual(record.judgedBy, { mode: 'model_api', independent: true });
  assert.equal(record.client, null);
  assert.equal(record.model, 'qwen-test-actual');
  assert.equal(h.writes.length, 0);
  // The answer schema offered exactly the candidate keys.
  const schema = h.calls[0].response_format.json_schema.schema;
  assert.deepEqual(schema.properties.payload.properties.decisions.items.properties.target.enum, ['entity:one']);
  assert.equal(h.legacyRuns.length, 0);
});

test('T1: a local build observed after the answer never reaches the receipt, the record or the gate (D-32)', async t => {
  const observed = '1'.repeat(64);
  const h = harness(t, { roles: { tonborg: tonborg() }, trust: productionTrust({ acknowledged: true }),
    tags: { models: [{ name: 'qwen-test', model: 'qwen-test', digest: observed }] },
    replies: () => openAiStream(JSON.stringify(answer({ decisions: [verdict()] })), { model: 'qwen-test' }) });
  const [record] = (await h.app.judgment.review(reviewInput)).records;
  // The observation was made and kept for Settings only.
  assert.deepEqual(h.ledger.db.prepare('SELECT observed_tag_digest AS digest FROM model_attempts').all().map(row => row.digest), [observed]);
  // The configured model is trusted (rec#10 D-36.5); the gate names the model, never a build.
  assert.deepEqual([record.aiReview.state, record.aiReview.modelOutcome], ['ai_reviewed', 'approve']);
  assert.deepEqual(record.aiReview.gate, { status: 'passed', reason: null, modelId: 'qwen-test' });
  assert.equal(Object.hasOwn(record.modelReceipt, 'modelDigest'), false);
  assert.equal(JSON.stringify(record).includes(observed), false);
  const stored = h.app.judgment.store().db.prepare('SELECT body FROM judgment_records').all().map(row => row.body);
  assert.equal(stored.length, 1);
  assert.equal(stored.some(body => body.includes(observed)), false);
  assert.equal(record.execution.status, 'applied');
  assert.equal(JSON.stringify(h.writes).includes(observed), false);
});

test('T2: conflicting or negative evidence escalates even when the model is confident', async t => {
  const h = harness(t, { roles: { tonborg: tonborg() }, replies: () => reply({ decisions: [verdict({ confidence: 0.99 })] }) });
  h.candidates[0].negative_evidence_count = 2;
  h.candidates[0].reasons = ['conflict_or_attention'];
  const [record] = (await h.app.judgment.review(reviewInput)).records;
  assert.equal(record.outcome, 'escalate');
  assert.equal(h.writes.length, 0);
});

test('T3: a model approval cannot replace the autonomy gate or a protected item', async t => {
  const manual = harness(t, { roles: { tonborg: tonborg() }, policy: { mode: 'manual' } });
  const [record] = (await manual.app.judgment.review(reviewInput)).records;
  assert.equal(record.outcome, 'approve');
  assert.equal(record.execution.status, 'not_applied');
  const guarded = harness(t, { roles: { tonborg: tonborg() } });
  guarded.candidates[0].requires_attention = true;
  assert.equal((await guarded.app.judgment.review(reviewInput)).records[0].outcome, 'escalate');
  assert.equal(manual.writes.length + guarded.writes.length, 0);
});

test('T4: a recommended executor that is not available is never recorded as executed nor swapped for a paid client', async t => {
  const h = harness(t, { roles: { tonborg: tonborg() }, replies: () => reply({ executorId: 'gone', model: 'model', disposition: 'delegate',
    conversationId: null, summary: 'Use the gone executor', evidence: ['It was fast'] }, ['eligible']) });
  Object.assign(h.app, {
    getProjectAgent: async () => ({ profile: { allowedClients: ['codex'], executorPolicy: { mode: 'flexible' } } }),
    listExecutorRoutingRules: async () => [],
    listExecutors: async () => [{ executorId: 'here', displayName: 'here', executorKind: 'codex', registrationStatus: 'registered',
      permissionStatus: 'authorized', preflightStatus: 'passed', workspacePermission: true, availableModels: [{ model: 'model', available: true }] }]
  });
  const record = await h.app.judgment.assess({ personalSpaceId: 's', personalProjectId: 'p', agentId: 'a', requestId: 'route-1',
    workKind: 'review', objective: 'Verify artifact' });
  assert.equal(record.outcome, 'failed');
  assert.equal(record.selection, null);
  assert.equal(record.execution.status, 'not_applied');
  assert.equal(h.legacyRuns.length, 0);
});

test('C1 and C5: without its own model Tonborg hands a durable package to the session; nothing else is called', async t => {
  const h = harness(t, { roles: { bole: { ...tonborg(), allowedOperations: ['staffing_review'] } } });
  const [record] = (await h.app.judgment.review(reviewInput)).records;
  assert.equal(record.outcome, 'pending');
  assert.equal(record.execution.status, 'not_applied');
  assert.equal(record.workPackage.reason, 'role_not_configured');
  assert.equal(h.calls.length + h.legacyRuns.length + h.writes.length, 0);
  // A later run of the same work reuses the open package instead of judging again (C16).
  const again = await h.app.judgment.review({ ...reviewInput, requestId: 'review-2' });
  assert.equal(again.records[0].workPackage.packageId, record.workPackage.packageId);
  h.restart();
  assert.deepEqual(await h.work('claim', { taskContextToken: 'token-q' }), { workPackage: null });
  const { workPackage, result } = await claimAndSubmit(h, 'token-a', { decisions: [verdict()] });
  assert.equal(workPackage.packageId, record.workPackage.packageId);
  assert.equal(result.status, 'completed');
  const [judged] = result.result.records;
  assert.equal(judged.execution.status, 'applied');
  assert.deepEqual(judged.judgedBy, { mode: 'current_session', independent: false });
  assert.equal(judged.sessionId, 'session-a');
  assert.equal(h.writes[0].aiAssessment.client, 'claude_code');
  assert.equal(h.calls.length + h.legacyRuns.length, 0);
});

test('C2 and C13: a failing model falls back to the exact session; both usages are kept and a self-assessment is no verification', async t => {
  const h = harness(t, { roles: { tonborg: tonborg() }, replies: () => new Response('{"error":{"message":"busy"}}', { status: 503 }) });
  const input = { personalSpaceId: 's', personalProjectId: 'p', requestId: 'accept-1', taskId: 't', taskContextToken: 'token-a',
    artifactRevision: 'artifact-a', expectedRevision: 2, sourceApplication: 'claude_code' };
  const pending = await h.app.judgment.accept(input);
  assert.equal(pending.outcome, 'pending');
  assert.equal(pending.workPackage.reason, 'server_error');
  assert.equal(pending.workPackage.sessionRef, 'session-a');
  assert.equal(pending.modelReceipt.attempts, 2);
  await assert.rejects(h.work('claim', { taskContextToken: 'token-b', packageId: pending.workPackage.packageId }), { code: 'role_work_scope_mismatch' });
  const { result } = await claimAndSubmit(h, 'token-a', { outcome: 'approve', summary: 'Verified', evidence: ['report'], confidence: 0.97 }, ['gate']);
  const record = result.result;
  assert.equal(record.outcome, 'escalate');
  assert.equal(record.proposedOutcome, 'approve');
  assert.deepEqual(record.judgedBy, { mode: 'current_session', independent: false });
  assert.equal(record.modelReceipt.status, 'failed');
  assert.equal(h.completions.length + h.legacyRuns.length, 0);
  assert.deepEqual(await h.app.judgment.reviewVerdicts({ personalSpaceId: 's', agentId: 'lead' }), []);
  const groups = h.ledger.usage({ role: 'tonborg' });
  assert.deepEqual(groups.map(group => [group.channel, group.requests, group.attempts]).sort(), [['model_api', 1, 2], ['session', 1, 1]]);
  assert.equal(groups.find(group => group.channel === 'session').tokens.input.reported, 900);
});

test('C4 and C7: a permission refusal or unapproved egress stops; no package and no other model', async t => {
  const refused = harness(t, { roles: { tonborg: tonborg() },
    replies: () => new Response('{"error":{"message":"organization policy denies this request"}}', { status: 403 }) });
  const [record] = (await refused.app.judgment.review(reviewInput)).records;
  assert.equal(record.outcome, 'failed');
  assert.equal(record.error, 'permission_denied');
  assert.equal(record.modelReceipt.status, 'stopped');
  const unassigned = harness(t, { roles: { tonborg: tonborg() } });
  const global = await unassigned.app.judgment.review({ ...reviewInput, personalProjectId: null, requestId: 'global' });
  assert.equal(global.records.at(-1).error, 'egress_not_approved');
  assert.equal(unassigned.calls.length, 0);
  for (const h of [refused, unassigned]) {
    assert.deepEqual(await h.work('claim', { taskContextToken: 'token-a' }), { workPackage: null });
    assert.equal(h.legacyRuns.length + h.writes.length, 0);
  }
});

test('C6: an exhausted budget pauses the call and never moves the work to another budget pool', async t => {
  const h = harness(t, { roles: { tonborg: tonborg({ budget: { ...BUDGET, maxInputTokens: 10 } }) } });
  const [record] = (await h.app.judgment.review(reviewInput)).records;
  assert.equal(record.error, 'per_call_input');
  assert.equal(record.modelReceipt.status, 'paused');
  assert.equal(h.calls.length + h.legacyRuns.length, 0);
  assert.deepEqual(await h.work('claim', { taskContextToken: 'token-a' }), { workPackage: null });
});

test('C8: broken model output and invalid session answers are never acted on', async t => {
  const h = harness(t, { roles: { tonborg: tonborg({ fallbackToSession: false }) }, replies: () => openAiStream('not json') });
  const [record] = (await h.app.judgment.review(reviewInput)).records;
  assert.equal(record.error, 'invalid_output');
  assert.equal(h.calls.length, 2);
  const session = harness(t);
  await session.app.judgment.review(reviewInput);
  const { workPackage } = await session.work('claim', { taskContextToken: 'token-a' });
  const submit = payload => session.work('submit', { taskContextToken: 'token-a', packageId: workPackage.packageId,
    leaseToken: workPackage.lease.token, answer: answer(payload) });
  const extra = await submit({ decisions: [verdict({ target: 'entity:invented' })] });
  assert.equal(extra.status, 'invalid');
  assert.equal(extra.repairsLeft, 1);
  assert.equal((await submit({ decisions: [] })).status, 'failed');
  assert.equal(h.writes.length + session.writes.length, 0);
});

test('C9: a retried submission after a lost reply returns the recorded result without a second write', async t => {
  const h = harness(t);
  await h.app.judgment.review(reviewInput);
  const { workPackage, result } = await claimAndSubmit(h, 'token-a', { decisions: [verdict()] });
  const retry = await h.work('submit', { taskContextToken: 'token-a', packageId: workPackage.packageId,
    leaseToken: workPackage.lease.token, answer: answer({ decisions: [verdict()] }) });
  assert.equal(retry.replayed, true);
  assert.deepEqual(retry.result, result.result);
  assert.equal(h.writes.length, 1);
});

test('C9: a same-lease retry while the answer is applied waits for that one execution and is never stale', async t => {
  const h = harness(t);
  await h.app.judgment.review(reviewInput);
  const { workPackage } = await h.work('claim', { taskContextToken: 'token-a' });
  const runs = countResumes(h.app);
  // The first submit holds the project judgment lease while authorizing.
  const hold = holdCall(h.app, 'listProjectAgents');
  const first = submitAgain(h, 'token-a', workPackage);
  await hold.arrived;
  const retry = await submitAgain(h, 'token-a', workPackage);
  assert.equal(retry.status, 'applying');
  assert.equal(retry.workPackage.packageId, workPackage.packageId);
  hold.release();
  const done = await first;
  assert.equal(done.status, 'completed');
  assert.equal(done.result.records[0].execution.status, 'applied');
  assert.equal(runs.count, 1);
  assert.equal(h.writes.length, 1);
  assert.deepEqual(await submitAgain(h, 'token-a', workPackage), { status: 'completed', replayed: true, result: done.result });
  assert.deepEqual(h.app.roleWork.summary().packages, [{ role: 'tonborg', status: 'completed', count: 1 }]);
});

test('C9 and C11: completed only arrives with the stored result; a restart mid-execution resumes the kept answer', async t => {
  // The judgment lease of the interrupted execution lapses by wall-clock time.
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-20T12:00:00.000Z') });
  const h = harness(t);
  await h.app.judgment.review(reviewInput);
  const { workPackage } = await h.work('claim', { taskContextToken: 'token-a' });
  // Pause at the pre-write recheck: the answer is used, nothing is written yet.
  const hold = holdCall(h.app, 'listKnowledgeReviewCandidates', 2);
  void submitAgain(h, 'token-a', workPackage);
  await hold.arrived;
  const during = await submitAgain(h, 'token-a', workPackage);
  assert.equal(during.status, 'applying');
  assert.equal(h.writes.length, 0);
  // The process dies here: the paused execution never finishes.
  h.restart();
  assert.equal((await submitAgain(h, 'token-a', workPackage)).status, 'applying');
  h.clock.at += 11 * 60_000;
  // The window passed, but the dead execution still holds the judgment lease:
  // busy is transient, so the answer is kept, not made stale.
  await assert.rejects(submitAgain(h, 'token-a', workPackage), { code: 'judgment_busy' });
  t.mock.timers.tick(11 * 60_000);
  const runs = countResumes(h.app);
  const done = await submitAgain(h, 'token-a', workPackage);
  assert.equal(done.status, 'completed');
  assert.equal(done.result.records[0].execution.status, 'applied');
  assert.equal(runs.count, 1);
  assert.equal(h.writes.length, 1);
  assert.deepEqual(await submitAgain(h, 'token-a', workPackage), { status: 'completed', replayed: true, result: done.result });
});

test('C11: a restart after the Provider write but before its receipt settles the write from the Provider, never as completed-empty', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-20T12:00:00.000Z') });
  const h = harness(t);
  await h.app.judgment.review(reviewInput);
  const { workPackage } = await h.work('claim', { taskContextToken: 'token-a' });
  // The Provider records the decision; the process dies before the reply.
  const write = h.app.recordKnowledgeReviewProgress;
  let landed;
  const written = new Promise(resolve => { landed = resolve; });
  h.app.recordKnowledgeReviewProgress = async input => { await write(input); landed(); return new Promise(() => {}); };
  void submitAgain(h, 'token-a', workPackage);
  await written;
  h.app.recordKnowledgeReviewProgress = write;
  h.restart();
  h.clock.at += 11 * 60_000;
  t.mock.timers.tick(11 * 60_000);
  // The Provider no longer offers the recorded item. While it cannot say what
  // it holds, the result is unknown: the answer is kept, nothing is completed.
  const lookup = h.app.readKnowledgeReviewDecision;
  h.app.readKnowledgeReviewDecision = async () => { throw Object.assign(new Error('Provider unavailable'), { status: 503 }); };
  await assert.rejects(submitAgain(h, 'token-a', workPackage), { code: 'judgment_result_unknown' });
  assert.deepEqual(h.app.roleWork.summary().packages, [{ role: 'tonborg', status: 'submitted', count: 1 }]);
  h.app.readKnowledgeReviewDecision = lookup;
  const done = await submitAgain(h, 'token-a', workPackage);
  assert.equal(done.status, 'completed');
  const [record] = done.result.records;
  assert.equal(record.target, 'entity:one');
  assert.equal(record.execution.status, 'applied');
  assert.equal(record.execution.receipt.recovered, true);
  assert.equal(h.app.judgment.store().get('s', record.id).execution.status, 'applied');
  assert.equal(h.writes.length, 1);
  assert.deepEqual(await submitAgain(h, 'token-a', workPackage), { status: 'completed', replayed: true, result: done.result });
});

test('C11: a slow execution that lost the package to a takeover cannot contradict the applied result', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-20T12:00:00.000Z') });
  const h = harness(t);
  await h.app.judgment.review(reviewInput);
  const { workPackage } = await h.work('claim', { taskContextToken: 'token-a' });
  // As the real Provider does, a write to a completed review run is not found.
  const finish = h.app.finishKnowledgeReview, write = h.app.recordKnowledgeReviewProgress;
  let completedRun = false;
  h.app.finishKnowledgeReview = async input => { completedRun = true; return finish(input); };
  h.app.recordKnowledgeReviewProgress = async input => {
    if (completedRun) throw Object.assign(new Error('active knowledge review not found'), { status: 404 });
    return write(input);
  };
  // The first execution passes every pre-write check, then stalls before the write.
  const hold = holdCall(h.app, 'recordKnowledgeReviewProgress');
  const slow = submitAgain(h, 'token-a', workPackage);
  await hold.arrived;
  // Both leases pass while it is slow, not dead: a retry takes over and completes.
  h.clock.at += 11 * 60_000;
  t.mock.timers.tick(11 * 60_000);
  const done = await submitAgain(h, 'token-a', workPackage);
  assert.equal(done.status, 'completed');
  const [record] = done.result.records;
  assert.equal(record.execution.status, 'applied');
  assert.equal(h.writes.length, 1);
  // The slow execution resumes and fails at the Provider; it records nothing.
  hold.release();
  assert.deepEqual(await slow, { status: 'completed', replayed: true, result: done.result });
  const stored = h.app.judgment.store().get('s', record.id);
  assert.equal(stored.execution.status, 'applied');
  assert.deepEqual(stored.executionHistory.map(entry => entry.status), ['applying', 'not_applied', 'applying', 'applied']);
  assert.equal(h.app.judgment.store().records('s', { personalProjectId: 'p' }).filter(item => item.outcome === 'failed').length, 0);
  assert.deepEqual(await submitAgain(h, 'token-a', workPackage), { status: 'completed', replayed: true, result: done.result });
});

test('C16: a successor session gets its own package for the same evidence; the earlier one is superseded', async t => {
  const h = harness(t, { roles: { tonborg: tonborg() }, replies: () => new Response('{"error":{"message":"busy"}}', { status: 503 }) });
  const input = { personalSpaceId: 's', personalProjectId: 'p', requestId: 'accept-a', taskId: 't', taskContextToken: 'token-a',
    artifactRevision: 'artifact-a', expectedRevision: 2, sourceApplication: 'claude_code' };
  const first = await h.app.judgment.accept(input);
  assert.equal(first.workPackage.sessionRef, 'session-a');
  // Session A goes away; session B, the same lead, asks again on the same evidence.
  const second = await h.app.judgment.accept({ ...input, requestId: 'accept-b', taskContextToken: 'token-b', sourceApplication: 'codex' });
  assert.equal(second.outcome, 'pending');
  assert.equal(second.workPackage.sessionRef, 'session-b');
  assert.notEqual(second.workPackage.packageId, first.workPackage.packageId);
  // Only one answer to this evidence can be used: A's package is closed.
  await assert.rejects(h.work('claim', { taskContextToken: 'token-a', packageId: first.workPackage.packageId }), { code: 'role_work_closed' });
  assert.deepEqual(await h.work('claim', { taskContextToken: 'token-a' }), { workPackage: null });
  const { workPackage, result } = await claimAndSubmit(h, 'token-b', { outcome: 'approve', summary: 'Verified', evidence: ['report'], confidence: 0.97 }, ['gate']);
  assert.equal(workPackage.packageId, second.workPackage.packageId);
  assert.equal(result.status, 'completed');
  assert.equal(result.result.outcome, 'escalate');
  assert.equal(result.result.sessionId, 'session-b');
  assert.equal(h.completions.length, 0);
  assert.deepEqual(h.app.roleWork.summary().packages, [{ role: 'tonborg', status: 'completed', count: 1 }, { role: 'tonborg', status: 'stale', count: 1 }]);
});

test('T5: evidence that changes before the session answers makes the answer stale; history stays', async t => {
  const h = harness(t);
  const [pending] = (await h.app.judgment.review(reviewInput)).records;
  const { workPackage } = await h.work('claim', { taskContextToken: 'token-a' });
  h.candidates[0].content = 'npm run test:node';
  const result = await h.work('submit', { taskContextToken: 'token-a', packageId: workPackage.packageId,
    leaseToken: workPackage.lease.token, answer: answer({ decisions: [verdict()] }) });
  assert.equal(result.status, 'stale');
  assert.equal(h.writes.length, 0);
  // The rerun handed the changed evidence off again as new work.
  assert.notEqual(result.result.records[0].workPackage.packageId, workPackage.packageId);
  assert.equal(h.app.judgment.store().get('s', pending.id).outcome, 'pending');
});

test('D-04 §6: the CLI runs only on an explicit legacy_cli opt-in; old policies never re-enable it', async t => {
  const legacy = harness(t, { policy: { backend: 'legacy_cli' } });
  const [record] = (await legacy.app.judgment.review(reviewInput)).records;
  assert.equal(legacy.legacyRuns.length, 1);
  assert.deepEqual(record.judgedBy, { mode: 'legacy_cli', independent: true });
  assert.equal(record.client, 'codex');
  const migrated = harness(t);
  assert.equal((await migrated.app.judgment.review(reviewInput)).records[0].outcome, 'pending');
  assert.equal(migrated.legacyRuns.length, 0);
});
