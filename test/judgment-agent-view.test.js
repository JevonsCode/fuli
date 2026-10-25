import test from 'node:test';
import assert from 'node:assert/strict';
import { createJudgmentService } from '../src/judgment/service.js';
import { createJudgmentEngine } from '../src/judgment/engine.js';
import { dispatchGraphTool } from '../src/agent-tools/graph-handlers.js';
import { checkpointHumanInteraction } from '../src/graphiti/checkpoint-human-interaction.js';
import { completePreferences } from './fixtures/collaboration-preferences.js';
import { MODEL_ANSWER, trustedTonborg } from './fixtures/model-trust.js';
import { createModelBackendPort } from '../src/model-backends/port.js';
import { createRoleWorkBridge } from '../src/model-backends/role-work.js';
import { RoleWorkStore } from '../src/model-backends/role-work-store.js';
import { ModelUsageLedger } from '../src/model-backends/usage-ledger.js';

// rec#50: Tonborg's local records as an Agent reads them. A review recorded
// while its item was plain keeps its decision for every reader, but its words
// never reach an Agent, and its target and title only while the reader may
// see the item now. Synthetic data only; the Provider is a fake that applies
// the FLA rule to a synthetic item table.

const SPACE = 's';
const PROJECT = 'p';
const SUMMARY = 'Synthetic reason that quotes a scoped preference';
const EVIDENCE = 'Synthetic evidence from Tonborg memory';
const FEEDBACK = 'Synthetic feedback reason';

function provider(items) {
  const calls = [];
  const state = { available: true };
  return { calls, state, readVisibleKnowledgeItems: async body => {
    calls.push(body);
    if (!state.available) throw Object.assign(new Error('synthetic Provider offline'), { status: 503 });
    return { items: body.items.filter(({ item_kind: kind, item_id: id }) => {
      const item = items[`${kind}:${id}`];
      return item && (!item.agentId
        || (item.agentId === body.reader_agent_id && item.projectId === body.reader_project_id));
    }) };
  } };
}

// A manual-mode review: the model's approval stays an AI suggestion the person decides.
async function reviewed(t) {
  const items = { 'entity:one': {}, 'entity:two': {} };
  const candidates = [
    { candidate_key: 'entity:one', title: 'Synthetic preference', content: 'Synthetic content', confirmation_status: 'confirmed',
      changed_at: '2026-01-01', reasons: [], project_ids: [PROJECT] },
    { candidate_key: 'entity:two', title: 'Synthetic plain fact', content: 'Synthetic content', confirmation_status: 'confirmed',
      changed_at: '2026-01-01', reasons: [], project_ids: [PROJECT] }];
  const personal = provider(items);
  const app = { config: { personal: { spaceId: SPACE } }, getCapturePolicy: () => ({ enabled: true }),
    listPersonalProjects: async () => [{ project_id: PROJECT }],
    listProjectAgents: async () => [{ agentId: 'employee.tonborg', profile: { status: 'active', allowedClients: ['codex'], capabilities: ['fuli.employee:tonborg'] } }],
    getCollaborationPreferences: async () => completePreferences(),
    inspectProjectAgentMemory: async () => ({ current: null, revision: 0 }),
    employees: { authorize: async () => ({}) }, personal,
    startKnowledgeReview: async () => ({ review_id: 'review' }), finishKnowledgeReview: async () => ({}),
    listKnowledgeReviewCandidates: async () => ({ candidates, total_candidate_count: candidates.length }),
    recordKnowledgeReviewProgress: async () => assert.fail('a manual review writes nothing') };
  const judge = async () => ({ body: JSON.stringify({ decisions: candidates.map(candidate => ({ target: candidate.candidate_key,
    outcome: 'approve', summary: SUMMARY, evidence: [EVIDENCE], confidence: 0.95 })) }), client: 'codex', ...MODEL_ANSWER });
  const service = createJudgmentService({ app, engine: createJudgmentEngine({ app, judge, trust: trustedTonborg() }) });
  service.store().setPolicy(SPACE, '', { mode: 'manual', quality: 'quality', client: 'codex' }, 0);
  app.judgment = service;
  t.after(() => service.close());
  const review = await service.review({ personalSpaceId: SPACE, personalProjectId: PROJECT, requestId: 'synthetic-review' });
  const [one, two] = review.records;
  service.feedback({ personalSpaceId: SPACE, decisionId: one.id, vote: 'down', reason: FEEDBACK, expectedRevision: 0 });
  personal.calls.length = 0;
  return { app, service, personal, items, one, two,
    list: reader => dispatchGraphTool(app, 'list_judgments', { personalSpaceId: SPACE, personalProjectId: PROJECT, ...reader }) };
}

