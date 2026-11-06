import test from 'node:test';
import assert from 'node:assert/strict';

import { createJudgmentService } from '../src/judgment/service.js';
import { createJudgmentEngine } from '../src/judgment/engine.js';
import { agentJudgmentView } from '../src/judgment/agent-view.js';
import { delegatedReviewList, reviewDelegation, setReviewDelegation } from '../src/judgment/review-delegation.js';
import { undoAutomaticReview } from '../src/judgment/review-undo.js';
import { createRoleTrust } from '../src/model-backends/role-trust.js';
import { completePreferences } from './fixtures/collaboration-preferences.js';
import { MODEL_ANSWER, trustedTonborg } from './fixtures/model-trust.js';

// rec#96 「交给 Tonborg 确认」, on synthetic data only: Tonborg confirms the
// clear pending items as its own (agent_confirmed, never the person's) and
// asks about the rest in one batch, each as its best guess.

const pending = (key, title) => ({ candidate_key: key, title, content: title, confirmation_status: 'pending',
  changed_at: '2026-11-01', reasons: ['never_reviewed'], project_ids: ['p'] });

function fixture(t, { mode = 'manual', decisions, trust = trustedTonborg() } = {}) {
  const candidates = [pending('entity:keep', 'Use pnpm in this repo'), pending('entity:unsure', 'Deploy on Fridays')];
  const writes = [];
  const prompts = [];
  const app = { config: { personal: { spaceId: 's' } }, getCapturePolicy: () => ({ enabled: true }),
    listPersonalProjects: async () => [{ project_id: 'p' }],
    listProjectAgents: async () => [{ agentId: 'employee.tonborg', profile: { status: 'active', allowedClients: ['codex'],
      capabilities: ['fuli.employee:tonborg'] } }],
    getCollaborationPreferences: async () => completePreferences(),
    inspectProjectAgentMemory: async () => ({ current: null, revision: 0 }),
    employees: { authorize: async () => ({}) },
    personal: { readVisibleKnowledgeItems: async ({ items }) => ({ items }) },
    modelTrust: trust,
    startKnowledgeReview: async () => ({ review_id: 'review' }),
    finishKnowledgeReview: async () => ({}),
    listKnowledgeReviewCandidates: async () => ({ candidates, total_candidate_count: candidates.length }),
    recordKnowledgeReviewProgress: async input => {
      writes.push(input);
      candidates.splice(candidates.findIndex(c => c.candidate_key === input.candidateKey), 1);
      return { outcome: input.outcome };
    } };
  const judge = async call => {
    prompts.push(call);
    return { body: JSON.stringify({ decisions: decisions ?? [
      { target: 'entity:keep', outcome: 'approve', summary: 'Matches the confirmed tooling preference', evidence: ['pnpm-lock.yaml'],
        confidence: 0.95, guess: 'keep', question: 'I think you keep this: use pnpm. Right?' },
      { target: 'entity:unsure', outcome: 'escalate', summary: 'Conflicts with an earlier no-Friday-deploy vote', evidence: ['vote'],
        confidence: 0.6, guess: 'drop', question: 'I think you drop this: deploy on Fridays. Right?' }] }),
    client: 'codex', ...MODEL_ANSWER };
  };
  const service = createJudgmentService({ app, engine: createJudgmentEngine({ app, judge, trust }) });
  service.store().setPolicy('s', '', { mode, quality: 'quality', client: 'codex' }, 0);
  t.after(() => service.close());
  return { service, app, writes, prompts, candidates };
}
const input = { personalSpaceId: 's', personalProjectId: 'p', requestId: 'delegated-1', limit: 10 };
const turnOn = (f, revision = 0) => setReviewDelegation({ judgment: f.service, modelTrust: f.app.modelTrust,
  input: { personalSpaceId: 's', enabled: true, expectedRevision: revision } });

test('delegated: Tonborg confirms the clear item as its own and asks about the rest as its guess', async t => {
  const f = fixture(t);
  await turnOn(f);
  const result = await f.service.review(input);

  // The clear one: applied as Tonborg's agent confirmation, even under a 「我来确认」 policy.
  assert.equal(f.writes.length, 1);
  assert.deepEqual({ key: f.writes[0].candidateKey, outcome: f.writes[0].outcome, confirm: f.writes[0].confirmAsAgent },
    { key: 'entity:keep', outcome: 'ai_reviewed', confirm: true });
  const [kept, unsure] = result.records;
  assert.equal(kept.delegated, true);
  assert.equal(kept.execution.status, 'applied');
  assert.match(kept.summary, /confirmed tooling preference/);
  // The model was asked to decide as the person would and to guess the rest.
  assert.match(f.prompts[0].instructions, /decide each candidate the way this person would/);
  assert.deepEqual(f.prompts[0].schema.properties.decisions.items.required.slice(-2), ['guess', 'question']);

  // The unclear one waits as ONE batched question, phrased as Tonborg's guess.
  assert.equal(unsure.execution.status, 'not_applied');
  assert.equal(unsure.guess, 'drop');
  const hint = result.human_interaction;
  assert.equal(hint.presentation, 'host_native_single_choice');
  assert.deepEqual(hint.source.batch, [unsure.id]);
  assert.match(hint.question, /I think you drop this/);
  assert.match(hint.guidance, /do not confirm, drop or edit these knowledge items yourself/);
});

