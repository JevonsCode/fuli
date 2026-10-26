import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { tonborgReviewSuggestions } from '../src/judgment/review-suggestions.js';
import { createJudgmentService } from '../src/judgment/service.js';
import { JudgmentStore } from '../src/judgment/store.js';
import { knowledgeReferences } from '../src/knowledge-hard-delete/forget-references.js';
import { reachableModules } from '../test-support/module-graph.js';

// rec#8: the console lists the knowledge review verdicts Tonborg left to the
// person (ai_suggested) beside Astro's, Bole's and Jefa's suggestions. It is
// an owner read: its route answers only the local console with its confirmed
// human-review proof (test/judgment-console-owner.test.js). Synthetic
// judgment records only.

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const app = { config: { personal: { spaceId: 's' } }, listPersonalProjects: async () => [{ project_id: 'p' }] };
const gate = (reason = 'not_configured') => ({ status: 'not_passed', reason, modelId: null });
const review = (target, aiReview, extra = {}) => ({ personalProjectId: 'p', kind: 'review', target, title: `Item ${target}`,
  summary: `Tonborg on ${target}`, evidence: [`evidence for ${target}`], confidence: 0.6, outcome: 'escalate', aiReview,
  model: 'qwen-test', client: null, judgedBy: { mode: 'model_api', independent: true }, ...extra });
const suggested = (outcome = 'approve', interceptions = ['gate_not_passed']) =>
  ({ state: 'ai_suggested', modelOutcome: outcome, interceptions, gate: gate() });

function service(t, options = {}) {
  const judgment = createJudgmentService({ app, ...options });
  t.after(() => judgment.close());
  return judgment;
}

test('only the verdicts left to the person, newest first, an older one for the same item as newer', async t => {
  const judgment = service(t);
  const store = judgment.store();
  store.record('s', review('entity:a', suggested()), 'r1:entity:a');
  store.record('s', review('entity:b', { ...suggested(), state: 'ai_reviewed', interceptions: [], gate: { status: 'passed', reason: null, modelId: 'qwen-test' } }), 'r1:entity:b');
  // Before rec#10 D-24 a review had no aiReview; routing and acceptance are not knowledge reviews.
  store.record('s', review('entity:c', undefined), 'r1:entity:c');
  store.record('s', { personalProjectId: 'p', kind: 'routing', target: 'task-1', outcome: 'recommend', summary: 'Route', evidence: [],
    aiReview: suggested() }, 'routing-1');
  store.record('s', review('entity:a', suggested('escalate', []), { summary: 'Newer look' }), 'r2:entity:a');
  store.record('s', review('relationship:d', suggested('approve', ['below_confidence', 'gate_not_passed']),
    { personalProjectId: null, model: null, client: 'claude_code', judgedBy: { mode: 'current_session', independent: false } }), 'r2:relationship:d');

  const listed = await tonborgReviewSuggestions({ judgment, input: { personalSpaceId: 's' } });
  assert.deepEqual(listed.map(entry => [entry.target, entry.personalProjectId, entry.stale ?? null]),
    [['relationship:d', null, null], ['entity:a', 'p', null], ['entity:a', 'p', 'newer']]);
  assert.deepEqual(Object.keys(listed[1]).sort(), ['aiReview', 'client', 'confidence', 'createdAt', 'id', 'judgedBy', 'model',
    'personalProjectId', 'personalSpaceId', 'summary', 'target', 'title']);
  assert.equal(listed[1].summary, 'Newer look');
  assert.deepEqual(listed[0].aiReview.interceptions, ['below_confidence', 'gate_not_passed']);
  assert.deepEqual(listed[0].judgedBy, { mode: 'current_session', independent: false });
  // The same item in another project is another subject.
  store.record('s', review('entity:a', suggested(), { personalProjectId: null }), 'r3:entity:a');
  const again = await tonborgReviewSuggestions({ judgment, input: { personalSpaceId: 's' } });
  assert.deepEqual(again.slice(0, 3).map(entry => entry.stale ?? null), [null, null, null]);
});

test('a permanently deleted item keeps its place without any of its words', async t => {
  const judgment = service(t);
  judgment.store().record('s', review('entity:gone', suggested()), 'r1:entity:gone');
  judgment.store().forgetKnowledgeItems('s', knowledgeReferences({ candidateKeys: ['entity:gone'] }));
  const [entry] = await tonborgReviewSuggestions({ judgment, input: { personalSpaceId: 's' } });
  assert.equal(entry.hard_deleted, true);
  assert.equal(entry.title, null);
  assert.equal(entry.summary, null);
  assert.equal(JSON.stringify(entry).includes('Tonborg on'), false);
});

test('reads only the active space, and waits while a permanent delete is not confirmed', async t => {
  const judgment = service(t);
  await assert.rejects(tonborgReviewSuggestions({ judgment, input: { personalSpaceId: 'other' } }), { status: 403, code: 'scope_mismatch' });
  await assert.rejects(tonborgReviewSuggestions({ judgment, input: { personalSpaceId: 's', personalProjectId: 'p' } }), TypeError);
  await assert.rejects(tonborgReviewSuggestions({ judgment, input: {} }), TypeError);

  const dir = mkdtempSync(join(tmpdir(), 'fuli-tonborg-suggestions-'));
  let state = 'open';
  const fenced = service(t, { openStore: () => new JudgmentStore(join(dir, 'judgment.sqlite'), { recoveryGate: { state: () => ({ state }) } }) });
  // After hooks run in order: the store closes before its directory goes.
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  fenced.store().record('s', review('entity:a', suggested()), 'r1:entity:a');
  state = 'pending';
  await assert.rejects(tonborgReviewSuggestions({ judgment: fenced, input: { personalSpaceId: 's' } }), { code: 'knowledge_recovery_pending' });
});

test('no Agent tool or MCP entry reaches the list', () => {
  const module = join(ROOT, 'src/judgment/review-suggestions.js');
  for (const entry of ['src/mcp-server.js', 'src/agent-tools.js', 'src/mcp/create-mcp-server.js']) {
    assert.equal(reachableModules(join(ROOT, entry)).has(module), false, entry);
  }
});