const byId = (result, record) => result.records.find(item => item.id === record.id);
const FLA_A = { projectAgentId: 'fla-a' };
const FLA_B = { projectAgentId: 'fla-b' };

function assertNoWords(shown) {
  const text = JSON.stringify(shown);
  for (const words of [SUMMARY, EVIDENCE, FEEDBACK]) assert.ok(!text.includes(words), words);
}

function assertDecisionKept(shown, record) {
  assert.equal(shown.id, record.id);
  assert.equal(shown.kind, 'review');
  assert.equal(shown.outcome, 'approve');
  assert.equal(shown.confidence, 0.95);
  assert.deepEqual(shown.aiReview, record.aiReview);
  assert.equal(shown.execution.status, 'not_applied');
  assert.equal(shown.createdAt, record.createdAt);
  assert.ok(shown.content_withheld.includes('summary') && shown.content_withheld.includes('evidence'));
}

test('a review of an item later made private to FLA-A shows FLA-B and a plain session its decision only', async t => {
  const f = await reviewed(t);
  f.items['entity:one'] = { agentId: 'fla-a', projectId: PROJECT };
  for (const reader of [FLA_B, {}]) {
    const result = await f.list(reader);
    const shown = byId(result, f.one);
    assertDecisionKept(shown, f.one);
    assert.equal(shown.target, undefined);
    assert.equal(shown.title, undefined);
    assert.equal(shown.target_withheld, 'not_visible');
    for (const field of ['evidence', 'feedback.reason', 'feedbackHistory.reason', 'summary', 'target', 'title']) {
      assert.ok(shown.content_withheld.includes(field), field);
    }
    assert.equal(shown.feedback.vote, 'down');
    assertNoWords(result);
    assert.ok(!JSON.stringify(result).includes('Synthetic preference'), 'not its title either');
    // The question goes to a reader who may see the other item, never about this one.
    assert.equal(result.human_interaction.source.id, f.two.id);
  }
  // One batched read per call, as the reader named itself.
  assert.equal(f.personal.calls.length, 2);
  assert.deepEqual(f.personal.calls[0], { personal_space_id: SPACE, reader_project_id: PROJECT, reader_agent_id: 'fla-b',
    items: [{ item_kind: 'entity', item_id: 'two' }, { item_kind: 'entity', item_id: 'one' }] });
  assert.deepEqual(Object.keys(f.personal.calls[1]).sort(), ['items', 'personal_space_id']);
});

test('FLA-A still sees its own item named, without the words', async t => {
  const f = await reviewed(t);
  f.items['entity:one'] = { agentId: 'fla-a', projectId: PROJECT };
  const result = await f.list(FLA_A);
  const shown = byId(result, f.one);
  assertDecisionKept(shown, f.one);
  assert.equal(shown.target, 'entity:one');
  assert.equal(shown.title, 'Synthetic preference');
  assert.equal(shown.target_withheld, undefined);
  assertNoWords(result);
  // The person is still asked in the conversation; the reason is read in the console.
  const question = result.human_interaction;
  assert.ok([f.one.id, f.two.id].includes(question.source.id));
  assert.match(question.question, /^AI 建议，待你确认 \/ AI suggestion, awaiting your decision \(model: approve\)\. /);
  assert.match(question.question, /FULI 控制台/);
});

