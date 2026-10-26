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
import { tonborgSessionEvidence } from '../src/judgment/session-package.js';
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
  'token-q': { sessionId: 'session-q', personalProjectId: 'q', projectAgentId: 'lead', sourceApplication: 'codex' },
  // rec#11 D-58: a plain session and two FLAs of the project claim Tonborg's work.
  'token-plain': { sessionId: 'session-plain', personalProjectId: 'p', projectAgentId: null, sourceApplication: 'codex' },
  'token-fla-a': { sessionId: 'session-fla-a', personalProjectId: 'p', projectAgentId: 'fla-a', sourceApplication: 'codex' },
  'token-fla-b': { sessionId: 'session-fla-b', personalProjectId: 'p', projectAgentId: 'fla-b', sourceApplication: 'codex' }
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
  const visibility = { private: new Map(), offline: false };
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
    // rec#50: the Provider's visible-items read over a synthetic table. An
    // item in visibility.private is that FLA's (in project p); offline fails.
    personal: { readVisibleKnowledgeItems: async body => {
      if (visibility.offline) throw Object.assign(new Error('synthetic Provider offline'), { status: 503 });
      return { items: body.items.filter(({ item_kind: kind, item_id: id }) => {
        const owner = visibility.private.get(`${kind}:${id}`);
        return !owner || (owner === body.reader_agent_id && body.reader_project_id === 'p');
      }) };
    } },
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
      views: { tonborg: (result, session) => app.judgment.agent.workResult(result, session) },
      packageViews: { tonborg: (evidence, work, session) => tonborgSessionEvidence(app, evidence, work, session) }, now });
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
  return { app, config, calls, writes, legacyRuns, completions, candidates, task, ledger, clock, work, visibility,
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

// rec#11 D-58: Tonborg's history, memory and its own preferences, which a
// session answering for Tonborg must not receive. entity:secret was reviewed
// before and is FLA-A's now.
const SECRET = { summary: 'Synthetic summary quoting FLA-A private words', feedback: 'Synthetic feedback about the secret',
  memory: 'Synthetic Tonborg memory naming entity:secret', rule: 'Synthetic rule given to Tonborg only', title: 'Synthetic secret title' };

function withHistory(h) {
  const store = h.app.judgment.store();
  const old = store.record('s', { personalProjectId: 'p', kind: 'review', target: 'entity:secret', title: SECRET.title,
    summary: SECRET.summary, evidence: [SECRET.summary], outcome: 'escalate' }, 'synthetic-old-review');
  store.feedback('s', old.id, 'down', SECRET.feedback, 0);
  h.visibility.private.set('entity:secret', 'fla-a');
  h.app.inspectProjectAgentMemory = async () => ({ current: { memory: SECRET.memory }, revision: 3 });
  // The preference delivery as the Provider gives it to each reader: a rule
  // with an owner is that FLA's (scope agent) and reaches it alone.
  // extra: more of the Provider's answer (a cut source window, scope_unknown keys).
  h.preferences = { failing: false, extra: {}, rules: [
    { key: 'shared-rule', instruction: SHARED_RULE, owner: null },
    { key: 'other-shared-rule', instruction: OTHER_SHARED_RULE, owner: null },
    { key: 'tonborg-rule', instruction: SECRET.rule, owner: 'employee.tonborg' }] };
  h.app.getCollaborationPreferences = async ({ projectAgentId = null }) => {
    if (h.preferences.failing) throw Object.assign(new Error('synthetic preference read failed'), { code: 'synthetic_unavailable' });
    return completePreferences({ effective: h.preferences.rules.filter(({ owner }) => !owner || owner === projectAgentId)
      .map(({ key, instruction, owner }) => ({ id: key, item_kind: 'entity', preference_key: key, title: key, instruction,
        preference_scope: owner ? 'agent' : 'global', confirmation_status: 'confirmed' })), ...h.preferences.extra });
  };
  return h;
}
const SHARED_RULE = 'Synthetic rule for everyone';
const OTHER_SHARED_RULE = 'Synthetic second rule for everyone';
const preferencesOf = workPackage => JSON.parse(workPackage.evidence.find(item => item.id === 'preferences').text);
// A shared rule the person gives FLA-A after the package was made.
const makeOwn = (h, key, owner) => { h.preferences.rules.find(item => item.key === key).owner = owner; };

const leaks = value => Object.values(SECRET).filter(text => JSON.stringify(value).includes(text))
  .concat(JSON.stringify(value).includes('entity:secret') ? ['entity:secret'] : []);

test('D-58: a session claiming Tonborg\'s review gets the candidate, shared rules and criteria, never Tonborg\'s memory or history', async t => {
  for (const token of ['token-plain', 'token-fla-b']) {
    const h = withHistory(harness(t));
    const [pending] = (await h.app.judgment.review(reviewInput)).records;
    assert.equal(pending.outcome, 'pending');
    const { workPackage, result } = await claimAndSubmit(h, token, { decisions: [verdict()] });
    assert.deepEqual(leaks(workPackage), [], token);
    assert.deepEqual(workPackage.evidence.map(item => item.id).sort(), ['candidates', 'policy', 'preferences'], token);
    const candidates = JSON.parse(workPackage.evidence.find(item => item.id === 'candidates').text);
    assert.deepEqual(candidates.map(candidate => [candidate.candidate_key, candidate.title, candidate.content]),
      [['entity:one', 'Build command', 'npm test']]);
    const preferences = preferencesOf(workPackage);
    assert.deepEqual(preferences.selected.map(item => item.key), ['shared-rule', 'other-shared-rule']);
    // The receipt says a part was withheld, so its rules make the session escalate if it matters.
    assert.equal(preferences.status, 'partial');
    assert.equal(preferences.context_changed, true);
    assert.ok(preferences.omitted.truncated.includes('context_changed'));
    assert.match(workPackage.instructions, /Tonborg/);
    // The review still works with the minimal package.
    assert.equal(result.status, 'completed');
    const reviewed = result.result.records.find(record => record.target === 'entity:one');
    assert.equal(reviewed.kind, 'review');
    assert.equal(reviewed.aiReview.modelOutcome, 'approve');
    assert.deepEqual(leaks(result), [], token);
  }
});

test('D-58: a candidate the claiming session may not see now is not handed over; an unreadable visibility fails closed', async t => {
  const h = withHistory(harness(t));
  await h.app.judgment.review(reviewInput);
  h.visibility.private.set('entity:one', 'fla-a');
  for (const token of ['token-plain', 'token-fla-b']) {
    await assert.rejects(h.work('claim', { taskContextToken: token }), { code: 'role_work_not_visible', status: 403 });
  }
  h.visibility.offline = true;
  await assert.rejects(h.work('claim', { taskContextToken: 'token-fla-a' }), { code: 'role_work_visibility_unavailable', status: 503 });
  // A refused session held no lease: FLA-A, which may see its own item, claims it at once.
  h.visibility.offline = false;
  const { workPackage } = await h.work('claim', { taskContextToken: 'token-fla-a' });
  assert.equal(JSON.parse(workPackage.evidence.find(item => item.id === 'candidates').text)[0].candidate_key, 'entity:one');
  assert.deepEqual(leaks(workPackage).filter(text => text !== 'entity:secret'), []);
});

test('D-58: a stored rule reaches a claiming session only while that session may read the same rule now', async t => {
  // A global rule made FLA-A's after the package was made never reaches a plain session or FLA-B; a still-global one does.
  for (const token of ['token-plain', 'token-fla-b']) {
    const h = withHistory(harness(t));
    await h.app.judgment.review(reviewInput);
    makeOwn(h, 'shared-rule', 'fla-a');
    const { workPackage } = await h.work('claim', { taskContextToken: token });
    const preferences = preferencesOf(workPackage);
    assert.ok(!JSON.stringify(workPackage).includes(SHARED_RULE), token);
    assert.deepEqual(preferences.selected.map(item => [item.key, item.rule]), [['other-shared-rule', OTHER_SHARED_RULE]], token);
    assert.deepEqual([preferences.status, preferences.context_changed], ['partial', true]);
    assert.deepEqual(leaks(workPackage), [], token);
  }
  // FLA-A owns the rule now: its claim keeps the stored rule, still marked changed (its scope moved).
  const own = withHistory(harness(t));
  await own.app.judgment.review(reviewInput);
  makeOwn(own, 'shared-rule', 'fla-a');
  const preferences = preferencesOf((await own.work('claim', { taskContextToken: 'token-fla-a' })).workPackage);
  assert.deepEqual(preferences.selected.map(item => [item.key, item.scope, item.rule]),
    [['shared-rule', 'global', SHARED_RULE], ['other-shared-rule', 'global', OTHER_SHARED_RULE]]);
  assert.equal(preferences.context_changed, true);
  assert.ok(!JSON.stringify(preferences).includes(SECRET.rule), 'never Tonborg\'s own rule');
});

test('D-58: the same rules from a delivery now less complete, or with a new scope_unknown key, mark the context changed and name nothing new', async t => {
  // The FLA's claim reads the same two shared rules it is given now, and no Tonborg rule was stored for a global review.
  const claim = async (extra, check) => {
    const h = withHistory(harness(t));
    makeOwn(h, 'tonborg-rule', 'nobody');
    await h.app.judgment.review(reviewInput);
    const stored = preferencesOf((await h.work('claim', { taskContextToken: 'token-plain' })).workPackage);
    assert.deepEqual([stored.status, stored.context_changed], ['complete', undefined], 'unchanged before');
    const again = withHistory(harness(t));
    makeOwn(again, 'tonborg-rule', 'nobody');
    await again.app.judgment.review(reviewInput);
    again.preferences.extra = extra;
    const { workPackage } = await again.work('claim', { taskContextToken: 'token-plain' });
    const preferences = preferencesOf(workPackage);
    assert.deepEqual(preferences.selected.map(item => item.rule), [SHARED_RULE, OTHER_SHARED_RULE]);
    assert.deepEqual([preferences.status, preferences.context_changed], ['partial', true]);
    assert.deepEqual(preferences.omitted.truncated, ['context_changed']);
    check(workPackage, preferences);
  };
  // A source window cut since the package was made.
  await claim({ truncated: true, source_windows: { candidates_truncated: true, project_ancestors_truncated: false,
    queued_conflicts_truncated: false } }, () => {});
  // A rule limited to a task dimension appears: its key, and how many there are, stay out.
  await claim({ scope_unknown: ['synthetic-private-new-key'] }, (workPackage, preferences) => {
    assert.ok(!JSON.stringify(workPackage).includes('synthetic-private-new-key'));
    assert.deepEqual(preferences.scope_unknown, []);
  });
});

test('D-58: a preference delivery that cannot be read at claim time withholds every stored rule; the candidate is still reviewed', async t => {
  const h = withHistory(harness(t));
  await h.app.judgment.review(reviewInput);
  h.preferences.failing = true;
  const { workPackage } = await h.work('claim', { taskContextToken: 'token-plain' });
  const preferences = preferencesOf(workPackage);
  assert.deepEqual([preferences.selected, preferences.conflicts, preferences.scope_unknown], [[], [], []]);
  assert.deepEqual([preferences.status, preferences.context_changed], ['partial', true]);
  assert.ok(preferences.omitted.truncated.includes('context_changed'));
  for (const text of [SHARED_RULE, OTHER_SHARED_RULE, SECRET.rule]) assert.ok(!JSON.stringify(workPackage).includes(text), text);
  assert.equal(JSON.parse(workPackage.evidence.find(item => item.id === 'candidates').text)[0].candidate_key, 'entity:one');
  // The session answers from the candidate; the rerun reads Tonborg's own context again and uses it.
  h.preferences.failing = false;
  const result = await submitAgain(h, 'token-plain', workPackage);
  assert.equal(result.status, 'completed');
  assert.equal(result.result.records.find(record => record.target === 'entity:one').aiReview.modelOutcome, 'approve');
});

test('D-58: Tonborg\'s own model still judges with its full context', async t => {
  const h = withHistory(harness(t, { roles: { tonborg: tonborg() } }));
  const [record] = (await h.app.judgment.review(reviewInput)).records;
  assert.equal(record.judgedBy.mode, 'model_api');
  const sent = JSON.stringify(h.calls[0]);
  for (const text of [SECRET.memory, SECRET.summary, SECRET.rule]) assert.ok(sent.includes(text), text);
});