test('without delegation nothing becomes an agent confirmation and the manual policy still holds', async t => {
  const f = fixture(t);
  const result = await f.service.review(input);
  assert.equal(f.writes.length, 0);
  assert.equal(result.records[0].execution.status, 'not_applied');
  assert.equal(result.records[0].delegated, undefined);
  assert.doesNotMatch(f.prompts[0].instructions, /the way this person would/);
});

test('the list shows Tonborg\'s confirmations and questions until the person answers; votes and undo end them', async t => {
  const f = fixture(t);
  await turnOn(f);
  await f.service.review(input);
  const list = await delegatedReviewList({ judgment: f.service, input: { personalSpaceId: 's' } });
  assert.deepEqual(list.confirmed.map(entry => entry.target), ['entity:keep']);
  assert.deepEqual(list.questions.map(entry => [entry.target, entry.guess]), [['entity:unsure', 'drop']]);

  // The person answers Tonborg's guess (👍): it is no longer asked or listed.
  const question = list.questions[0];
  await f.service.feedback({ personalSpaceId: 's', decisionId: question.id, vote: 'up', reason: '', expectedRevision: 0 });
  const confirmed = list.confirmed[0];
  await f.service.feedback({ personalSpaceId: 's', decisionId: confirmed.id, vote: 'up', reason: '', expectedRevision: 0 });
  assert.deepEqual(await delegatedReviewList({ judgment: f.service, input: { personalSpaceId: 's' } }), { confirmed: [], questions: [] });
});

test('an Agent sees the batch without Tonborg\'s words, and only fixed guess values', async t => {
  const f = fixture(t);
  await turnOn(f);
  const result = await f.service.review(input);
  const view = await agentJudgmentView(f.app.personal, result, { personalSpaceId: 's' });
  const unsure = view.records.find(record => record.target === 'entity:unsure');
  assert.equal(unsure.guess, 'drop');
  assert.equal(unsure.delegated, true);
  assert.equal(unsure.question, undefined);
  assert.ok(unsure.content_withheld.includes('question'));
  assert.doesNotMatch(view.human_interaction.question, /Fridays/);
  assert.match(view.human_interaction.question, /FULI 待决策/);
});

test('the switch needs Tonborg\'s own model, then clears 「只给建议」 and acknowledges the warning in the same click', async t => {
  const none = fixture(t, { trust: createRoleTrust({ modelBackends: { allowsEgress: () => true, operationSettings: () => null } }) });
  assert.deepEqual((await reviewDelegation({ judgment: none.service, modelTrust: none.app.modelTrust, input: { personalSpaceId: 's' } })).model,
    { connected: false, status: 'suggestion', reason: 'not_configured' });
  await assert.rejects(turnOn(none), error => error.code === 'tonborg_model_required');
  assert.equal(none.service.store().delegation('s').enabled, false);

  const trust = createRoleTrust({ modelBackends: { allowsEgress: () => true, operationSettings: () =>
    ({ connection: { model: 'fixture-model', identity: 'fixture-connection-identity' } }) } });
  trust.setSuggestionsOnly('tonborg', true, 0);
  const f = fixture(t, { trust });
  const saved = await turnOn(f);
  assert.equal(saved.enabled, true);
  assert.deepEqual(saved.model, { connected: true, status: 'automatic', reason: null });
  const view = trust.view('tonborg', 'knowledge_review');
  assert.equal(view.suggestionsOnly, false);
  assert.equal(view.warningSeen, true);

  // Off any time: the scheduler stops unless a policy runs it, and nothing Tonborg did is lost.
  const off = await setReviewDelegation({ judgment: f.service, modelTrust: trust,
    input: { personalSpaceId: 's', enabled: false, expectedRevision: saved.revision } });
  assert.equal(off.enabled, false);
  assert.equal(f.service.store().hasAutomaticPolicy('s'), false);
});

test('turning delegation on makes the scheduler run even when every policy is 「我来确认」', async t => {
  const f = fixture(t);
  assert.equal(f.service.store().hasAutomaticPolicy('s'), false);
  await turnOn(f);
  assert.equal(f.service.store().hasAutomaticPolicy('s'), true);
  const result = await f.service.reviewAutomatic({ personalSpaceId: 's', requestId: 'scheduled-1', limit: 10 });
  assert.ok(result.records.some(record => record.delegated && record.execution.status === 'applied'));
});

test('the person undoes a Tonborg confirmation with its review receipt, and it leaves the list', async t => {
  const f = fixture(t);
  await turnOn(f);
  await f.service.review(input);
  const [confirmed] = (await delegatedReviewList({ judgment: f.service, input: { personalSpaceId: 's' } })).confirmed;
  const sent = [];
  const undoConsole = { withdrawAiReview: async body => { sent.push(body); return { decision_id: 'provider-decision' }; } };
  const undone = await undoAutomaticReview({ judgment: f.service, undoConsole, input: { personalSpaceId: 's', decisionId: confirmed.id } });
  assert.equal(undone.execution.status, 'undone');
  // The Provider takes back the marks and Tonborg's agent confirmation together (graph-provider tonborg_confirmation.py).
  assert.deepEqual(sent.map(body => [body.review_id, body.candidate_key]), [['review', 'entity:keep']]);
  assert.deepEqual((await delegatedReviewList({ judgment: f.service, input: { personalSpaceId: 's' } })).confirmed, []);
});