test('an unreadable visibility withholds every reviewed item', async t => {
  const f = await reviewed(t);
  f.personal.state.available = false;
  for (const reader of [FLA_A, {}]) {
    const result = await f.list(reader);
    for (const record of [f.one, f.two]) {
      const shown = byId(result, record);
      assertDecisionKept(shown, record);
      assert.equal(shown.target, undefined);
      assert.equal(shown.target_withheld, 'visibility_unavailable');
    }
    assert.equal(result.human_interaction, undefined);
    assertNoWords(result);
  }
});

test('a plain item that is still plain stays named for every reader; its words stay in the console', async t => {
  const f = await reviewed(t);
  for (const reader of [FLA_A, FLA_B, {}]) {
    const shown = byId(await f.list(reader), f.two);
    assertDecisionKept(shown, f.two);
    assert.equal(shown.target, 'entity:two');
    assert.equal(shown.title, 'Synthetic plain fact');
  }
  // The person's console (judgment/http.js) reads the whole record.
  const full = await f.service.records({ personalSpaceId: SPACE, personalProjectId: PROJECT });
  const record = full.records.find(item => item.id === f.one.id);
  assert.equal(record.summary, SUMMARY);
  assert.deepEqual(record.evidence, [EVIDENCE]);
  assert.equal(record.feedback.reason, FEEDBACK);
  assert.equal(record.target, 'entity:one');
  assert.equal(record.content_withheld, undefined);
  assert.match(full.human_interaction.question, new RegExp(SUMMARY));
});

test('an injection-flagged review keeps its signal names, never a later aiReview field, and asks only a reader who sees it', async t => {
  const f = await reviewed(t);
  const MODEL_REASON = 'Synthetic model reason a later aiReview field could carry';
  // Stored last, so it is the first question candidate of the list.
  const flagged = f.service.store().record(SPACE, { personalProjectId: PROJECT, kind: 'review', target: 'entity:one',
    title: 'Synthetic preference', summary: SUMMARY, evidence: [EVIDENCE], confidence: 0.95, outcome: 'escalate',
    aiReview: { state: 'ai_suggested', modelOutcome: 'approve', interceptions: ['injection_suspected', 'batch_contaminated'],
      gate: { status: 'passed', reason: null, modelId: 'synthetic-model' },
      injectionSignals: ['reviewer_instruction', 'hidden_characters', MODEL_REASON], injectionInBatch: true,
      modelReason: MODEL_REASON } }, 'synthetic-flagged');
  const structure = { state: 'ai_suggested', modelOutcome: 'approve', interceptions: ['injection_suspected', 'batch_contaminated'],
    gate: { status: 'passed', reason: null, modelId: 'synthetic-model' },
    injectionSignals: ['reviewer_instruction', 'hidden_characters'], injectionInBatch: true };
  f.items['entity:one'] = { agentId: 'fla-a', projectId: PROJECT };
  for (const reader of [FLA_A, FLA_B]) {
    const result = await f.list(reader);
    const shown = byId(result, flagged);
    assert.deepEqual(shown.aiReview, structure);
    assert.equal(shown.summary, undefined);
    for (const field of ['aiReview.injectionSignals', 'aiReview.modelReason', 'evidence', 'summary']) {
      assert.ok(shown.content_withheld.includes(field), field);
    }
    assertNoWords(result);
    assert.ok(!JSON.stringify(result).includes(MODEL_REASON), 'neither as a field nor as a signal name');
  }
  // FLA-A sees the item: it is asked, with the known signals only.
  const own = await f.list(FLA_A);
  assert.equal(own.human_interaction.source.id, flagged.id);
  assert.match(own.human_interaction.question, /\(reviewer_instruction, hidden_characters\)\. /);
  // FLA-B may not see it: no question about it, and its target stays out.
  const other = await f.list(FLA_B);
  const hidden = byId(other, flagged);
  assert.equal(hidden.target, undefined);
  assert.equal(hidden.target_withheld, 'not_visible');
  assert.ok(hidden.content_withheld.includes('target') && hidden.content_withheld.includes('title'));
  assert.notEqual(other.human_interaction.source.id, flagged.id);
  assert.equal(other.human_interaction.source.id, f.two.id);
});

test('fields named like Object.prototype members are withheld at every level, and the view pollutes no prototype', async t => {
  const f = await reviewed(t);
  const PROTO_TEXT = 'Synthetic text under a prototype-named key';
  // JSON.parse keeps __proto__ as an own key, as a stored record's body does.
  const named = `"constructor":"${PROTO_TEXT}","toString":"${PROTO_TEXT}","__proto__":{"polluted":"${PROTO_TEXT}"}`;
  const body = JSON.parse(`{"personalProjectId":"${PROJECT}","kind":"review","target":"entity:two","title":"Synthetic plain fact",
    "outcome":"escalate","confidence":0.5,
    "aiReview":{"state":"ai_suggested","modelOutcome":"escalate","interceptions":[],${named}},
    "preferenceDelivery":{"version":1,"status":"delivered",${named}},${named}}`);
  assert.ok(Object.hasOwn(body, '__proto__') && Object.hasOwn(body.aiReview, '__proto__'), 'the fixture has own __proto__ keys');
  const record = f.service.store().record(SPACE, body, 'synthetic-prototype-names');
  // A kind named like a prototype member names no plain target either.
  const kinds = ['constructor', 'toString'].map(kind => f.service.store().record(SPACE, { personalProjectId: PROJECT, kind,
    target: PROTO_TEXT, outcome: 'recommend' }, `synthetic-kind-${kind}`));

  const result = await f.list({});
  const shown = byId(result, record);
  assert.deepEqual(shown.aiReview, { state: 'ai_suggested', modelOutcome: 'escalate', interceptions: [] });
  assert.deepEqual(shown.preferenceDelivery, { version: 1, status: 'delivered' });
  for (const prefix of ['', 'aiReview.', 'preferenceDelivery.']) {
    for (const key of ['__proto__', 'constructor', 'toString']) {
      assert.ok(shown.content_withheld.includes(`${prefix}${key}`), `${prefix}${key}`);
    }
  }
  for (const value of [shown, shown.aiReview, shown.preferenceDelivery]) {
    assert.equal(Object.getPrototypeOf(value), Object.prototype);
    for (const key of ['__proto__', 'constructor', 'toString']) assert.ok(!Object.hasOwn(value, key), key);
  }
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(shown.target, 'entity:two');
  for (const kindRecord of kinds) {
    const kindShown = byId(result, kindRecord);
    assert.equal(kindShown.target, undefined);
    assert.equal(kindShown.target_withheld, 'not_visible');
    assert.deepEqual(kindShown.content_withheld, ['target']);
  }
  assert.ok(!JSON.stringify(result).includes(PROTO_TEXT));
});

test('a list or map rule never keeps a bare value in place of its object', async t => {
  const f = await reviewed(t);
  const record = f.service.store().record(SPACE, { personalProjectId: PROJECT, kind: 'review', target: 'entity:two',
    outcome: 'escalate', aiReview: 'Synthetic free text where aiReview\'s object belongs',
    preferenceDelivery: 'Synthetic free text where the delivery receipt belongs' }, 'synthetic-bare-values');
  const shown = byId(await f.list({}), record);
  assert.equal(shown.aiReview, undefined);
  assert.equal(shown.preferenceDelivery, undefined);
  assert.ok(shown.content_withheld.includes('aiReview') && shown.content_withheld.includes('preferenceDelivery'));
});

test('an FLA reader names one project, and the Provider decides whether it is that project\'s FLA', async t => {
  const f = await reviewed(t);
  await assert.rejects(dispatchGraphTool(f.app, 'list_judgments', { personalSpaceId: SPACE, projectAgentId: 'fla-a' }), TypeError);
  assert.equal(f.personal.calls.length, 0);
});

test('Tonborg\'s other Agent answers carry decisions without words', async t => {
  const f = await reviewed(t);
  f.items['entity:one'] = { agentId: 'fla-a', projectId: PROJECT };
  // review_with_tonborg replays the stored review as a plain session reads it.
  const replay = await dispatchGraphTool(f.app, 'review_with_tonborg', { personalSpaceId: SPACE, personalProjectId: PROJECT,
    requestId: 'synthetic-review' });
  assert.equal(byId(replay, f.one).target_withheld, 'not_visible');
  assert.equal(byId(replay, f.two).target, 'entity:two');
  assert.deepEqual(replay.recordIds, [f.one.id, f.two.id]);
  assertNoWords(replay);
  assert.doesNotMatch(replay.human_interaction.question, new RegExp(SUMMARY));

  // A routing answer keeps what the Agent acts on.
  const routing = f.service.store().record(SPACE, { personalProjectId: PROJECT, kind: 'routing', target: 'subagent',
    summary: SUMMARY, evidence: [EVIDENCE], outcome: 'recommend', disposition: 'delegate', conversationId: null,
    workKind: 'implementation', objective: 'Synthetic private objective', agentId: 'fla-a',
    selection: { executorId: 'executor', model: 'model', client: 'codex' }, executionRequired: true, guidance: 'Synthetic host guidance' }, 'routing');
  f.service.assess = async () => routing;
  const assessed = await f.service.agent.assess({ personalSpaceId: SPACE });
  assert.deepEqual({ target: assessed.target, disposition: assessed.disposition, selection: assessed.selection,
    executionRequired: assessed.executionRequired, guidance: assessed.guidance },
  { target: 'subagent', disposition: 'delegate', selection: routing.selection, executionRequired: true, guidance: 'Synthetic host guidance' });
  assert.deepEqual(assessed.content_withheld, ['evidence', 'objective', 'summary']);
  // An acceptance names its task, not its title.
  const acceptance = f.service.store().record(SPACE, { personalProjectId: PROJECT, kind: 'acceptance', target: 'task-1',
    title: 'Synthetic task title', summary: SUMMARY, evidence: [EVIDENCE], outcome: 'escalate', confidence: 0,
    verification: { attempt_id: 'attempt-1', outcome: 'pass', evidence_refs: ['Synthetic evidence ref'] } }, 'acceptance');
  f.service.accept = async () => acceptance;
  const accepted = await f.service.agent.accept({ personalSpaceId: SPACE });
  assert.equal(accepted.target, 'task-1');
  assert.deepEqual(accepted.verification, { attempt_id: 'attempt-1', outcome: 'pass' });
  assert.deepEqual(accepted.content_withheld, ['evidence', 'summary', 'title', 'verification.evidence_refs']);
  assert.equal(f.personal.calls.length, 1, 'routing and acceptance name no knowledge to look up');
});

test('a checkpoint\'s question reads as its task\'s reader', async t => {
  const f = await reviewed(t);
  f.items['entity:one'] = { agentId: 'fla-a', projectId: PROJECT };
  f.items['entity:two'] = { agentId: 'fla-a', projectId: PROJECT };
  const app = { config: f.app.config, judgment: f.service, listAgentAttention: async () => ({}) };
  const own = await checkpointHumanInteraction(app, { personalProjectId: PROJECT, projectAgentId: 'fla-a' });
  assert.ok([f.one.id, f.two.id].includes(own.human_interaction.source.id));
  assert.equal(f.personal.calls.at(-1).reader_agent_id, 'fla-a');
  assertNoWords(own);
  const other = await checkpointHumanInteraction(app, { personalProjectId: PROJECT, projectAgentId: 'fla-b' });
  assert.deepEqual(other, {}, 'no question about another FLA\'s items');
});

// A Tonborg work package answered by a session, through the real bridge and
// its tonborg view (judgment/runtime.js wires the same two). The resumed
// operation returns the full stored records; the bridge keeps them as they are.
function tonborgWork(t, f, session) {
  const at = new Date('2026-10-25T00:00:00.000Z');
  const port = createModelBackendPort({ readConfig: () => ({ state: 'absent' }), secrets: { read: async () => null },
    ledger: new ModelUsageLedger(), now: () => at, fetchImpl: async () => assert.fail('no model call') });
  const request = { role: 'tonborg', operation: 'knowledge_review', requestId: 'synthetic-work',
    scope: { personalSpaceId: SPACE, personalProjectId: PROJECT, sessionRef: null },
    versions: { evidence: 'evidence-1', policy: 'policy-1' }, instructions: 'Synthetic review instructions.',
    evidence: [{ id: 'candidate', personalProjectId: PROJECT, text: 'Synthetic candidate.' }],
    output: { type: 'choice', options: [{ id: 'approve', description: 'Approve' }, { id: 'escalate', description: 'Escalate' }] } };
  const store = new RoleWorkStore();
  let resumes = 0;
  const bridge = createRoleWorkBridge({ port, store, now: () => at, verifySession: async () => session,
    resumers: { tonborg: async ({ execution }) => {
      resumes++;
      await bridge.decide(request, { execution });
      return f.service.records({ personalSpaceId: SPACE, personalProjectId: PROJECT });
    } },
    views: { tonborg: (result, caller) => f.service.agent.workResult(result, caller) } });
  t.after(() => bridge.close());
  return { store, resumes: () => resumes, async answered() {
    await bridge.decide(request, { resume: { personalSpaceId: SPACE } });
    const { workPackage } = await bridge.claim({ taskContextToken: 'synthetic-task' });
    const submit = () => bridge.submit({ taskContextToken: 'synthetic-task', packageId: workPackage.packageId,
      leaseToken: workPackage.lease.token, answer: { decision: 'propose', payload: { choice: 'approve' },
        reason: 'Synthetic.', evidenceIds: ['candidate'], uncertainty: null } });
    return { workPackage, submit };
  } };
}

const SESSION = { sessionRef: 'synthetic-session', personalSpaceId: SPACE, personalProjectId: PROJECT,
  projectAgentId: null, sourceApplication: 'codex' };

test('role_work keeps the full result but every reply, a cached replay too, shows it as the session may read it now', async t => {
  const f = await reviewed(t);
  const w = tonborgWork(t, f, SESSION);
  const { workPackage, submit } = await w.answered();
  const first = await submit();
  assert.equal(first.status, 'completed');
  // Visible the first time: both items named, no words.
  assert.deepEqual(first.result.records.map(record => record.target).sort(), ['entity:one', 'entity:two']);
  assertNoWords(first);
  // The stored result is the role's full history, as an old raw package's is.
  const stored = w.store.get(workPackage.packageId).result;
  assert.equal(stored.records.find(record => record.id === f.one.id).summary, SUMMARY);

  // The item becomes FLA-A's; a retry with the same session and lease replays the cache.
  f.items['entity:one'] = { agentId: 'fla-a', projectId: PROJECT };
  const replay = await submit();
  assert.equal(replay.replayed, true);
  assert.equal(w.resumes(), 1, 'the replay reran nothing');
  const one = byId(replay.result, f.one);
  assert.equal(one.target, undefined);
  assert.equal(one.title, undefined);
  assert.equal(one.target_withheld, 'not_visible');
  assert.equal(byId(replay.result, f.two).target, 'entity:two');
  assertNoWords(replay);
  assert.ok(!JSON.stringify(replay).includes('Synthetic preference'));

  // The Provider is unavailable on a later retry: every reviewed item fails closed.
  f.personal.state.available = false;
  const offline = await submit();
  assert.ok(offline.result.records.every(record => record.target_withheld === 'visibility_unavailable'));
  assertNoWords(offline);
});

test('role_work shows FLA-A its own item on a replay, as its task names it', async t => {
  const f = await reviewed(t);
  const w = tonborgWork(t, f, { ...SESSION, projectAgentId: 'fla-a' });
  const { submit } = await w.answered();
  await submit();
  f.items['entity:one'] = { agentId: 'fla-a', projectId: PROJECT };
  const replay = await submit();
  assert.equal(byId(replay.result, f.one).target, 'entity:one');
  assert.equal(f.personal.calls.at(-1).reader_agent_id, 'fla-a');
  assertNoWords(replay);
});
